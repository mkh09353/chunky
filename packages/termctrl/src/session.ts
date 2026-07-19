import {Terminal} from '@xterm/headless';
import {appendFileSync,chmodSync} from 'node:fs';
import {frameFromTerminal,frameText,Frame} from './frame.ts';
export type CaptureReason='idle'|'deadline'|'exited'|'outputclosed';
export type ProcessExit={code:number;signal:string|null;success:boolean};
export type CaptureResult={shot:{frame:Frame;ansi:Uint8Array};reason:CaptureReason};
export type SessionOptions={cols?:number;rows?:number;maxBytes?:number;cwd?:string;env?:Record<string,string>;record?:string;cellWidth?:number;cellHeight?:number};
const dec=new TextDecoder(); const sleep=(n:number)=>new Promise<void>(r=>setTimeout(r,n));
export class Session {
 readonly terminal:Terminal; readonly process:any; readonly pty:any; readonly command:string[]; readonly cwd:string; readonly maxBytes:number; readonly recordPath?:string; private recordStart=Date.now();
 ansi=new Uint8Array(); logsTruncated=false; exited=false; outputClosed=false; exit:ProcessExit|null=null; lastOutput:number|null=null;
 onOutput: ((bytes: Uint8Array) => void) | undefined;
 constructor(command:string[],opts:SessionOptions={}) { if(!command.length) throw Error('provide a command'); this.command=command; this.cwd=opts.cwd??process.cwd(); this.maxBytes=opts.maxBytes??16*1024*1024;
  const cols=opts.cols??80,rows=opts.rows??24; this.recordPath=opts.record; if(this.recordPath){Bun.write(this.recordPath,JSON.stringify({type:'header',version:1,cols,rows,cell_width:opts.cellWidth??9,cell_height:opts.cellHeight??18})+'\n');try{chmodSync(this.recordPath,0o600)}catch{}} this.terminal=new Terminal({cols,rows,scrollback:1000,allowProposedApi:true});
  this.process=Bun.spawn({cmd:command,cwd:this.cwd,env:{...process.env,...opts.env},terminal:{name:'xterm-256color',cols,rows,data:(_term: Bun.Terminal,data:Uint8Array)=>this.apply(data),exit:()=>{this.outputClosed=true}}}); this.pty=this.process.terminal;
  void this.process.exited.then((code:number)=>{this.exited=true;this.exit={code,signal:null,success:code===0};void this.drain()});
 }
 private appendRecord(x:any){if(this.recordPath) appendFileSync(this.recordPath,JSON.stringify(x)+'\n')}
 private apply(bytes:Uint8Array){this.onOutput?.(bytes);this.terminal.write(dec.decode(bytes,{stream:true}));this.appendRecord({type:'output',at_ms:Date.now()-this.recordStart,bytes:Array.from(bytes)});const all=new Uint8Array(this.ansi.length+bytes.length);all.set(this.ansi);all.set(bytes,this.ansi.length);if(all.length>this.maxBytes){this.ansi=all.slice(all.length-this.maxBytes);this.logsTruncated=true}else this.ansi=all;this.lastOutput=Date.now()}
 private async drain(){const until=Date.now()+1000;while(Date.now()<until)await sleep(10)}
 text(){return frameText(this.terminal)} frame(){return frameFromTerminal(this.terminal)}
 send(b:Uint8Array){if(this.exited)throw Error('session command has exited');this.appendRecord({type:'input',at_ms:Date.now()-this.recordStart,origin:'client',bytes:Array.from(b)});this.pty.write(b)}
 async waitForText(text:string,timeout=5000){const deadline=Date.now()+timeout;for(;;){if(this.text().includes(text))return;if(this.exited)throw Error(`session ended before visible terminal included ${JSON.stringify(text)}`);if(Date.now()>=deadline)throw Error(`timed out waiting for visible terminal text ${JSON.stringify(text)}`);await sleep(10)}}
 async capture(settle=250,deadlineMs=5000):Promise<CaptureResult>{const start=Date.now(),deadline=start+deadlineMs;for(;;){const now=Date.now();const reason:CaptureReason|undefined=this.exited?'exited':this.outputClosed?'outputclosed':now-(this.lastOutput??start)>=settle?'idle':now>=deadline?'deadline':undefined;if(reason)return {shot:{frame:this.frame(),ansi:this.ansi},reason};await sleep(10)}}
 resize(cols:number,rows:number){this.pty.resize(cols,rows);this.terminal.resize(cols,rows);this.appendRecord({type:'resize',at_ms:Date.now()-this.recordStart,cols,rows,cell_width:9,cell_height:18})} marker(name:string){if(!this.recordPath)throw Error('session is not recording');this.appendRecord({type:'marker',at_ms:Date.now()-this.recordStart,name})} stop(){if(!this.exited){try{process.kill(-this.process.pid,'SIGTERM')}catch{try{this.process.kill()}catch{}}}this.outputClosed=true;try{this.pty.close()}catch{}}
}
