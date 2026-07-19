export type KeyName = 'enter'|'escape'|'up'|'down'|'left'|'right'|'tab'|'shift-tab'|'backspace'|'delete'|'home'|'end'|'page-up'|'page-down';
export const KEY_BYTES: Record<KeyName, Uint8Array> = {
 enter: Uint8Array.from([13]), escape: Uint8Array.from([27]), up: Uint8Array.from([27,91,65]), down: Uint8Array.from([27,91,66]), left: Uint8Array.from([27,91,68]), right: Uint8Array.from([27,91,67]), tab: Uint8Array.from([9]), 'shift-tab': Uint8Array.from([27,91,90]), backspace: Uint8Array.from([127]), delete: Uint8Array.from([27,91,51,126]), home: Uint8Array.from([27,91,72]), end: Uint8Array.from([27,91,70]), 'page-up': Uint8Array.from([27,91,53,126]), 'page-down': Uint8Array.from([27,91,54,126])
};
export function encodeInput(atom: string): Uint8Array {
 if (atom.startsWith('text:')) return new TextEncoder().encode(atom.slice(5));
 const c = atom.match(/^ctrl[-:]([a-z])$/i); if (c) return Uint8Array.from([c[1].toUpperCase().charCodeAt(0)-64]);
 const b = KEY_BYTES[atom as KeyName]; if (b) return b;
 throw new Error(`unsupported input event ${JSON.stringify(atom)}`);
}
export function concatBytes(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let i=0; for(const p of parts){out.set(p,i);i+=p.length;} return out; }
