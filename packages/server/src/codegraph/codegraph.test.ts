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
  ]
  for (const [label,file,body,symbol] of cases) test(label, async () => {
    const root=await workspace({[file]:body,[file.replace(/main\./,"lib.")]:body})
    const m=getCodegraph(root); const defs=await m.query(symbol,false), refs=await m.query(symbol,true)
    expect(defs.some(x=>x.file===resolve(root,file))).toBe(true)
    expect(refs.some(x=>x.file===resolve(root,file))).toBe(true)
    m.dispose()
  })
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

test("self-repo smoke resolves withFileLock", async () => {
  const root=resolve(process.cwd()), started=performance.now(), m=getCodegraph(root); const hits=await m.query("withFileLock",false); const duration=performance.now()-started
  console.log(`codegraph self-repo smoke: ${duration.toFixed(1)}ms`)
  expect(hits.some(x=>x.file===resolve(root,"packages/server/src/file-lock.ts"))).toBe(true); m.dispose()
})
