import { Store } from "./store.ts"

const id = "repo-less-test"
Store.createSession(id, "General chat", null, "none")
const summary = Store.summary(id)
const listed = Store.list(undefined, "none").find((row) => row.sessionId === id)
if (Store.workspaceOf(id) !== null) throw new Error("workspace was not null")
if (Store.repositoryScopeOf(id) !== "none") throw new Error("scope was not none")
if (summary?.workspace !== null || summary.repositoryScope !== "none") throw new Error("summary lost scope")
if (listed?.workspace !== null || listed.repositoryScope !== "none") throw new Error("list lost scope")
console.log("repo-less store smoke: ok")
