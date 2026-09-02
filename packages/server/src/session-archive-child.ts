// Test helper: archive one session in a CHILD process. Integration tests drive
// a spawned server; importing session-archive.ts (and so the Store singleton)
// into the test process would bind it to whichever database the first test
// file in the run happened to configure. Env: the server's CHUNKY_* variables.
//   bun run packages/server/src/session-archive-child.ts <sessionId>
const { archiveSession } = await import("./session-archive.ts")
const id = process.argv[2]
if (!id) throw new Error("usage: session-archive-child.ts <sessionId>")
console.log(String(await archiveSession(id)))

export {}
