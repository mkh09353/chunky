# @chunky/app

Electrobun desktop UI for Chunky, built with [Astryx](https://astryx.atmeta.com)
(`AppShell` top nav + side nav) and wired to the existing headless harness.

```
┌──────────────────────────────────────────────────────────┐
│ Chunky   [repo tab]                          provider · model │  ← TopNav
├────────────┬─────────────────────────────────────────────┤
│ New thread │                                             │
│ ─────────  │           chat / empty state                │
│ session A  │                                             │
│ session B  │           ChatComposer                      │
│ …          │                                             │
└────────────┴─────────────────────────────────────────────┘
  SideNav                    ChatLayout
```

v1 is **single server / single workspace** (same as the TUI). Repo tabs are
ready in the shell; multi-workspace comes later.

## Run

Terminal 1 — harness (from monorepo root):

```bash
bun run server
```

Terminal 2 — desktop app:

```bash
bun install
bun run app:dev     # Vite HMR + Electrobun (recommended)
# or
bun run app         # build view once, then Electrobun
```

Env (optional):

| Var | Default | Meaning |
|---|---|---|
| `CHUNKY_URL` | `http://localhost:4599` | Harness base URL |
| `CHUNKY_PORT` | `4599` | Used if `CHUNKY_URL` unset |
| `CHUNKY_WORKSPACE` | cwd | Labelled in the UI (server still owns the real workspace) |
| `VITE_DEV_URL` | `http://localhost:5173` | HMR origin for Electrobun |

## Stack

- **Electrobun** — Bun main process + native window
- **React 19 + Vite** — renderer
- **Astryx** — `AppShell`, `TopNav`, `SideNav`, `ChatLayout`, `ChatComposer`, `ChatMessage*`, `ChatToolCalls`, `Markdown`, dark `theme-neutral`
- **`@chunky/protocol`** — same SSE/REST contract as the TUI

## Layout

```
packages/app/
  electrobun.config.ts
  vite.config.ts
  src/
    bun/index.ts          # BrowserWindow + chunky-config.json
    mainview/
      main.tsx            # Theme + App
      App.tsx             # AppShell composition + session wiring
      components/         # ChatPane, TranscriptView, EmptyChat
      lib/                # api client + transcript reducer
```
