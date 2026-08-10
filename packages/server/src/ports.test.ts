import { afterEach, describe, expect, test } from "bun:test"
import { currentSessionPorts, finishTaskPorts, installPortEmitter, parseLsofOutput, parseSsOutput, resetPortTracking, scanSessionPorts, setPortCommandRunnerForTests, stablePorts, trackTaskPorts } from "./ports.ts"

afterEach(() => { resetPortTracking(); setPortCommandRunnerForTests(); installPortEmitter(() => {}) })

describe("port output parsers", () => {
  test("parses lsof and suggests URLs only for reachable binds", () => {
    expect(parseLsofOutput("p42\ncnode\nn127.0.0.1:3000\nn10.0.0.2:4000\n", "task-1")).toEqual([
      { port: 3000, address: "127.0.0.1", pid: 42, command: "node", taskId: "task-1", url: "http://localhost:3000/" },
      { port: 4000, address: "10.0.0.2", pid: 42, command: "node", taskId: "task-1", url: null },
    ])
  })
  test("parses ss and filters to owned pids", () => {
    const text = 'LISTEN 0 128 0.0.0.0:5173 0.0.0.0:* users:(("bun",pid=44,fd=3),("other",pid=99,fd=4))'
    expect(parseSsOutput(text, "task-2", new Set([44]))).toEqual([
      { port: 5173, address: "0.0.0.0", pid: 44, command: "bun", taskId: "task-2", url: "http://localhost:5173/" },
    ])
  })
  test("sorts and dedupes IPv4/IPv6 copies by port and pid", () => {
    const base = { port: 3000, pid: 42, command: "node", taskId: "task-1", url: "http://localhost:3000/" }
    expect(stablePorts([{ ...base, address: "::" }, { ...base, address: "0.0.0.0" }])).toHaveLength(1)
  })
})

describe("port tracking lifecycle", () => {
  test("emits only on change and clears immediately on finish", async () => {
    const emitted: unknown[] = []
    installPortEmitter((_session, ports) => emitted.push(ports))
    setPortCommandRunnerForTests((command) => command[0] === "lsof" ? { exitCode: 0, stdout: "p1\ncnode\nn*:3000\n" } : { exitCode: 1, stdout: "" })
    trackTaskPorts("s", "task-1", 999999)
    await scanSessionPorts("s"); await scanSessionPorts("s")
    expect(emitted).toHaveLength(1)
    expect(currentSessionPorts("s")[0]?.port).toBe(3000)
    finishTaskPorts("s", "task-1")
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toEqual([])
  })
})
