# Chunky CLI — walking skeleton

A Claude-Code-look terminal agent whose harness is a headless server, so the same
core can drive a CLI/TUI today and an app later. The server supports OpenAI-compatible
models plus subscription-backed Codex, Grok, and Anthropic Agent SDK runtimes.

```
TUI (Ink) ──SSE──▶ server (Bun) ──▶ LangChain agent ──▶ Zen / Codex / Grok
                         │
                         └────────▶ Anthropic Agent SDK ──▶ Claude subscription OAuth
```

## Packages
- `packages/protocol` — shared wire contract: `AgentEvent`, REST `ROUTES`, `sse()`/`readSSE()`. The frozen source of truth.
- `packages/server` — `Bun.serve` HTTP + SSE. Runs the lean LangChain loop for OpenAI-compatible providers or the native Anthropic Agent SDK loop for Claude, translating both into the same `AgentEvent` stream and using the same Chunky tools.
- `packages/tui` — Ink client styled exactly like Claude Code (theme/components lifted from `kimi-2-6-code-main`): terracotta rounded input box, `✻` banner, streaming text, `⏺` tool lines, spinner/status line, `/` slash menu. Reduces the `AgentEvent` stream into a live transcript.

## Run
Requires Bun. Zen config is in `.env` (gitignored): `ZEN_BASE_URL`, `ZEN_MODEL`, `ZEN_API_KEY`, `CHUNKY_PORT`.
For Anthropic subscription OAuth, authenticate the real Claude CLI once with `claude auth login --claudeai`; Chunky reuses that OAuth session through `@anthropic-ai/claude-agent-sdk`.

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
- ✅ **Native Anthropic Agent SDK + OAuth**: the `anthropic` provider uses the real SDK agent loop and Claude subscription OAuth, disables every Claude built-in tool and filesystem setting, injects Chunky's `read`/`bash`/`write`/`edit`/`spawn_thread` tools through an in-process MCP server, uses Chunky's lean system prompt verbatim, streams into the existing protocol, and resumes SDK sessions by Chunky thread id.
- ✅ **Durable agent memory across restart**: a `bun:sqlite` LangGraph checkpointer (`bun-sqlite-saver.ts`, ported from the official better-sqlite3 saver which Bun can't load). Verified: teach the agent a fact, restart the server, ask in the same session — it remembers. Each thread_id keeps its own checkpoint.
- ✅ **Real coding tools**: the lean `read`/`bash`/`write`/`edit` tools operate directly in `WORKSPACE` (`CHUNKY_WORKSPACE || cwd`), with file paths jailed to that root. GPT/Codex models instead receive **`apply_patch`** (OpenAI V4A format, path-escape-guarded, all-or-nothing); Anthropic receives the same Chunky implementations through in-process MCP wrappers.
- ⚠️ **Known bug — Claude-family models via Zen error on tool calls.** `claude-*` on the Zen gateway throws `Invalid response from "wrapModelCall"` on any tool call (Zen's SSE sends empty `id`/`model` on chunks after the first, breaking LangChain's chunk aggregation; reproduces via raw curl, so it's upstream/Zen-side). Since the agent always has tools, use `glm-5.2` (or Codex) for tool work until this is worked around. Non-tool chat with Claude-on-Zen is unaffected.
- ⬜ Concurrent (not just sequential) thread spawns; interrupt/steer mid-run; tool-approval (HITL); packaging to a binary; work around the Zen/Claude tool-call bug (patch the SSE stream, or use the native Anthropic provider).
