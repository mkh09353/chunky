import { TextAttributes } from "@opentui/core"
import { ACCENT, BORDER } from "../theme.js"

export interface ProviderRow {
  id: string
  label: string
  ready: boolean
  active: boolean
}

/**
 * Arrow-navigable provider picker shown by /login. ↑/↓ move, enter initiates the
 * login for the highlighted provider, esc cancels. Styled like the slash menu.
 */
export function LoginPicker({ providers, selected }: { providers: ProviderRow[]; selected: number }) {
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={BORDER} paddingX={1} marginBottom={1}>
      <text attributes={TextAttributes.DIM}>Log in to a provider — ↑/↓ move · enter select · esc cancel</text>
      {providers.map((p, i) => {
        const on = i === selected
        return (
          <box key={p.id} flexDirection="row">
            <text fg={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</text>
            <text fg={on ? ACCENT : undefined} attributes={on ? TextAttributes.BOLD : 0}>
              {p.ready ? "●" : "○"} {p.id}
            </text>
            <text attributes={TextAttributes.DIM}>
              {"  — " + p.label}
              {p.ready ? " [logged in]" : ""}
              {p.active ? " (active)" : ""}
            </text>
          </box>
        )
      })}
    </box>
  )
}
