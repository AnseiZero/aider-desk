/**
 * Hybrid Agent Runner — Planner → Executor → Debugger → Critic loop
 *
 * Wraps AiderDesk's existing agent loop with an optional orchestration layer.
 * Does NOT replace the loop — it adds pre-loop planning, in-loop thrash
 * detection + debugger injection, and post-loop critic evaluation.
 *
 * Stop conditions (hard):
 *   - Model stops calling tools (finishReason !== 'tool-calls')
 *   - maxIterations reached (existing AiderDesk guard)
 *   - Same tool + same args repeated N times (thrash, default 3)
 *   - User cancel (abortSignal)
 *
 * NO progress-slope kills. If tools return new artifacts, continue.
 */

// ── Thrash detection ────────────────────────────────────────────────────

interface ToolCallSignature {
  tool: string;
  argsHash: string;
  timestamp: number;
}

const THRASH_THRESHOLD = 3;
const SIGNATURE_WINDOW_MS = 120_000; // 2 minutes

export class ThrashDetector {
  private recentFailures: ToolCallSignature[] = [];

  recordToolCall(tool: string, args: Record<string, unknown>): { isThrashing: boolean; count: number } {
    const argsHash = hashArgs(args);
    this.recentFailures.push({ tool, argsHash, timestamp: Date.now() });

    // Prune old entries
    const cutoff = Date.now() - SIGNATURE_WINDOW_MS;
    this.recentFailures = this.recentFailures.filter((f) => f.timestamp > cutoff);

    // Count identical signatures
    const count = this.recentFailures.filter(
      (f) => f.tool === tool && f.argsHash === argsHash,
    ).length;

    return { isThrashing: count >= THRASH_THRESHOLD, count };
  }

  reset(): void {
    this.recentFailures = [];
  }
}

function hashArgs(args: Record<string, unknown>): string {
  try {
    return Buffer.from(JSON.stringify(args)).toString('base64').substring(0, 40);
  } catch {
    return 'unknown';
  }
}

// ── Planner pass ────────────────────────────────────────────────────────

export function buildPlannerSystemPrompt(userMessage: string): string {
  return [
    '# HYBRID PLANNER PASS',
    '',
    'Before executing the task, produce a concise step-by-step plan.',
    '',
    '## Plan Quality Requirements:',
    '- Each step should name a concrete action + expected observable result.',
    '- Avoid pure "understand/analyze X" without specifying what artifact the step produces.',
    '- Steps should be task-specific, not generic templates.',
    '- Prefer decisive experiments (run, test, measure) over unbounded theorizing.',
    '- Plan should be 3-8 steps maximum. Do NOT produce a mega-plan.',
    '',
    'After the plan, IMMEDIATELY begin executing Step 1. Do not stop to ask for approval.',
    '',
    '## Output format:',
    '```',
    'PLAN:',
    '1. [action] → [expected result]',
    '2. [action] → [expected result]',
    '...',
    '',
    'EXECUTING Step 1:',
    '```',
    '',
    `Task: ${userMessage}`,
  ].join('\n');
}

// ── Debugger injection ──────────────────────────────────────────────────

export function buildDebuggerPrompt(tool: string, error: string, previousAttempts: number): string {
  return [
    '',
    '# TOOL FAILURE — DEBUGGER PASS',
    '',
    `Tool "${tool}" just failed. This is attempt ${previousAttempts}.`,
    `Error: ${error}`,
    '',
    'Before retrying, you MUST:',
    '1. State WHY this command failed (be specific).',
    '2. State what you will do DIFFERENTLY this time.',
    '3. If the same command would produce the same error, change your approach entirely.',
    '',
    'Do NOT repeat the same command unchanged. Modify the arguments, use a different tool,',
    'or fix the prerequisite that caused the failure.',
  ].join('\n');
}

// ── Critic pass ─────────────────────────────────────────────────────────

export function buildCriticPrompt(): string {
  return [
    '',
    '# CRITIC — FINAL EVALUATION',
    '',
    'The agent has stopped calling tools. Before reporting completion:',
    '',
    '1. Does the result actually address the user request?',
    '2. Is there evidence (tool output, file content, verified state) supporting completion?',
    '3. Are there any remaining steps from the plan that were not executed?',
    '',
    'If YES: provide a concise summary of what was accomplished.',
    'If NO: state what is missing and either continue working (call tools) or',
    'explain why you cannot proceed further.',
    '',
    'Do NOT claim completion without evidence. Do NOT mark remaining steps as done.',
  ].join('\n');
}

// ── Thrash / debugger state ─────────────────────────────────────────────

export interface HybridLoopState {
  thrashDetector: ThrashDetector;
  lastToolName: string | null;
  lastToolArgsHash: string | null;
  consecutiveFailures: number;
  debuggerInjectedFor: string | null;
}

export function createHybridLoopState(): HybridLoopState {
  return {
    thrashDetector: new ThrashDetector(),
    lastToolName: null,
    lastToolArgsHash: null,
    consecutiveFailures: 0,
    debuggerInjectedFor: null,
  };
}

// ── Hook: onAgentStepFinished extension point ───────────────────────────

/**
 * Called after each agent step (tool call or text response).
 * Returns an optional debug prompt to inject into the next model call.
 */
export function checkHybridState(
  state: HybridLoopState,
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolError: string | null,
): { shouldStop: boolean; stopReason?: string; debugPrompt?: string } {
  // Thrash detection
  const thrash = state.thrashDetector.recordToolCall(toolName, toolArgs);
  if (thrash.isThrashing) {
    return {
      shouldStop: true,
      stopReason: `Thrash detected: same tool "${toolName}" called ${thrash.count} times with same arguments. The agent is stuck in a loop — stop and ask the user for direction.`,
    };
  }

  // Debugger on tool failure
  if (toolError) {
    state.consecutiveFailures++;
    if (state.consecutiveFailures <= 2) {
      return {
        shouldStop: false,
        debugPrompt: buildDebuggerPrompt(toolName, toolError, state.consecutiveFailures),
      };
    }
    // 3+ consecutive failures: don't inject more debugger prompts —
    // let the model try a different approach naturally. If it thrashes,
    // the thrash detector will stop it.
    return { shouldStop: false };
  }

  // Success: reset failure counter
  state.consecutiveFailures = 0;
  state.debuggerInjectedFor = null;

  return { shouldStop: false };
}

// ── AgentProfile extension ──────────────────────────────────────────────

type AnyProfile = { hybridMode?: boolean; maxIterations?: number };

export function isHybridMode(profile: AnyProfile): boolean {
  return profile.hybridMode === true;
}

export function getHybridMaxIterations(profile: AnyProfile): number {
  return (profile.maxIterations ?? 0) > 0 ? profile.maxIterations! : 100;
}
