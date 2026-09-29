# TRShell Hybrid Mode in AiderDesk

## What This Is

A fork of [hotovo/aider-desk](https://github.com/hotovo/aider-desk) v0.86.0 with an optional **Hybrid agent mode** that adds a Planner → Executor → Debugger → Critic orchestration layer on top of the existing agent loop. The default **Agent** mode is unchanged.

## Architecture Map

### Where a user message starts the agent loop
```
src/main/task/task.ts:1229 — Task.startTask() calls Agent.runAgent()
src/main/agent/agent.ts:539 — Agent.runAgent() → while(true) loop
```
The loop exits when `finishReason !== 'tool-calls'` (the model stopped calling tools = task done).

### How tools are registered and approved
```
src/main/agent/tools/ — built-in tools (bash, edit, read, glob, grep, etc.)
src/main/agent/mcp-manager.ts — MCP server tools
Vercel AI SDK toolSet passed to streamText()/generateText()
Tool approvals via task.toolApprovals + agent profile settings
```

### How streaming reaches the renderer
```
src/main/agent/agent.ts:streamText() → chunk processing loop
  chunk.type === 'text-delta' → task.processResponseMessage()
  chunk.type === 'tool-result' → task.addToolMessage()
→ IPC "agent:ui-update" → renderer ChatStore.handleUiUpdate()
```

### How mode selection works
`Mode` is a string (`'agent'`, `'architect'`, `'code'`, `'ask'`, etc.). In Hybrid mode, the `AgentProfile.hybridMode` boolean flag activates the hybrid orchestration layer.

---

## Hybrid Mode Implementation

### What happens when Hybrid mode is enabled

1. **Planner pass**: `buildPlannerSystemPrompt()` is appended to the system prompt. The model produces a 3-8 step plan with concrete actions and observable results, then immediately begins executing Step 1.

2. **Executor loop**: The existing AiderDesk agent loop runs unchanged — same tools, same streaming, same approvals.

3. **Thrash detection**: After each tool call, `checkHybridState()` records the tool name + args hash. If the same tool with the same arguments is called 3+ times within 2 minutes → hard stop with "Thrash detected" message.

4. **Debugger injection**: On tool failure (output matches error patterns), a debugger prompt is injected as a user message: "Tool X failed. State why, state what you'll do differently, do NOT repeat the same command unchanged." Max 2 debugger injections per consecutive failure chain.

5. **Critic prompt**: The system prompt includes evaluation criteria — the model self-checks completion before stopping.

### What's NOT implemented (by design)
- TRShell's 16-node LangGraph topology — AiderDesk's single loop + extensions is simpler
- TRShell's IntuitionEngine / experience store / strategy stagnation — Phase 2 scope
- TRShell's stepProgress / checkpoint files — AiderDesk has its own TODO panel
- TRShell's subagent delegation contracts — AiderDesk has its own subagent system
- TRShell's budget pressure advisory — AiderDesk has maxIterations already

### Stop conditions (Hybrid mode)

**Hard stops:**
- Model stops calling tools (finishReason !== 'tool-calls') — stock behavior
- maxIterations reached (profile setting, default 100 for hybrid)
- Same tool + same args called 3 times in 2 minutes (thrash)
- User cancels (abortSignal)
- Unrecoverable infrastructure error

**NO hard stops on:**
- Progress slope declining
- Fuzzy goal proximity %
- Internal progress scores

If exploration is slow but tools return NEW artifacts → continue.

---

## How to Enable Hybrid Mode

In the Agent Profile settings, toggle the `hybridMode` flag. The default is `false` (stock Agent mode).

Settings → Agents → [Profile] → General → Hybrid Mode toggle.

---

## Build the .deb

```bash
cd aiderdesk-hybrid  # or wherever you cloned this repo
npm install --legacy-peer-deps --ignore-scripts
cd node_modules/electron && NODE_OPTIONS="--experimental-require-module" node install.js && cd ../..
npx patch-package
npm run build:extensions
npx electron-vite build
NODE_OPTIONS="--experimental-require-module" npx electron-builder --linux deb --publish never
```

Output: `dist/aider-desk_0.86.0-hybrid.1_amd64.deb`

### Install:
```bash
sudo dpkg -i aider-desk_0.86.0-hybrid.1_amd64.deb
sudo apt-get install -f  # if needed for dependencies
```

The app installs as `aider-desk-hybrid` (appId: `com.local.aider-desk-hybrid`) — it sits **beside** the official AiderDesk, not on top of it.

---

## Settings

| Setting | Where | Default | Description |
|---|---|---|---|
| hybridMode | Agent Profile → General | false | Enable Hybrid orchestration |
| maxIterations | Agent Profile → General | varies | Max agent loop iterations |
| thrashThreshold | Hardcoded | 3 | Identical tool+args calls before stop |
| debuggerMaxRuns | Hardcoded | 2 | Max consecutive debugger injections |

---

## Verification

**V1. Stock Agent mode**: Agent mode = stock behavior. No hybrid prompts, no thrash detection. Regression-safe.

**V2. Hybrid multi-step**: With hybridMode=true, the planner prompt injects a structured plan before execution. Multiple tool rounds without false partial completion.

**V3. Thrash**: Same command ×3 → "Thrash detected: same tool called 3 times" → hard stop.

**V4. Budget**: maxIterations reached → existing AiderDesk warning message. Honest remaining work reported.

**V5. Settings persist**: hybridMode stored in AgentProfile → persisted in SQLite via AiderDesk's existing settings system.

**V6. .deb**: installs as `aider-desk-hybrid`, sits beside official AiderDesk, Hybrid mode selectable from profile settings.
