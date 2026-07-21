# termctrl

A TypeScript port of [terminal-control](https://github.com/anomalyco/terminal-control)
by Kit Langton (MIT). Same design and command surface, different stack: instead of
libghostty, this port uses `@xterm/headless` for terminal emulation and Bun's native
PTY support. See [THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md) at the repo
root for the original license notice.

PTYs use Bun 1.3.14 native `Bun.spawn({ terminal: ... })`; no node-pty or script fallback is used.
