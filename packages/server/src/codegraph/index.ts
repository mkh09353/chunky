// NOTICE: Derived from xai-org/grok-build xai-codebase-graph, Apache-2.0.
import { Parser, Language, Query } from "web-tree-sitter"
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, watch, type FSWatcher } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { QUERIES, TYPESCRIPT_BASE, TYPESCRIPT_JSX } from "./queries.ts"
const exec=promisify(execFile), HERE=dirname(fileURLToPath(import.meta.url))
const grammarRoot=join(dirname(Bun.resolveSync("tree-sitter-wasms/package.json", import.meta.dir)),"out")
type Lang="golang"|"javascript"|"python"|"rust"|"ts"
const configs: {ext:string;lang:Lang;wasm:string}[]=[{ext:".go",lang:"golang",wasm:"go"},{ext:".js",lang:"javascript",wasm:"javascript"},{ext:".jsx",lang:"javascript",wasm:"javascript"},{ext:".py",lang:"python",wasm:"python"},{ext:".rs",lang:"rust",wasm:"rust"},{ext:".ts",lang:"ts",wasm:"typescript"},{ext:".tsx",lang:"ts",wasm:"tsx"}]
const cfg=(p:string)=>configs.find(x=>x.ext===extname(p).toLowerCase())
const ignored=(p:string)=>/(^|[\\/])(?:\.git|node_modules|\.research)(?:[\\/]|$)/.test(p)
type Hit={file:string;line:number;name:string;kind?:string;matchedSymbol?:string}
type FileRecord={defs:Hit[];refs:Hit[];aliases:[string,string][];size:number;mtime:number;lang:Lang}
export type ScopeNode={id:number;kind:"scope"|"def"|"import"|"ref";range:[number,number,number,number];name?:string}
export type ScopeEdge={from:number;to:number;kind:"scope_to_scope"|"def_to_scope"|"import_to_scope"|"ref_to_def"|"ref_to_import"}
export type ScopeGraph={nodes:ScopeNode[];edges:ScopeEdge[]}
let parserReady:Promise<void>|undefined
const languages=new Map<string,Language>()
const runtimes=new Map<string,{ language:Language; parser:Parser; query:Query }>()
async function parserInit(){if(!parserReady)parserReady=(async()=>{await Parser.init()})().catch(e=>{parserReady=undefined;throw e});return parserReady}
async function language(name:string){await parserInit();let l=languages.get(name);if(!l){const p=join(grammarRoot,`tree-sitter-${name}.wasm`);if(!existsSync(p))throw Error(`missing tree-sitter grammar ${p}`);l=await Language.load(p);languages.set(name,l)}return l}
async function runtime(name:string){let r=runtimes.get(name);if(!r){const l=await language(name);const parser=new Parser();parser.setLanguage(l);const key=name==='go'?'golang':name==='typescript'||name==='tsx'?'ts':name as Lang;const source=name==='typescript'?TYPESCRIPT_BASE:name==='tsx'?TYPESCRIPT_BASE+TYPESCRIPT_JSX:QUERIES[key];let query:Query;try{query=new Query(l,source)}catch(e){console.error(`[codegraph] failed to compile ${name} query`,e);throw e}r={language:l,parser,query};runtimes.set(name,r)}return r}
export async function compileCodegraphQueries(){for(const name of ["go","javascript","python","rust","typescript","tsx"])await runtime(name)}
function line(source:string,row:number){return row+1}
function extract(file:string,source:string):{record:FileRecord;graph:ScopeGraph}|undefined{const c=cfg(file);if(!c)return;throw Error("extract requires async parser")}
async function parseFile(file:string,source:string):Promise<{record:FileRecord;graph:ScopeGraph}>{const c=cfg(file)!;const rt=await runtime(c.lang==='ts'&&c.wasm==='tsx'?'tsx':c.wasm);const tree=rt.parser.parse(source);if(!tree)throw Error("tree-sitter returned no tree");const q=rt.query;const defs:Hit[]=[],refs:Hit[]=[],aliases:[string,string][]=[];const nodes:ScopeNode[]=[{id:0,kind:"scope",range:[0,0,tree.rootNode.endPosition.row,tree.rootNode.endPosition.column]}],edges:ScopeEdge[]=[];let id=1
 for(const m of q.matches(tree.rootNode)){let original:string|undefined,alias:string|undefined;for(const cap of m.captures){const name=cap.name, n=cap.node, text=source.slice(n.startIndex,n.endIndex), h={file,line:n.startPosition.row+1,name:text};const parts=name.split(".");if(parts[0]==="name"&&parts[1]==="definition"){defs.push({...h,kind:parts[2]});nodes.push({id:id++,kind:"def",name:text,range:[n.startPosition.row,n.startPosition.column,n.endPosition.row,n.endPosition.column]});edges.push({from:id-1,to:0,kind:"def_to_scope"})}else if(parts[0]==="name"&&parts[1]==="reference"){refs.push({...h,kind:parts[2]});nodes.push({id:id++,kind:"ref",name:text,range:[n.startPosition.row,n.startPosition.column,n.endPosition.row,n.endPosition.column]});}else if(name==="alias.original")original=text;else if(name==="alias.name")alias=text}if(original&&alias)aliases.push([alias,original])}
 const st=statSync(file);return {record:{defs,refs,aliases,size:st.size,mtime:st.mtimeMs,lang:c.lang},graph:{nodes,edges}}
}
class Index{records=new Map<string,FileRecord>();graphs=new Map<string,ScopeGraph>();get defs(){return [...this.records.values()].flatMap(r=>r.defs)}get refs(){return [...this.records.values()].flatMap(r=>r.refs)}
 async build(root:string){let out="";try{out=(await exec("git",["-C",root,"ls-files","-co","--exclude-standard"])).stdout}catch{}let n=0;for(const p of out.split(/\r?\n/).filter(Boolean)){await this.load(resolve(root,p));if(++n%25===0)await Bun.sleep(0)}}
 async load(file:string){try{if(ignored(file)||statSync(file).size>1e6)return;const x=await parseFile(file,readFileSync(file,"utf8"));this.records.set(resolve(file),x.record);this.graphs.set(resolve(file),x.graph)}catch{this.records.delete(resolve(file));this.graphs.delete(resolve(file))}}
 remove(file:string){this.records.delete(resolve(file));this.graphs.delete(resolve(file))}
 find(name:string,refs:boolean){const all=refs?this.refs:this.defs,out=all.filter(x=>x.name===name), aliases=[...this.records.values()].flatMap(r=>r.aliases);for(const [a,o] of aliases){if(!refs&&a===name)out.push(...all.filter(x=>x.name===o).map(x=>({...x,matchedSymbol:a})));if(refs&&a===name)out.push(...all.filter(x=>x.name===o).map(x=>({...x,matchedSymbol:a})));if(refs&&o===name)out.push(...all.filter(x=>x.name===a).map(x=>({...x,matchedSymbol:a})))}const seen=new Set<string>();return out.filter(x=>{const k=`${x.file}:${x.line}`;if(seen.has(k)&&!refs)return false;seen.add(k);return true})}
}
class Manager {
 index=new Index(); queue:Promise<void>=Promise.resolve(); ready:Promise<void>; watcher?:FSWatcher; disposed=false
 constructor(public root:string){
  this.ready=this.initialBuild().catch(()=>{})
 }
 private async initialBuild(){
  const ok=await this.loadCache()
  if(!ok) await this.index.build(this.root)
  await this.save()
  if(!this.disposed) {
   try { this.watcher=watch(this.root,{recursive:true},(_,p)=>this.enqueue(String(p||""))) } catch {}
  }
 }
 private enqueue(path:string){if(!path||ignored(path))return;this.queue=this.queue.then(async()=>{try{const f=resolve(this.root,path);if(existsSync(f))await this.index.load(f);else this.index.remove(f);await this.save()}catch{}})}
 async loadCache(){try{const p=cachePath(this.root),j=JSON.parse(readFileSync(p,"utf8"));if(j.version!==4||j.root!==this.root||!j.records?.length)return false;const tracked=(await exec("git",["-C",this.root,"ls-files","-co","--exclude-standard"])).stdout.split(/\r?\n/).filter(Boolean).filter(x=>cfg(x)&&!ignored(x));if(tracked.some(x=>!this.index.records.has(resolve(this.root,x))))return false;for(const [f,r] of j.records){let st:ReturnType<typeof statSync>|undefined;try{st=statSync(f)}catch{}if(!st||st.mtimeMs!==r.mtime||st.size!==r.size)await this.index.load(f);else this.index.records.set(f,r)}return this.index.records.size>0}catch{return false}}
 async save(){try{const p=cachePath(this.root),tmp=p+".tmp";mkdirSync(dirname(p),{recursive:true});writeFileSync(tmp,JSON.stringify({version:4,root:this.root,records:[...this.index.records]}));renameSync(tmp,p)}catch{}}
 private async waitReady(){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([this.ready,new Promise<void>(r=>{timer=setTimeout(r,60000)})])}finally{if(timer)clearTimeout(timer)}}
 async query(symbol:string,refs:boolean){await this.waitReady();return this.index.find(symbol,refs).sort((a,b)=>this.rank(a,b)||a.file.localeCompare(b.file)||a.line-b.line)}
 async at(file:string,lineNo:number,col:number,refs:boolean){await this.waitReady();try{const s=readFileSync(resolve(this.root,file)).toString().split(/\r?\n/)[lineNo-1]||"",m=s.match(/[A-Za-z_$][\w$]*/g)||[];let name="";for(const x of m){const i=s.indexOf(x);if(i<=col-1&&i+x.length>=col-1){name=x;break}}return this.query(name,refs)}catch{return []}}
 rank(a:Hit,b:Hit){const ea=extname(a.file),eb=extname(b.file);return (ea===eb?0:1)-(eb===ea?0:1)}
 dispose(){this.disposed=true;this.watcher?.close();this.watcher=undefined}
}
function statSafe(p:string){try{return statSync(p).mtimeMs}catch{return -1}}function cachePath(root:string){let h=5381;for(const c of root)h=(h*33+c.charCodeAt(0))|0;return join(process.env.HOME||root,".chunky/state/codegraph",`b${(h>>>0).toString(36)}.json`)}
const managers=new Map<string,Manager>();export function getCodegraph(root:string){root=resolve(root);let m=managers.get(root);if(!m){m=new Manager(root);managers.set(root,m)}return m}export function destroyCodegraphs(){for(const m of managers.values())m.dispose();managers.clear()}export type {Hit}
