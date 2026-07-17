import { describe, expect, test, beforeAll, afterEach } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFile as nodeExec } from "node:child_process"
import { promisify } from "node:util"
import { compileCodegraphQueries, destroyCodegraphs, getCodegraph } from "./index.ts"

const exec = promisify(nodeExec)
const roots: string[] = []
async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "chunky-codegraph-")); roots.push(root)
  for (const [name, text] of Object.entries(files)) { const p=join(root,name); await mkdir(join(p,".."),{recursive:true}); await writeFile(p,text) }
  await exec("git",["init","-q",root]); await exec("git",["-C",root,"add","."]); return root
}
async function close(root: string) { getCodegraph(root).dispose(); destroyCodegraphs() }
function cacheFile(root: string) { let hash = 5381; for (const char of resolve(root)) hash = (hash * 33 + char.charCodeAt(0)) | 0; return join(process.env.HOME || root, ".chunky/state/codegraph", `b${(hash >>> 0).toString(36)}.json`) }

afterEach(async () => { for (const r of roots.splice(0)) await rm(r,{recursive:true,force:true}); destroyCodegraphs() })

beforeAll(async () => { await compileCodegraphQueries() })

describe("query compilation", () => {
  test("compiles all supported grammars", async () => { await compileCodegraphQueries() })
})

describe("language fixtures", () => {
  const cases: [string,string,string,string][] = [
    ["go", "main.go", `package main\nimport alias \"fmt\"\nfunc Target() {}\nfunc Use(){ Target() }\n`, "Target"],
    ["js", "main.js", `import { Target as Alias } from './lib.js'\nfunction Target() {}\nfunction Use(){ Alias(); Target() }\n`, "Target"],
    ["python", "main.py", `from lib import target as alias\ndef target(): pass\ndef use(): alias(); target()\n`, "target"],
    ["rust", "main.rs", `use crate::lib::target as alias;\nfn target() {}\nfn use_it(){ alias(); target(); }\n`, "target"],
    ["ts", "main.ts", `import { target as alias } from './lib'\nfunction target() {}\nfunction useIt(){ alias(); target() }\n`, "target"],
    ["ruby", "main.rb", `require_relative './support'\nmodule Auditable\nend\nclass User < Base\n  include Auditable\n  ID = 1\n  def save; validate; end\n  def validate; end\nend\n`, "validate"],
  ]
  for (const [label,file,body,symbol] of cases) test(label, async () => {
    const root=await workspace({[file]:body,[file.replace(/main\./,"lib.")]:body})
    const m=getCodegraph(root); const defs=await m.query(symbol,false), refs=await m.query(symbol,true)
    expect(defs.some(x=>x.file===resolve(root,file))).toBe(true)
    expect(refs.some(x=>x.file===resolve(root,file))).toBe(true)
    m.dispose()
  })
})

test("Ruby .rb and .rake share ranking language", async () => {
  const root = await workspace({"model.rb": "def build; end\n", "tasks.rake": "def build; end\n"})
  const m = getCodegraph(root)
  expect((await m.query("build", false, "tasks.rake"))[0]?.file).toBe(resolve(root, "model.rb"))
  m.dispose()
})

test("incremental update reindexes changed files", async () => {
  const root=await workspace({"main.ts":"function oldName() {}\n"}); const m=getCodegraph(root); await m.query("oldName",false)
  await writeFile(join(root,"main.ts"),"function newName() {}\n"); await (m as any).enqueue("main.ts")
  expect((await m.query("newName",false)).length).toBe(1); m.dispose()
})

test("cache round trip loads and reparses changed files", async () => {
  const root=await workspace({"main.ts":"function cached() {}\n"}); let m=getCodegraph(root); expect((await m.query("cached",false)).length).toBe(1); m.dispose()
  await writeFile(join(root,"main.ts"),"function changed() {}\n"); const now=new Date(Date.now()+2000); await utimes(join(root,"main.ts"),now,now); destroyCodegraphs()
  m=getCodegraph(root); expect((await m.query("changed",false)).length).toBe(1); expect((await m.query("cached",false)).length).toBe(0); m.dispose()
})

test("ranking prefers the context language, including TSX", async () => {
  const root = await workspace({"one.py": "def same(): pass\n", "two.ts": "function same() {}\n"})
  const m = getCodegraph(root)
  expect((await m.query("same", false, "two.ts"))[0]?.file).toBe(resolve(root, "two.ts"))
  expect((await m.query("same", false, "one.py"))[0]?.file).toBe(resolve(root, "one.py"))
  expect((await m.query("same", false, "context.tsx"))[0]?.file).toBe(resolve(root, "two.ts"))
  m.dispose()
})

test("position lookup distinguishes repeated identifiers and reports position errors", async () => {
  const source = "function foo2() {}\nconst foo = foo2.foo(foo)\n"
  const root = await workspace({"main.js": source})
  const m = getCodegraph(root)
  expect((await m.at("main.js", 2, 8, true))[0]?.name).toBe("foo")
  expect((await m.at("main.js", 2, 14, true))[0]?.name).toBe("foo2")
  expect((await m.at("main.js", 2, 19, true))[0]?.name).toBe("foo")
  expect((await m.at("main.js", 2, 23, true))[0]?.name).toBe("foo")
  await expect(m.at("missing.js", 1, 1, true)).rejects.toMatchObject({ code: "file-not-found" })
  await writeFile(join(root, "notes.txt"), "text")
  await expect(m.at("notes.txt", 1, 1, true)).rejects.toMatchObject({ code: "unsupported-language" })
  await expect(m.at("main.js", 2, 12, true)).rejects.toMatchObject({ code: "no-symbol-at-position" })
  m.dispose()
})

test("query-version changes reject the persisted cache and rebuild", async () => {
  const root = await workspace({"main.ts": "function cachedVersion() {}\n"})
  let m = getCodegraph(root); expect((await m.query("cachedVersion", false)).length).toBe(1); destroyCodegraphs()
  const file = cacheFile(root), cache = JSON.parse(await readFile(file, "utf8")); cache.version = "doctored-query-version"; await writeFile(file, JSON.stringify(cache))
  m = getCodegraph(root); expect((await m.query("cachedVersion", false)).length).toBe(1); m.dispose()
})

test("include_definition controls definition hits", async () => {
  const root = await workspace({"main.ts": "function target() {}\nfunction use(){ target() }\n"})
  const m = getCodegraph(root)
  const withDefinition = await m.query("target", true, undefined, true), withoutDefinition = await m.query("target", true, undefined, false)
  expect(withDefinition.some((hit) => hit.line === 1)).toBe(true)
  expect(withoutDefinition.some((hit) => hit.line === 1)).toBe(false)
  m.dispose()
})

test("rapid watcher updates coalesce and binary files are skipped", async () => {
  const root = await workspace({"main.ts": "function first() {}\n"})
  await writeFile(join(root, "binary.ts"), Buffer.from([0, 1, 2, 3]))
  const m = getCodegraph(root); await m.query("first", false)
  await writeFile(join(root, "main.ts"), "function final() {}\n")
  const updates = [m.enqueue("main.ts"), m.enqueue("main.ts"), m.enqueue("main.ts")]
  await Promise.all(updates)
  expect((await m.query("final", false)).length).toBe(1)
  expect((await m.query("first", false)).length).toBe(0)
  expect((await m.query("binary", false)).length).toBe(0)
  m.dispose()
})

test("self-repo smoke resolves withFileLock", async () => {
  const root=resolve(process.cwd()), started=performance.now(), m=getCodegraph(root); const hits=await m.query("withFileLock",false); const duration=performance.now()-started
  console.log(`codegraph self-repo smoke: ${duration.toFixed(1)}ms`)
  expect(hits.some(x=>x.file===resolve(root,"packages/server/src/file-lock.ts"))).toBe(true); m.dispose()
})
