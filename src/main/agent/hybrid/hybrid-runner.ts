/**
 * Hybrid Agent Runner — Planner pass + LLM-as-judge progress checks.
 *
 * When hybridMode is enabled on an agent profile:
 * - A structured planner prompt is appended to the system prompt
 *   (model produces a 3-8 step plan, then immediately begins Step 1)
 * - Critic evaluation criteria + budget awareness are in the system prompt
 * - Rules and custom instructions load normally (before the planner)
 * - Human escalation points are defined in the system prompt
 * - Every N tool-call rounds, a lightweight LLM-as-judge progress check
 *   asks "is meaningful progress happening?" — replaces code-based
 *   thrash/stagnation detection (which false-positived on legitimate work)
 * - Every step is logged to a structured JSONL trace for post-run analysis
 *
 * NO code-based detection: no regex pattern matching, no output hashing,
 * no scoring. Progress judgment is semantic — only the model can do it.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Planner pass ────────────────────────────────────────────────────────

export function buildPlannerSystemPrompt(userMessage: string): string {
  return [
    '# HYBRID PLANNER PASS',
    '',
    'IMPORTANT: If the <Rules> section above defines a specific pipeline,',
    'dispatch protocol, or standing instructions, THOSE RULES TAKE PRIORITY.',
    'Use them to shape your plan — do not substitute this generic template',
    'for specific instructions. If the rules say "dispatch X" or "follow pipeline Y",',
    'do that instead of producing a generic plan.',
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
    'After producing the plan, call todo_set_items with the steps so progress',
    'is tracked in the UI. Mark each step completed via todo_update_item_completion',
    'as you finish it.',
    '',
    'After the plan, IMMEDIATELY begin executing Step 1 (or dispatch per rules).',
    'Do not stop to ask for approval.',
    '',
    '## Completion Verification:',
    'Before claiming any task is complete:',
    '1. Does the result actually address the user request?',
    '2. Is there evidence (tool output, file content, verified state) supporting completion?',
    '3. Are there any remaining steps from the plan (check todo_get_items) that were not executed?',
    '',
    'If YES: provide a concise summary of what was accomplished.',
    'If NO: state what is missing and either continue working (call tools) or',
    'explain why you cannot proceed further.',
    'Do NOT claim completion without evidence. Do NOT mark remaining steps as done.',
    '',
    '## Human Escalation Points (ALWAYS stop and ask the user):',
    '- Irreversible file operations: rm -rf, force push, deleting important files',
    '- Anything touching production or external services (deploying, sending emails, modifying shared resources)',
    '- Scope changes: the task is drifting beyond what the user originally asked for',
    '- Credential/secret handling: using or modifying passwords, API keys, tokens',
    '- You are uncertain whether an action is safe or authorized',
    '',
    '## Task:',
    userMessage,
  ].join('\n');
}

// ── LLM-as-judge progress check ────────────────────────────────────────

const PROGRESS_CHECK_INTERVAL = 5; // every N tool-call rounds

/**
 * Build a lightweight progress-check prompt injected every N rounds.
 * The model (same executor model, no separate call) self-evaluates:
 * "has meaningful progress happened?" — semantic judgment, not regex.
 */
export function buildProgressCheckPrompt(
  recentSteps: Array<{ tool: string; summary: string }>,
  currentIteration: number,
  maxIterations: number,
): string | null {
  if (recentSteps.length < PROGRESS_CHECK_INTERVAL) return null;

  const stepSummary = recentSteps
    .slice(-PROGRESS_CHECK_INTERVAL)
    .map((s, i) => `${i + 1}. ${s.tool}: ${s.summary.slice(0, 100)}`)
    .join('\n');

  return [
    '# PROGRESS CHECK (internal — do not show to user)',
    '',
    `You are at iteration ${currentIteration} of ${maxIterations}.`,
    `Recent steps:`,
    stepSummary,
    '',
    'Evaluate: has meaningful progress happened in these steps?',
    '- "real": new information was discovered, artifacts were created, or the task advanced.',
    '- "stalled": the same ground was covered, outputs were similar, or you are repeating yourself.',
    '',
    'If stalled, state what you will do differently (new tool, new target, new method).',
    'If real, continue with the next step.',
    '',
    'This check is advisory — use it to steer, not to stop. If genuinely stalled after',
    'multiple stalled checks, consider stopping and asking the user for direction.',
  ].join('\n');
}

// ── Budget in context ───────────────────────────────────────────────────

/**
 * Compact budget line for the executor context — put it in the prompt,
 * let the model/Critic reason about it. No enforcement code.
 */
export function buildBudgetLine(currentIteration: number, maxIterations: number): string | null {
  if (maxIterations <= 0) return null;
  const usage = Math.round((currentIteration / maxIterations) * 100);
  if (usage < 50) return null;
  return `Budget: ${currentIteration}/${maxIterations} steps used (${usage}%). ${maxIterations - currentIteration} remaining. Factor this into continue/stop decisions.`;
}

// ── Trace logging ───────────────────────────────────────────────────────

export interface TraceEntry {
  timestamp: number;
  iteration: number;
  tool: string;
  argsSummary: string;
  outputSummary: string;
  isError: boolean;
  modelReasoning?: string;
}

export class TraceLogger {
  private entries: TraceEntry[] = [];
  private filePath: string | null = null;

  start(sessionId: string, taskDir?: string): void {
    try {
      const dir = taskDir || path.join(process.env.HOME || '~', '.config', 'aider-desk', 'traces');
      fs.mkdirSync(dir, { recursive: true });
      this.filePath = path.join(dir, `trace-${sessionId}-${Date.now()}.jsonl`);
    } catch {
      this.filePath = null;
    }
  }

  log(entry: TraceEntry): void {
    this.entries.push(entry);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
      } catch {
        // best-effort
      }
    }
  }

  getEntries(): TraceEntry[] {
    return [...this.entries];
  }

  getFilePath(): string | null {
    return this.filePath;
  }
}

// ── Experience as retrieval (plain storage, no scoring) ────────────────

export interface ExperienceEntry {
  timestamp: number;
  taskSummary: string;
  tool: string;
  approach: string;
  outcome: 'success' | 'failure' | 'partial';
  lesson: string;
}

export class ExperienceStore {
  private filePath: string | null = null;
  private entries: ExperienceEntry[] = [];

  constructor(taskDir?: string) {
    try {
      const dir = taskDir || path.join(process.env.HOME || '~', '.config', 'aider-desk', 'experience');
      fs.mkdirSync(dir, { recursive: true });
      this.filePath = path.join(dir, 'experience.jsonl');
      this.load();
    } catch {
      this.filePath = null;
    }
  }

  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
      this.entries = lines.map((line) => JSON.parse(line) as ExperienceEntry).slice(-100);
    } catch {
      this.entries = [];
    }
  }

  record(entry: Omit<ExperienceEntry, 'timestamp'>): void {
    const full: ExperienceEntry = { ...entry, timestamp: Date.now() };
    this.entries.push(full);
    // Bounded: keep last 100
    this.entries = this.entries.slice(-100);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, JSON.stringify(full) + '\n');
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Retrieve the k most similar past entries by keyword overlap with the task.
   * No scoring, no thresholds — just relevant precedent the model can use or ignore.
   */
  retrieve(taskDescription: string, k = 3): ExperienceEntry[] {
    if (this.entries.length === 0) return [];
    const taskWords = taskDescription.toLowerCase().split(/\W+/).filter(w => w.length >= 4);
    if (taskWords.length === 0) return [];

    const scored = this.entries.map((e) => {
      const entryText = `${e.taskSummary} ${e.approach} ${e.lesson}`.toLowerCase();
      const overlap = taskWords.filter((w) => entryText.includes(w)).length;
      return { entry: e, overlap };
    });

    return scored
      .filter((s) => s.overlap >= 2) // at least 2 keyword matches
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, k)
      .map((s) => s.entry);
  }

  /**
   * Format retrieved experiences as a context block for the executor.
   */
  formatAsContext(entries: ExperienceEntry[]): string | null {
    if (entries.length === 0) return null;
    const lines = entries.map((e) =>
      `- [${e.outcome}] Task: "${e.taskSummary.slice(0, 80)}" | Approach: ${e.approach.slice(0, 80)} | Lesson: ${e.lesson.slice(0, 100)}`,
    );
    return [
      '# Relevant Past Experience (advisory — use if helpful)',
      ...lines,
    ].join('\n');
  }
}

// ── AgentProfile extension ──────────────────────────────────────────────

type AnyProfile = { hybridMode?: boolean; maxIterations?: number };

export function isHybridMode(profile: AnyProfile): boolean {
  return profile.hybridMode === true;
}
