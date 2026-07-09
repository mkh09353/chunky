# MultiCode CLI — walking skeleton

A Claude-Code-look terminal agent whose harness is a headless server, so the same
core can drive a CLI/TUI today and an app later. This v0 proves the full pipe end to end
with **one** provider (Zen / GLM-5.2, OpenAI-compatible — no OAuth yet).

```
TUI (Ink, Claude Code look)  ──SSE──▶  server (Bun)  ──▶  DeepAgents / LangGraph  ──▶  Zen ▶ GLM-5.2
        ▲                                                                                     │
        └──────────────────────────── AgentEvent stream ◀────────────────────────────────────┘
```

## Packages
- `packages/protocol` — shared wire contract: `AgentEvent`, REST `ROUTES`, `sse()`/`readSSE()`. The frozen source of truth.
- `packages/server` — `Bun.serve` HTTP + SSE. Runs a DeepAgents agent (`createDeepAgent`) whose model is a `ChatOpenAI` pointed at Zen. LangGraph `MemorySaver` threads each session; one `list_dir` tool. Translates the LangGraph stream into `AgentEvent`s.
- `packages/tui` — Ink client styled exactly like Claude Code (theme/components lifted from `kimi-2-6-code-main`): terracotta rounded input box, `✻` banner, streaming text, `⏺` tool lines, spinner/status line, `/` slash menu. Reduces the `AgentEvent` stream into a live transcript.

## Run
Requires Bun. Provider config is in `.env` (gitignored): `ZEN_BASE_URL`, `ZEN_MODEL`, `ZEN_API_KEY`, `MC_PORT`.

```bash
bun install

# Terminal 1 — start the harness
bun run server            # listens on http://localhost:4599

# Terminal 2 — the TUI (must be a real interactive terminal)
bun run tui -- --live     # connects to the server, streams real GLM-5.2
# or, with no server:
bun run tui -- --mock     # demo the UI against a fake stream
```

Verified: typing a question in `--live` streams the real GLM-5.2 answer back into the Claude-Code UI.

## Status / next
- ✅ End-to-end pipe (TUI → SSE → DeepAgents → Zen → GLM-5.2) working.
- ⬜ Real nested threads (protocol already carries `thread.*`; server emits flat events for now).
- ⬜ More providers via OAuth (Codex/Grok flows lift from `~/Downloads/opencode`); Claude via Agent SDK.
- ⬜ Multi-thread TUI view (the genuinely novel UI: a tree of concurrent live threads).
