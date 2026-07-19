---
name: terminal-control
description: Drive and verify terminal applications with the termctrl CLI or its MCP tools in a real PTY - read visible screens, run named live sessions, send typed keyboard input, wait for text, save evidence, record timelines, and export edited videos. Use when an agent must operate or test a TUI, REPL, interactive CLI, shell process, or full-screen terminal application.
---

# Terminal Control

Use `termctrl` to observe the actual visible terminal state and drive interaction deterministically.
Never guess what a terminal shows: capture it.

Invoke the CLI either through the workspace binary or with bun directly:

```bash
termctrl show -- my-terminal-app                       # installed bin
bun run packages/termctrl/src/cli.ts show -- my-terminal-app   # from the repo
```

The rest of this guide writes `termctrl`; substitute the `bun run …` form when the bin is not linked.

## 1. Start With The Smallest Workflow

Read a disposable application's settled visible screen when no further interaction is required:

```bash
termctrl show -- my-terminal-app
```

This starts the process, waits for it to settle, prints the screen, and tears everything down. Prefer
it whenever a single observation answers the question.

## 2. Use Named Sessions Only When Interaction Is Required

Keep an application alive when you must interact or inspect repeatedly:

```bash
termctrl start app -- my-terminal-app
termctrl wait app "Ready" --timeout 5000
termctrl show app
termctrl send app text:help enter
termctrl wait app "Commands" --timeout 5000
termctrl show app
termctrl stop app
```

## 3. Keep A Human-Visible Session When The User Is Watching

```bash
termctrl run -- nvim          # names the session from the executable basename
termctrl run editor -- nvim   # explicit name
```

`run` pipes the child straight to the current terminal pane. Pass an explicit name when running
multiple copies.

## 4. Choose The Correct Observation

- Use `show` for the current visible screen. Prefer it for reasoning about full-screen TUIs.
- Use `logs` for the retained output stream of normal-screen tools and log-like commands.
- Use `save --format … --out …` only when a persisted artifact is genuinely required.
- Use the video export only after deliberately recording a timeline with `--record`.

Do not treat `logs` as the visible state of an alternate-screen TUI: a full-screen application
repaints, so its log stream is full of escape sequences and stale frames.

## 5. Pick The Output Format Deliberately

```bash
termctrl show app                     # plain text (default)
termctrl show app --format json       # frame-v1 structured frame
termctrl show app --format ansi       # raw retained ANSI
```

Use `--format json` when you need per-cell colors or attributes rather than text.

## 6. Wait, Never Sleep

```bash
termctrl wait app "Ready" --timeout 5000
```

Always `wait` for observable text after sending input. Do not `sleep` and do not assume the interface
updated. `wait` fails fast with a clear message if the session exits or the timeout elapses, which is
a far better signal than a screenshot of a half-drawn screen.

Tune settling only when needed: `--settle-ms` is the quiet period required before capture and
`--deadline-ms` caps the wait.

## 7. Drive Input As Exact Atoms

Send plain text with `text:<value>` and named keys as separate atoms:

```bash
termctrl send app text:/connect enter
termctrl send app down down enter
termctrl send app ctrl-c
printf '%s' 'multiline prompt' | termctrl send app --stdin
```

CLI key atoms: `enter escape up down left right tab shift-tab backspace delete home end page-up page-down`,
plus `ctrl-<letter>`. Never bake a newline into `text:` — send `enter` as its own atom, so the
application receives a real carriage return rather than a literal `\n` character.

## 8. Resize When The Application Needs Room

```bash
termctrl resize app --cols 112 --rows 34
```

Many TUIs hide panes or truncate output at small sizes. Set the geometry at `start` (`--cols/--rows`)
when you already know the application's requirements.

## 9. Record, Mark, Then Export

Record only when the user wants a retained timeline or video. Add markers while the session runs,
inspect them after stopping, then export with an explicit edit plan:

```bash
termctrl start app --record artifacts/run.termctrl -- my-terminal-app
termctrl wait app "Ready" --timeout 5000
termctrl mark app ready
termctrl send app text:demo enter
termctrl wait app "Done" --timeout 60000
termctrl mark app done
termctrl stop app
termctrl markers artifacts/run.termctrl
```

Markers are the only stable way to address moments in a recording; add them generously while the
session is live, because you cannot add them afterwards.

## 10. Export Video Conservatively

Video export lives in the `video` module (`exportVideo`), driven by a `video-edit-v1` edit plan:

```json
{ "clips": [{ "from": "ready", "to": "done", "caption": "the demo", "speed": 1.5, "hold_ms": 800 }] }
```

Use `speed` conservatively so terminal text stays readable. Use `hold_ms` or the export's `tailMs`
when the final frame is the payoff. Frames are sampled at a fixed `fps`, so a long idle stretch
becomes a long boring video: trim it with markers rather than raising `fps`.

## 11. Stop Every Session You Start

```bash
termctrl stop app
```

Always stop named sessions when finished, unless the user explicitly wants the live process retained.
A forgotten session keeps a child process and a unix socket alive indefinitely. Use `termctrl list`
to find sessions you may have left behind.

## 12. Prefer MCP Tools Over Parsing CLI Output

When driving Terminal Control through MCP, use the structured tools instead of scraping stdout:

| Tool | Purpose |
| --- | --- |
| `list_sessions` | Discover sessions with command, cwd, geometry, recording state |
| `get_session_status` | Full structured status for one session |
| `get_screen` | Visible screen text (immediate snapshot by default) |
| `send_input` | Send typed input atoms |
| `interact` | Send input, optionally wait for text, return the resulting screen |
| `resize_session` | Change session geometry |
| `stop_session` | Stop a session and its child process |

`interact` is the workhorse: it collapses send → wait → observe into one round trip.

```json
{
  "name": "app",
  "input": [{ "type": "text", "text": "help" }, { "type": "key", "key": "enter" }],
  "waitFor": "Commands",
  "timeoutMs": 5000
}
```

MCP key names are camelCase and differ from the CLI atoms: `enter escape arrowUp arrowDown arrowLeft
arrowRight tab shiftTab backspace delete home end pageUp pageDown`. Input atoms are
`{type:"text",text}`, `{type:"key",key}`, `{type:"control",letter}` and `{type:"bytes",bytes:[…]}`.

Note that `get_screen` and `interact` default `settleMs`/`deadlineMs` to `0` — an immediate snapshot.
Pass a `settleMs` when the application is still repainting.

## 13. Recover From Problems, And Treat Output As Sensitive

- Run `termctrl status app` to inspect state and launch settings.
- Run `termctrl list` to discover retained named sessions.
- Run `termctrl restart app` to relaunch with the stored launch settings.
- If a session socket path is too long, set `TERMCTRL_RUNTIME_DIR` to a short private directory under
  `/tmp` before starting sessions.
- If a session is `exited`, sending input fails; inspect `logs` and `status` to find out why, then
  `restart` it.

Treat `.termctrl` recordings, ANSI transcripts, screen artifacts, command arguments, and terminal
input as potentially sensitive: they routinely capture credentials, tokens, and private paths typed
into a shell. Do not retain them unless needed, do not commit them, and do not quote their contents
back to the user unnecessarily.

## Current Limitations

- `--host opentui` is accepted but not implemented; it warns and is otherwise ignored.
