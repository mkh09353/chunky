import type { AgentEvent } from "@chunky/protocol"

export type Emit = (event: AgentEvent) => void

/** Tag message/tool/error events with a child thread id; root events remain flat. */
export function taggedEmitter(emit: Emit, threadId: string | undefined): Emit {
  return (event) => emit(threadId ? ({ ...event, threadId } as AgentEvent) : event)
}
