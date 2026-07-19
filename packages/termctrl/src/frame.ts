import type {Terminal} from '@xterm/headless';
export type Color={r:number;g:number;b:number};
export type Attributes={bold:boolean;italic:boolean;faint:boolean;invisible:boolean;strikethrough:boolean;overline:boolean;underline:null|'single'};
export type Cell={x:number;y:number;text:string;width:1|2;foreground:Color;background:Color;attributes:Attributes};
export type Frame={version:1;cols:number;rows:number;foreground:Color;background:Color;cursor:{x:number;y:number;color:Color;blinking:boolean}|null;cells:Cell[]};
const DEFAULT_FG:Color={r:201,g:209,b:217};
const DEFAULT_BG:Color={r:13,g:17,b:23};
const ANSI:Color[]=[
 {r:0,g:0,b:0},{r:205,g:49,b:49},{r:13,g:188,b:121},{r:229,g:229,b:16},{r:36,g:114,b:200},{r:188,g:63,b:188},{r:17,g:168,b:205},{r:229,g:229,b:229},
 {r:102,g:102,b:102},{r:241,g:76,b:76},{r:35,g:209,b:139},{r:245,g:245,b:67},{r:59,g:142,b:234},{r:214,g:112,b:214},{r:41,g:184,b:219},{r:255,g:255,b:255}
];
const palette=(i:number):Color=>{if(i<16)return ANSI[i];if(i>=232){const v=8+(i-232)*10;return {r:v,g:v,b:v}}const c=(v:number)=>v===0?0:55+v*40;const n=i-16;return {r:c(Math.floor(n/36)),g:c(Math.floor(n%36/6)),b:c(n%6)}};
const rgb=(n:number):Color=>({r:(n>>>16)&255,g:(n>>>8)&255,b:n&255});
function cellColor(c:any,fg:boolean):Color {const def=fg?c.isFgDefault():c.isBgDefault();if(def)return fg?DEFAULT_FG:DEFAULT_BG;return (fg?c.isFgRGB():c.isBgRGB())?rgb(fg?c.getFgColor():c.getBgColor()):palette(fg?c.getFgColor():c.getBgColor());}
function attributes(c:any):Attributes{return {bold:!!c.isBold(),italic:!!c.isItalic(),faint:!!c.isDim(),invisible:!!c.isInvisible(),strikethrough:!!c.isStrikethrough(),overline:!!c.isOverline(),underline:c.isUnderline()?'single':null}}
function hasAttrs(a:Attributes){return a.bold||a.italic||a.faint||a.invisible||a.strikethrough||a.overline||a.underline!==null}
export function frameFromTerminal(term:Terminal):Frame {const cols=term.cols,rows=term.rows,cells:Cell[]=[];for(let y=0;y<rows;y++){const line=term.buffer.active.getLine(y);if(!line)continue;for(let x=0;x<cols;x++){const c=line.getCell(x);if(!c||c.getWidth()===0)continue;const text=c.getChars(),a=attributes(c),bg=cellColor(c,false);if(text!==''||bg.r!==DEFAULT_BG.r||bg.g!==DEFAULT_BG.g||bg.b!==DEFAULT_BG.b||hasAttrs(a))cells.push({x,y,text,width:c.getWidth()===2?2:1,foreground:cellColor(c,true),background:bg,attributes:a});}}
 const b=term.buffer.active;return {version:1,cols,rows,foreground:DEFAULT_FG,background:DEFAULT_BG,cursor:{x:b.cursorX,y:b.cursorY,color:DEFAULT_FG,blinking:true},cells};}
export function frameText(term:Terminal):string {const out:string[]=[];for(let y=0;y<term.rows;y++)out.push(term.buffer.active.getLine(y)?.translateToString(true)??'');return out.join('\n').trimEnd();}
