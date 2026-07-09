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
- ✅ End-to-end pipe (TUI → SSE → DeepAgents → Zen → GLM-5.2).
- ✅ **Persistence + resume**: sqlite session/event store; reconnecting to a sessionId replays the transcript, survives a server restart. `GET /api/sessions` is the resume picker.
- ✅ **Provider registry + OAuth**: `zen` (API key) plus `grok`/`codex` OAuth providers (ported from opencode) with `auth.json` token storage and LangChain custom-fetch token injection. `/login` opens an arrow-navigable provider picker and **auto-opens the browser** (loopback PKCE flow, polls to confirm); `GET /api/providers`.
- ✅ **Model picker** (`/model`): a fuzzy-searchable list of each provider's models — Zen's ~48 (its live `/v1/models`) ∪ models.dev capability metadata, plus Codex/Grok sets. Reasoning models get an effort sub-picker (low/medium/high/xhigh); Codex adds speed (standard/fast). Selection (provider+model+effort+speed) persists to `settings.json` and rebuilds the agent (cache keyed by selection signature). `GET /api/providers/:id/models`, `GET/POST /api/model`.
- ✅ **Real nested threads**: `spawn_thread` launches a full independent child agent run on its own LangGraph `thread_id`, streaming events tagged with the child's `threadId` over the session SSE; children can spawn children. The TUI renders the tree (run `--threads`, ctrl+t to expand/collapse).
- ✅ **Durable agent memory across restart**: a `bun:sqlite` LangGraph checkpointer (`bun-sqlite-saver.ts`, ported from the official better-sqlite3 saver which Bun can't load). Verified: teach the agent a fact, restart the server, ask in the same session — it remembers. Each thread_id keeps its own checkpoint.
- ✅ **Real coding tools**: DeepAgents' file tools now run on a disk-backed `FilesystemBackend` rooted at `WORKSPACE` (`MC_WORKSPACE || cwd`), jailed to that root — so `write_file`/`edit_file` change real files (verified). GPT/Codex models additionally get an **`apply_patch`** tool (OpenAI V4A diff format, path-escape-guarded, all-or-nothing apply) selected by `editToolsForModel`; Claude/others use `edit_file`. Redundant `list_dir` removed.
- ⚠️ **Known bug — Claude-family models via Zen error on tool calls.** `claude-*` on the Zen gateway throws `Invalid response from "wrapModelCall"` on any tool call (Zen's SSE sends empty `id`/`model` on chunks after the first, breaking LangChain's chunk aggregation; reproduces via raw curl, so it's upstream/Zen-side). Since the agent always has tools, use `glm-5.2` (or Codex) for tool work until this is worked around. Non-tool chat with Claude-on-Zen is unaffected.
- ⬜ Concurrent (not just sequential) thread spawns; interrupt/steer mid-run; tool-approval (HITL); Claude via Agent SDK; packaging to a binary; work around the Zen/Claude tool-call bug (patch the SSE stream, or route Claude through a direct provider).
