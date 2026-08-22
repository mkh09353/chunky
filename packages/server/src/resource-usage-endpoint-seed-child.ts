import { Store } from "./store.ts"

const now = Date.now()
Store.logResourceSamples([
  { ts: now - 60_000, scope: "server", rssBytes: 500_000_000, heapUsedBytes: 80_000_000, cpuPercent: 5, activeSessions: 1, liveTasks: 1, liveDelegates: 0 },
  { ts: now - 60_000, scope: "task", sessionId: "s", taskId: "task-1", command: "vite", rssBytes: 100_000_000, cpuPercent: 8 },
])
