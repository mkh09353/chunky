export function encodeMessage(value: unknown): string { return JSON.stringify(value) + '\n'; }
export class LineAccumulator {
  private buffer = '';
  push(chunk: Uint8Array | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    const out: unknown[] = [];
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      if (line.trim()) out.push(JSON.parse(line));
    }
    return out;
  }
  get remainder() { return this.buffer; }
}
