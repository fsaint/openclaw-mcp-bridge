# How to Start the Agent Team

## Prerequisites

1. Claude Code CLI installed
2. Agent teams enabled (already configured in `.claude/settings.local.json`)

## Launch the Team

Open a terminal in this project directory and run:

```bash
cd /Users/fsaint/git/openclaw_httpmpc
claude
```

Then paste this prompt to create the team:

---

```
Create an agent team to build the MCP client plugin for OpenClaw.

Read CLAUDE.md and DEVELOPMENT_PLAN.md first for full context.

Spawn two teammates:

1. **dev** — Developer agent. Responsible for implementing all source code
   in src/ and skills/. Follows the task list in DEVELOPMENT_PLAN.md.
   Start with Phase 1 tasks in dependency order.
   Prompt: "You are the Developer agent. Read CLAUDE.md and DEVELOPMENT_PLAN.md.
   Your job is to implement source code in src/ and skills/. You MUST NOT write
   test files. Follow the Phase 1 task dependency graph. Start with Task 1.1
   (project scaffold — config-schema.ts, types, jsonrpc utils), then Task 1.2,
   then 1.4, 1.6, 1.8, 1.10, 1.11, 1.13, 1.14, 1.15 in order. After completing
   each task, message the qa teammate to tell them the code is ready. Reference
   SPEC.md for all protocol decisions. Use Sonnet model for speed."

2. **qa** — QA agent. Responsible for all test files in test/ and test fixtures.
   Reviews dev's code for bugs and spec compliance.
   Prompt: "You are the QA agent. Read CLAUDE.md and DEVELOPMENT_PLAN.md.
   Your job is to write tests in test/ and test fixtures in test/fixtures/.
   You MUST NOT write source code in src/. Start with Task 1.3 (mock MCP server),
   then wait for dev to complete components before writing their tests.
   Follow the Phase 1 task dependency graph: 1.3, then 1.5, 1.7, 1.9, 1.12, 1.16
   in order. After writing tests, run 'npm test' to verify they pass. If tests
   fail due to implementation bugs, message dev with specific file:line references.
   Reference SPEC.md for expected protocol behavior. Use Sonnet model for speed."

Require plan approval for both teammates before they start implementing.
Use delegate mode — do NOT implement code yourself, only coordinate.

After Phase 1 is complete, proceed to Phase 2 tasks in the same pattern.
```

---

## Display Mode Options

### In-process (default)
All teammates run in your terminal. Use `Shift+Up/Down` to switch between them.

### Split panes (requires tmux)
```bash
claude --teammate-mode tmux
```
Each teammate gets its own pane so you can see all output simultaneously.

## During Development

- Press `Shift+Up/Down` to select a teammate and message them directly
- Press `Ctrl+T` to toggle the shared task list
- Press `Shift+Tab` to toggle delegate mode on the lead
- Type messages to the lead to adjust priorities or redirect work

## Key Commands

| Action | How |
|--------|-----|
| View teammate output | `Shift+Up/Down` then `Enter` |
| Interrupt a teammate | `Escape` while viewing their session |
| Message a teammate | `Shift+Up/Down` to select, then type |
| Toggle task list | `Ctrl+T` |
| Toggle delegate mode | `Shift+Tab` |
| Clean up team | Tell the lead: "Clean up the team" |
