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
- ✅ **Live model catalog + picker** (`/model`): a fuzzy-searchable list of every provider's models — Zen's live `/v1/models` plus curated Codex/Grok sets, enriched with models.dev metadata. `/model add|hide|restore <provider> <model-id>` changes the global catalog immediately; `/model list <provider>` shows its overrides. Hidden models leave existing sessions untouched, custom ids persist across restarts, and the agent can make the same explicit changes through `manage_models`. Reasoning models get low/medium/high/xhigh/max effort; Codex adds standard/fast speed.
- ✅ **Real nested threads**: `spawn_thread` launches a full independent child agent run on its own LangGraph `thread_id`, streaming events tagged with the child's `threadId` over the session SSE; children can spawn children. The TUI renders the tree (run `--threads`, ctrl+t to expand/collapse).
- ✅ **Native Anthropic Agent SDK + OAuth**: the `anthropic` provider uses the real SDK agent loop and Claude subscription OAuth, disables every Claude built-in tool and filesystem setting, injects Chunky's `read`/`bash`/`write`/`edit`/`spawn_thread` tools through an in-process MCP server, uses Chunky's lean system prompt verbatim, streams into the existing protocol, and resumes SDK sessions by Chunky thread id.
- ✅ **Durable agent memory across restart**: a `bun:sqlite` LangGraph checkpointer (`bun-sqlite-saver.ts`, ported from the official better-sqlite3 saver which Bun can't load). Verified: teach the agent a fact, restart the server, ask in the same session — it remembers. Each thread_id keeps its own checkpoint.
- ✅ **Real coding tools**: the lean `read`/`bash`/`write`/`edit` tools operate directly in `WORKSPACE` (`CHUNKY_WORKSPACE || cwd`), with file paths jailed to that root. GPT/Codex models instead receive **`apply_patch`** (OpenAI V4A format, path-escape-guarded, all-or-nothing); Anthropic receives the same Chunky implementations through in-process MCP wrappers.
- ✅ **Goal mode** (`/goal`): set an objective and the agent works toward it autonomously — after each turn that ends *without* the goal being declared done, the server injects a hidden continuation nudge and runs another turn, until the model calls **`goal_complete`** (with an evidence summary) or **`goal_blocked`** (a genuine impasse), or a turn budget (default 20, `/goal --turns N …` or `CHUNKY_GOAL_MAX_TURNS`) is hit. Goal state is persisted per-session in sqlite (survives restart/resume) and streams `goal.update` lifecycle markers into the transcript + a `goal:` segment on the status line. `/goal` shows status, `/goal pause|resume|clear` manage it; Esc pauses an active goal so it never silently resumes. Works on both the LangChain and native Anthropic-SDK runtimes (the three goal tools resolve the root session from any thread depth). `GET/POST /api/sessions/:id/goal`. Ported in spirit from `pi-codex-goal` / `pi-goal`.
- ✅ **Workflows-mode goals** (`/goal --workflows <objective>`, alias `--dynamite`): the goal agent becomes an **orchestrator** — the kickoff/continuation prompts tell it to delegate ALL substantive work to dynamic-`workflow` runs (each sub-agent a real child thread), judge results between runs, and finish with a verification workflow before `goal_complete`. Workflow tiers anchor `small`/`medium` to the *global* active selection and route `big` to the advisor, so an orchestrator on a premium model fans out on the everyday model. Sessions can carry a **pinned model selection** (sqlite `sessions.selection`) that overrides the global `/model` choice for their runs. The `workflow` + `create_goal` tools are now also exposed on the native Anthropic-SDK runtime, so a Claude orchestrator can orchestrate.
- ✅ **Shipit** (`/shipit [notes]`): hand a long, context-heavy planning conversation off to a fresh executor. `POST /api/sessions/:id/ship` injects a hidden prompt telling the CURRENT session's model to distill everything agreed into a handoff brief (end state, decisions + why, constraints, pointers, verification checks) and call the new **`ship_goal`** tool — which creates a new session in the same repo, pins it to the orchestrator model (the advisor when configured, else the active selection), sets a workflows-mode goal with the brief as objective, and starts it through the session bus. The brief lands as the new session's first visible message (provenance-labelled `shipped from <session>`), so opening it reads like a briefed fresh thread; the dirty session stays behind as the archive.
- ✅ **Remote access via relay** (`bun run pair`): pair a phone with a QR code, and the server dials out to a hosted relay (`relay.chunky.to`, private sibling repo `../chunky-relay`) over an outbound WebSocket — no port forwarding, works from any network. All traffic is **end-to-end encrypted** (X25519 pairing via the QR, XSalsa20-Poly1305 per frame; the relay only ever routes ciphertext and account presence). The phone side speaks the existing `ROUTES`+SSE contract through a tunnel (`@chunky/protocol/relay-client` is the reference client); relay accounts support Sign in with Apple, GitHub OAuth, and a dev-mode login. Non-loopback HTTP now requires a bearer token (`serverToken` in settings.json) — direct LAN/Tailscale clients use that, the TUI/app on loopback need nothing. Design: `docs/relay-design.md`. Verified by a cross-repo E2E suite (pairing → encrypted fetch → streamed SSE → store-and-forward → relay-blindness byte check).
- ⚠️ **Known bug — Claude-family models via Zen error on tool calls.** `claude-*` on the Zen gateway throws `Invalid response from "wrapModelCall"` on any tool call (Zen's SSE sends empty `id`/`model` on chunks after the first, breaking LangChain's chunk aggregation; reproduces via raw curl, so it's upstream/Zen-side). Since the agent always has tools, use `glm-5.2` (or Codex) for tool work until this is worked around. Non-tool chat with Claude-on-Zen is unaffected.
- ⬜ Concurrent (not just sequential) thread spawns; interrupt/steer mid-run; tool-approval (HITL); packaging to a binary; work around the Zen/Claude tool-call bug (patch the SSE stream, or use the native Anthropic provider).
