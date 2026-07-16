import { randomUUID } from "node:crypto"
import type { QueueEntry } from "@chunky/protocol"

export interface PendingPrompt {
  id: string; version: number; prompt: string; shown: string
  images?: { base64: string; mediaType: string }[]
  kind: QueueEntry["kind"]; createdAt: number
}

export class PromptQueue {
  private entries: PendingPrompt[] = []
  constructor(private readonly cap = 20) {}
  enqueue(input: Omit<PendingPrompt, "id" | "version" | "createdAt"> & Partial<Pick<PendingPrompt, "id" | "version" | "createdAt">>): PendingPrompt {
    if (this.entries.length >= this.cap) throw new Error(`prompt queue is full (${this.cap})`)
    const entry = { id: input.id ?? randomUUID(), version: input.version ?? 1, createdAt: input.createdAt ?? Date.now(), ...input } as PendingPrompt
    this.entries.push(entry); return entry
  }
  shift(): PendingPrompt | undefined { return this.entries.shift() }
  get length(): number { return this.entries.length }
  snapshot(): QueueEntry[] { return this.entries.map((e, position) => ({ id: e.id, version: e.version, text: e.prompt, shown: e.shown, kind: e.kind, position, createdAt: e.createdAt })) }
}

export interface PendingInterjection { id: string; text: string; images?: { base64: string; mediaType: string }[] }
export class InterjectionBuffer {
  private entries: PendingInterjection[] = []
  constructor(private readonly cap = 10) {}
  push(entry: PendingInterjection): void { if (this.entries.length >= this.cap) this.entries.shift(); this.entries.push(entry) }
  drainAll(): PendingInterjection[] { const out = this.entries; this.entries = []; return out }
  shift(): PendingInterjection | undefined { return this.entries.shift() }
  clear(): void { this.entries = [] }
  get length(): number { return this.entries.length }
}
export function formatInterjection(text: string): string {
  return `The user sent a message while you were working:\n<user_query>\n${text}\n</user_query>`
}
