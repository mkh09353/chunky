export type TerminalStatus = "running" | "exited"
export interface TerminalInfo { terminalId: string; title: string; cwd: string; status: TerminalStatus; pid: number | null; exitCode: number | null }
export interface TerminalOpenRequest { terminalId: string; cwd?: string; cols: number; rows: number }
export interface TerminalOpenResult { ok: boolean; info?: TerminalInfo; snapshot?: string; error?: string }
export interface TerminalWriteRequest { terminalId: string; data: string } // data <= 65536 chars
export interface TerminalResizeRequest { terminalId: string; cols: number; rows: number } // clamp cols 20–2000, rows 5–1000
export interface TerminalAckRequest { terminalId: string; bytes: number }
export type TerminalEvent =
  | { kind: "output"; terminalId: string; data: string }
  | { kind: "exited"; terminalId: string; exitCode: number | null }
  | { kind: "started"; terminalId: string; pid: number }
