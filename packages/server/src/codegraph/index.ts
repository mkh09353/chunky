// NOTICE: Derived from xai-org/grok-build xai-codebase-graph, Apache-2.0.
import { Parser, Language, Query, type Tree, type Node } from "web-tree-sitter"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, watch, type FSWatcher } from "node:fs"
import { readdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dirname, extname, join, relative, resolve } from "node:path"
import { QUERIES, TYPESCRIPT_BASE, TYPESCRIPT_JSX } from "./queries.ts"

const exec = promisify(execFile)
const grammarRoot = join(dirname(Bun.resolveSync("tree-sitter-wasms/package.json", import.meta.dir)), "out")
const MAX_FILE_SIZE = 5 * 1024 * 1024
const BINARY_SAMPLE_SIZE = 1024
const CACHE_SCHEMA = "codegraph-records-v2"

type Lang = "golang" | "javascript" | "python" | "rust" | "ts" | "ruby"
type Config = { ext: string; lang: Lang; wasm: string }
const configs: Config[] = [
  { ext: ".go", lang: "golang", wasm: "go" },
  { ext: ".js", lang: "javascript", wasm: "javascript" },
  { ext: ".jsx", lang: "javascript", wasm: "javascript" },
  { ext: ".py", lang: "python", wasm: "python" },
  { ext: ".rs", lang: "rust", wasm: "rust" },
  { ext: ".ts", lang: "ts", wasm: "typescript" },
  { ext: ".tsx", lang: "ts", wasm: "tsx" },
  { ext: ".rb", lang: "ruby", wasm: "ruby" },
  { ext: ".rake", lang: "ruby", wasm: "ruby" },
  { ext: ".gemspec", lang: "ruby", wasm: "ruby" },
]
const configFor = (file: string) => configs.find((x) => x.ext === extname(file).toLowerCase())
const ignored = (file: string) => /(^|[\\/])(?:\.git|node_modules|\.research|dist|build)(?:[\\/]|$)/.test(file)
const sameLanguage = (a: string, b: string) => configFor(a)?.lang === configFor(b)?.lang

export type Hit = { file: string; line: number; name: string; kind?: string; matchedSymbol?: string }
 type FileRecord = { defs: Hit[]; refs: Hit[]; aliases: [string, string][]; size: number; mtime: number; lang: Lang }
export type ScopeNode = { id: number; kind: "scope" | "def" | "import" | "ref"; range: [number, number, number, number]; name?: string }
export type ScopeEdge = { from: number; to: number; kind: "scope_to_scope" | "def_to_scope" | "import_to_scope" | "ref_to_def" | "ref_to_import" }
export type ScopeGraph = { nodes: ScopeNode[]; edges: ScopeEdge[] }

const queryVersion = createHash("sha256").update(CACHE_SCHEMA).update(JSON.stringify([QUERIES, TYPESCRIPT_BASE, TYPESCRIPT_JSX])).digest("hex").slice(0, 16)
const languages = new Map<string, Language>()
const runtimes = new Map<string, { language: Language; parser: Parser; query: Query }>()
let parserReady: Promise<void> | undefined

async function parserInit() {
  if (!parserReady) parserReady = Parser.init().catch((error) => { parserReady = undefined; throw error })
  return parserReady
}
async function language(name: string) {
  await parserInit()
  let value = languages.get(name)
  if (!value) {
    const file = join(grammarRoot, `tree-sitter-${name}.wasm`)
    if (!existsSync(file)) throw new Error(`missing tree-sitter grammar ${file}`)
    value = await Language.load(file)
    languages.set(name, value)
  }
  return value
}
async function runtime(name: string) {
  let value = runtimes.get(name)
  if (!value) {
    const lang = await language(name)
    const parser = new Parser(); parser.setLanguage(lang)
    const key = name === "go" ? "golang" : name === "typescript" || name === "tsx" ? "ts" : name as Lang
    const source = name === "typescript" ? TYPESCRIPT_BASE : name === "tsx" ? TYPESCRIPT_BASE + TYPESCRIPT_JSX : QUERIES[key]
    let query: Query
    try { query = new Query(lang, source) }
    catch (error) { console.error(`[codegraph] failed to compile ${name} query`, error); throw error }
    value = { language: lang, parser, query }; runtimes.set(name, value)
  }
  return value
}
export async function compileCodegraphQueries() { for (const name of ["go", "javascript", "python", "rust", "typescript", "tsx", "ruby"]) await runtime(name) }

function parseRecord(file: string, source: string, tree: Tree, query: Query) {
  const defs: Hit[] = [], refs: Hit[] = [], aliases: [string, string][] = []
  const nodes: ScopeNode[] = [{ id: 0, kind: "scope", range: [0, 0, tree.rootNode.endPosition.row, tree.rootNode.endPosition.column] }]
  const edges: ScopeEdge[] = []; let id = 1
  for (const match of query.matches(tree.rootNode)) {
    let original: string | undefined, alias: string | undefined
    for (const capture of match.captures) {
      const name = capture.name, node = capture.node, text = source.slice(node.startIndex, node.endIndex)
      const hit = { file, line: node.startPosition.row + 1, name: text }
      const parts = name.split(".")
      if (parts[0] === "name" && parts[1] === "definition") {
        defs.push({ ...hit, kind: parts[2] }); nodes.push({ id: id++, kind: "def", name: text, range: [node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column] }); edges.push({ from: id - 1, to: 0, kind: "def_to_scope" })
      } else if (parts[0] === "name" && parts[1] === "reference") {
        refs.push({ ...hit, kind: parts[2] }); nodes.push({ id: id++, kind: "ref", name: text, range: [node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column] })
      } else if (name === "alias.original") original = text
      else if (name === "alias.name") alias = text
    }
    if (original && alias) aliases.push([alias, original])
  }
  const stat = statSync(file)
  return { record: { defs, refs, aliases, size: stat.size, mtime: stat.mtimeMs, lang: configFor(file)!.lang }, graph: { nodes, edges } }
}
async function parseFile(file: string, source?: string) {
  const config = configFor(file); if (!config) throw new Error(`unsupported language: ${file}`)
  const rt = await runtime(config.wasm === "tsx" ? "tsx" : config.wasm)
  const text = source ?? readFileSync(file, "utf8"); const tree = rt.parser.parse(text)
  if (!tree) throw new Error("tree-sitter returned no tree")
  return parseRecord(file, text, tree, rt.query)
}

class Index {
  records = new Map<string, FileRecord>(); graphs = new Map<string, ScopeGraph>()
  aliases = new Map<string, Set<string>>(); reverseAliases = new Map<string, Set<string>>()
  get defs() { return [...this.records.values()].flatMap((r) => r.defs) }
  get refs() { return [...this.records.values()].flatMap((r) => r.refs) }
  rebuildAliases() { this.aliases.clear(); this.reverseAliases.clear(); for (const r of this.records.values()) for (const [alias, original] of r.aliases) { if (!this.aliases.has(alias)) this.aliases.set(alias, new Set()); if (!this.reverseAliases.has(original)) this.reverseAliases.set(original, new Set()); this.aliases.get(alias)!.add(original); this.reverseAliases.get(original)!.add(alias) } }
  async build(root: string) { let files: string[] = []; try { files = (await exec("git", ["-C", root, "ls-files", "-co", "--exclude-standard"])).stdout.split(/\r?\n/).filter(Boolean).map((p) => resolve(root, p)) } catch { files = await walk(root) } for (const file of files) await this.load(file) }
  async load(file: string) { const key = resolve(file); try { const stat = statSync(key); if (ignored(key) || stat.size > MAX_FILE_SIZE) return this.remove(key); const sample = readFileSync(key).subarray(0, BINARY_SAMPLE_SIZE); if (sample.includes(0)) return this.remove(key); const parsed = await parseFile(key); this.records.set(key, parsed.record); this.graphs.set(key, parsed.graph); this.rebuildAliases() } catch { this.remove(key) } }
  remove(file: string) { const key = resolve(file); this.records.delete(key); this.graphs.delete(key); this.rebuildAliases() }
  find(name: string, refs: boolean, contextFile?: string, includeDefinition = true) {
    const aliases = this.aliases, reverse = this.reverseAliases, all = refs ? this.refs : this.defs, output: Hit[] = []
    const add = (symbol: string, matchedSymbol?: string) => output.push(...all.filter((x) => x.name === symbol).map((x) => matchedSymbol ? { ...x, matchedSymbol } : x))
    add(name)
    for (const original of aliases.get(name) ?? []) add(original, name)
    for (const alias of reverse.get(name) ?? []) add(alias, alias)
    if (refs && includeDefinition) output.push(...this.defs.filter((x) => x.name === name || aliases.get(name)?.has(x.name) || reverse.get(name)?.has(x.name)))
    const seen = new Set<string>(); return output.filter((x) => { const key = `${x.file}:${x.line}:${x.name}`; if (seen.has(key)) return false; seen.add(key); return true }).sort((a, b) => this.rank(a, b, contextFile))
  }
  rank(a: Hit, b: Hit, contextFile?: string) { const languageOrder = (hit: Hit) => contextFile && sameLanguage(hit.file, contextFile) ? 0 : 1; return languageOrder(a) - languageOrder(b) || a.file.localeCompare(b.file) || a.line - b.line }
}

async function walk(root: string): Promise<string[]> { const result: string[] = []; async function visit(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (ignored(file)) continue; if (entry.isDirectory()) await visit(file); else if (configFor(file)) result.push(file) } } await visit(root); return result }

export class CodegraphPositionError extends Error { constructor(public code: "file-not-found" | "unsupported-language" | "no-symbol-at-position", message: string) { super(message) } }
class Manager {
  index = new Index(); queue: Promise<void> = Promise.resolve(); ready: Promise<void>; watcher?: FSWatcher; disposed = false
  private pending = new Map<string, { exists: boolean }>(); private pendingDone: (() => void)[] = []; private debounceTimer?: ReturnType<typeof setTimeout>; private lastSave = 0; private saveTimer?: ReturnType<typeof setTimeout>
  constructor(public root: string) { this.ready = this.initialBuild().catch((error) => { console.error("[codegraph] initial build failed", error) }) }
  private async initialBuild() { if (!(await this.loadCache())) await this.index.build(this.root); await this.save(true); if (!this.disposed) try { this.watcher = watch(this.root, { recursive: true }, (_, path) => this.enqueue(String(path || ""))) } catch {} }
  update(path: string) { this.enqueue(path) }
  async enqueue(path: string) { if (!path || ignored(path)) return; const file = resolve(this.root, path); this.pending.set(file, { exists: existsSync(file) }); clearTimeout(this.debounceTimer); return new Promise<void>((done) => { this.pendingDone.push(done); this.debounceTimer = setTimeout(() => { const batch = [...this.pending], doneBatch = this.pendingDone.splice(0); this.pending.clear(); this.queue = this.queue.then(async () => { for (const [item, state] of batch) state.exists ? await this.index.load(item) : this.index.remove(item); await this.save(); for (const finish of doneBatch) finish() }) }, 200) }) }
  private async loadCache() { try { const cache = JSON.parse(readFileSync(cachePath(this.root), "utf8")); if (cache.version !== queryVersion || cache.root !== this.root || !cache.records?.length) return false; for (const [file, record] of cache.records) { const stat = statSync(file); if (stat.mtimeMs !== record.mtime || stat.size !== record.size) await this.index.load(file); else this.index.records.set(file, record) } this.index.rebuildAliases(); return this.index.records.size > 0 } catch { return false } }
  private async save(force = false) { const now = Date.now(); if (!force && now - this.lastSave < 60_000) { if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(true) }, 60_000 - (now - this.lastSave)); return } this.lastSave = now; try { const file = cachePath(this.root), temp = `${file}.tmp`; mkdirSync(dirname(file), { recursive: true }); writeFileSync(temp, JSON.stringify({ version: queryVersion, root: this.root, records: [...this.index.records] })); renameSync(temp, file) } catch {} }
  private async waitReady() { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([this.ready, new Promise<void>((r) => { timer = setTimeout(r, 60_000) })]) } finally { if (timer) clearTimeout(timer) } }
  async query(symbol: string, refs: boolean, contextFile?: string, includeDefinition = true) { await this.waitReady(); return this.index.find(symbol, refs, contextFile ? resolve(this.root, contextFile) : undefined, includeDefinition) }
  async at(file: string, line: number, col: number, refs: boolean, contextFile?: string, includeDefinition = true) {
    await this.waitReady(); const path = resolve(this.root, file); if (!existsSync(path)) throw new CodegraphPositionError("file-not-found", `file not found: ${file}`); const config = configFor(path); if (!config) throw new CodegraphPositionError("unsupported-language", `unsupported language: ${file}`)
    const source = readFileSync(path, "utf8"), rt = await runtime(config.wasm === "tsx" ? "tsx" : config.wasm), tree = rt.parser.parse(source); if (!tree) throw new CodegraphPositionError("no-symbol-at-position", "no symbol at position")
    const row = line - 1, column = col - 1; const kinds = new Set(["identifier", "type_identifier", "property_identifier", "field_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "attribute", "package_identifier"]); let found: Node | undefined
    function visit(node: Node) { if (row < node.startPosition.row || row > node.endPosition.row || (row === node.startPosition.row && column < node.startPosition.column) || (row === node.endPosition.row && column >= node.endPosition.column)) return; for (const child of node.namedChildren) if (child) visit(child); if (!found && kinds.has(node.type)) found = node }
    visit(tree.rootNode); if (!found) throw new CodegraphPositionError("no-symbol-at-position", "no symbol at position")
    return this.query(source.slice(found.startIndex, found.endIndex), refs, contextFile ?? file, includeDefinition)
  }
  dispose() { this.disposed = true; this.watcher?.close(); clearTimeout(this.debounceTimer); clearTimeout(this.saveTimer); void this.save(true) }
}
function cachePath(root: string) { let hash = 5381; for (const char of root) hash = (hash * 33 + char.charCodeAt(0)) | 0; return join(process.env.HOME || root, ".chunky/state/codegraph", `b${(hash >>> 0).toString(36)}.json`) }
const managers = new Map<string, Manager>()
export function getCodegraph(root: string) { root = resolve(root); let manager = managers.get(root); if (!manager) { manager = new Manager(root); managers.set(root, manager) } return manager }
export function destroyCodegraphs() { for (const manager of managers.values()) manager.dispose(); managers.clear() }
export { queryVersion }
