import { RemoveMessage } from "@langchain/core/messages"

type PersistedMessage = {
  id?: string
  tool_calls?: Array<{ id?: string }>
  tool_call_id?: string
  getType?: () => string
  _getType?: () => string
  type?: string
}

export interface InterruptedToolCallRecovery {
  removeMessageIds: string[]
  interruptedCallIds: string[]
}

function messageType(message: PersistedMessage): string | undefined {
  return message.getType?.() ?? message._getType?.() ?? message.type
}

/**
 * Find provider-invalid message batches left behind when a process stops after
 * persisting an assistant tool call but before every matching ToolMessage is
 * checkpointed. A partial parallel batch is removed as one unit: keeping even
 * its completed outputs would leave those outputs orphaned once the assistant
 * message is removed.
 */
export function interruptedToolCallRecovery(
  messages: readonly PersistedMessage[],
): InterruptedToolCallRecovery {
  const validToolMessages = new Set<PersistedMessage>()
  const removeMessageIds = new Set<string>()
  const interruptedCallIds = new Set<string>()

  for (const [index, message] of messages.entries()) {
    const callIds = (message.tool_calls ?? [])
      .map((call) => call.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    if (callIds.length === 0) continue

    const outputs: PersistedMessage[] = []
    for (let next = index + 1; next < messages.length; next++) {
      if (messageType(messages[next]!) !== "tool") break
      outputs.push(messages[next]!)
    }
    const outputIds = outputs.map((output) => output.tool_call_id).filter(Boolean)
    const complete =
      outputs.length === callIds.length &&
      new Set(outputIds).size === callIds.length &&
      callIds.every((id) => outputIds.includes(id))
    if (complete) {
      for (const output of outputs) validToolMessages.add(output)
      continue
    }

    if (message.id) removeMessageIds.add(message.id)
    for (const id of callIds) interruptedCallIds.add(id)
  }

  for (const message of messages) {
    if (messageType(message) !== "tool" || validToolMessages.has(message)) continue
    if (message.tool_call_id) interruptedCallIds.add(message.tool_call_id)
    if (message.id) removeMessageIds.add(message.id)
  }

  return {
    removeMessageIds: [...removeMessageIds],
    interruptedCallIds: [...interruptedCallIds],
  }
}

interface CheckpointedAgent<TStream = unknown> {
  getState?(config: unknown): Promise<{ values?: { messages?: PersistedMessage[] } }>
  updateState?(config: unknown, update: { messages: RemoveMessage[] }): Promise<unknown>
  stream(input: unknown, config: unknown): Promise<TStream>
}

/** Repair persisted message state before a new user input is merged into it. */
export async function streamWithCheckpointRecovery<TStream>(
  agent: CheckpointedAgent<TStream>,
  input: unknown,
  config: unknown,
): Promise<TStream> {
  // Deterministic tests and callers may inject a stream-only agent. Compiled
  // LangGraph agents always expose both checkpoint state methods.
  if (!agent.getState || !agent.updateState) return agent.stream(input, config)
  const state = await agent.getState(config)
  const recovery = interruptedToolCallRecovery(state.values?.messages ?? [])
  if (recovery.removeMessageIds.length > 0) {
    await agent.updateState(config, {
      messages: recovery.removeMessageIds.map((id) => new RemoveMessage({ id })),
    })
    console.warn(
      `[@chunky/server] recovered interrupted tool calls: ${recovery.interruptedCallIds.join(", ")}`,
    )
  }
  return agent.stream(input, config)
}
