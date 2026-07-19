#!/usr/bin/env bun
import {Session} from './session.ts';
import {encodeInput,concatBytes} from './keys.ts';
import {ensureDir,socketPath,request,serve,dir} from './daemon.ts';
import {writeFileSync,readFileSync,existsSync,unlinkSync,readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {basename,resolve} from 'node:path';
import {Terminal} from '@xterm/headless';
import {frameFromTerminal} from './frame.ts';
import {svg,png} from './render.ts';
import {readRecording,markerTimes} from './recording.ts';
import {exportVideo} from './video.ts';
import {runMcpServer,frameToText} from './mcp.ts';
const args=Bun.argv.slice(2),verb=args.shift();
const flag=(n:string,d?:string)=>{let i=args.indexOf(n);if(i<0)return d;const v=args[i+1];args.splice(i,v&&!v.startsWith('-')?2:1);return v??'true'};
const has=(n:string)=>args.includes(n); const num=(n:string,d:number)=>Number(flag(n,String(d)));
const command=()=>{const i=args.indexOf('--');return i>=0?args.slice(i+1):args.filter(x=>!x.startsWith('-'))};
const atoms=(xs:string[])=>concatBytes(xs.map(encodeInput));
const renderOpts=()=>({cellWidth:num('--cell-width',9),cellHeight:num('--cell-height',18),padding:num('--padding',18),fontFamily:flag('--font-family'),pixelRatio:num('--pixel-ratio',2)});
async function replay(path:string,cut?:number){const r=await readRecording(path);const t=new Terminal({cols:r.header.cols,rows:r.header.rows,scrollback:1000});for(const e of r.events){if(cut!==undefined&&e.at_ms>cut)break;if(e.type==='output')t.write(Uint8Array.from(e.bytes));else if(e.type==='resize'){t.resize(e.cols,e.rows)}}await new Promise(r=>setTimeout(r,0));return {frame:frameFromTerminal(t),header:r.header,ansi:new Uint8Array()};}
function cutoff(path:string){const m=flag('--at-marker');const ms=flag('--at-ms');return (async()=>{if(m){const r=await readRecording(path), x=markerTimes(r.events).get(m);if(x===undefined)throw Error(`unknown marker: ${m}`);return x}return ms===undefined?undefined:Number(ms)})();}
function outputFrame(c:any,f:string){if(f==='json')return JSON.stringify(c.frame,null,2);if(f==='txt')return frameToText(c.frame)+'\n';return ''}
async function captureNamed(name:string|undefined){if(name)return request(name,{method:'capture',settle_ms:250,deadline_ms:5000});const s=new Session(command(),{cols:num('--cols',80),rows:num('--rows',24),cwd:flag('--cwd')});const x=await s.capture(num('--settle-ms',250),num('--deadline-ms',5000));return {...x,one:s};}
async function main(){ensureDir();switch(verb){case'mcp':await runMcpServer();break;
case'show':{const rec=flag('--recording');const name=args[0]&&!args[0].startsWith('-')?args.shift():undefined;const f=flag('--format','txt')!;let c:any;if(rec)c=await replay(rec,await cutoff(rec));else c=await captureNamed(name);process.stdout.write(rec?outputFrame(c,f):(f==='json'?JSON.stringify(c.shot.frame,null,2):f==='ansi'?new TextDecoder().decode(Uint8Array.from(c.shot.ansi)):frameToText(c.shot.frame)+'\n'));if(c.one)c.one.stop();break}
case'save':{const rec=flag('--recording');const name=args[0]&&!args[0].startsWith('-')?args.shift():undefined;const out=flag('--out');if(!out)throw Error('--out required');const fs:string[]=[];while(has('--format'))fs.push(flag('--format')!);const ro=renderOpts();let c:any=rec?await replay(rec,await cutoff(rec)):await captureNamed(name);for(const f of fs){const p=out+'.'+f;const data=f==='svg'?svg(c.frame??c.shot.frame,ro):f==='png'?png(c.frame??c.shot.frame,ro):f==='json'?JSON.stringify(c.frame??c.shot.frame,null,2):f==='ansi'?Buffer.from(c.shot.ansi):(frameToText(c.frame??c.shot.frame)+'\n');writeFileSync(p,data);console.log(p)}if(c.one)c.one.stop();break}
case'video':{const recording=args.shift();if(!recording)throw Error('recording required');const edit=flag('--edit');const ro=renderOpts();const out=flag('--out')??flag('-o','video.mp4');const x=await exportVideo(recording,{out,fps:num('--fps',20),tailMs:num('--tail-ms',1000),includeStartup:has('--include-startup'),hideCursor:has('--hide-cursor'),edit:edit?JSON.parse(edit.startsWith('@')?readFileSync(edit.slice(1),'utf8'):edit):undefined,...ro});console.log(x.out);break}
case'start':{const n=args.shift()!;try{if(existsSync(socketPath(n)))unlinkSync(socketPath(n))}catch{};const l={command:command(),cwd:resolve(flag('--cwd',process.cwd())!),cols:num('--cols',80),rows:num('--rows',24),max_bytes:num('--max-bytes',16777216),cell_width:num('--cell-width',9),cell_height:num('--cell-height',18),record:flag('--record'),color:flag('--color'),opentui_host:flag('--host')};const ch=spawn(process.execPath,[import.meta.filename,'__serve',n],{detached:true,stdio:'ignore',env:{...process.env,TERMCTRL_LAUNCH:JSON.stringify(l)}});ch.unref();for(let i=0;i<200;i++){try{await request(n,{method:'ping'});break}catch{await new Promise(r=>setTimeout(r,10))}}break}
case'restart':{const n=args.shift()!;const old=await request(n,{method:'status'});await request(n,{method:'stop'}).catch(()=>{});for(let i=0;i<100&&existsSync(socketPath(n));i++)await new Promise(r=>setTimeout(r,10));const l=old.launch;const overrides:any={cols:num('--cols',l.cols),rows:num('--rows',l.rows),cell_width:num('--cell-width',l.cell_width),cell_height:num('--cell-height',l.cell_height),max_bytes:num('--max-bytes',l.max_bytes),cwd:resolve(flag('--cwd',l.cwd)!),record:flag('--record',l.record),color:flag('--color',l.color),opentui_host:flag('--host',l.opentui_host)};l.command=command().length?command():l.command;Object.assign(l,overrides);const ch=spawn(process.execPath,[import.meta.filename,'__serve',n],{detached:true,stdio:'ignore',env:{...process.env,TERMCTRL_LAUNCH:JSON.stringify(l)}});ch.unref();for(let i=0;i<200;i++){try{await request(n,{method:'ping'});break}catch{await new Promise(r=>setTimeout(r,10))}}break}
case'__serve':serve(socketPath(args.shift()!),JSON.parse(process.env.TERMCTRL_LAUNCH!));await new Promise(()=>{});break;
case'wait':await request(args.shift()!,{method:'wait',text:args.shift(),timeout_ms:num('--timeout',5000)});break;
case'send':{const n=args.shift()!;if(has('--stdin'))await request(n,{method:'send',bytes:Array.from(new Uint8Array(await new Response(Bun.stdin).arrayBuffer()))});else await request(n,{method:'send',bytes:Array.from(atoms(args))});break}
case'status':{const x=await request(args.shift()!,{method:'status'});console.log(has('--json')?JSON.stringify(x,null,2):x.state);break}
case'logs':process.stdout.write(Buffer.from(await request(args.shift()!,{method:'logs'})));break;
case'resize':await request(args.shift()!,{method:'resize',cols:num('--cols',80),rows:num('--rows',24)});break;
case'mark':await request(args.shift()!,{method:'mark',name:args.shift()!});break;
case'markers':{const r=await readRecording(args.shift()!);for(const e of r.events)if(e.type==='marker')console.log(`${e.at_ms}\t${e.name}`);break}
case'run':{const s=new Session(command(),{cols:num('--cols',80),rows:num('--rows',24),cwd:flag('--cwd')});const input:any=process.stdin;const oldRaw=input.isTTY?input.isRaw:false;const oldResume=input.isPaused?.();s.onOutput=(bytes)=>process.stdout.write(bytes);if(input.isTTY){input.setRawMode(true);input.resume()}const onData=(b:Buffer)=>s.send(new Uint8Array(b));input.on('data',onData);try{await s.process.exited}finally{input.off('data',onData);if(input.isTTY){input.setRawMode(!!oldRaw);if(oldResume)input.pause()}s.stop()}break}
case'stop':await request(args.shift()!,{method:'stop'});break;
case'list':{const xs=[];for(const x of readdirSync(dir).filter(x=>x.endsWith('.sock'))){const n=x.slice(0,-5);try{xs.push({name:n,status:await request(n,{method:'status'})})}catch{}}console.log(JSON.stringify(xs,null,2));break}
default:throw Error('usage: termctrl show|save|video|mcp|start|restart|run|wait|send|status|list|resize|logs|mark|markers|stop')}}main().catch(e=>{console.error(e.message);process.exit(1)});
