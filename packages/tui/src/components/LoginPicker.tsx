import { ThemeText } from "./ThemeText.js"
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
      <ThemeText attributes={TextAttributes.DIM}>Log in to a provider — ↑/↓ move · enter select · esc cancel</ThemeText>
      {providers.map((p, i) => {
        const on = i === selected
        return (
          <box key={p.id} flexDirection="row">
            <ThemeText fg={on ? ACCENT : undefined}>{on ? "❯ " : "  "}</ThemeText>
            <ThemeText fg={on ? ACCENT : undefined} attributes={on ? TextAttributes.BOLD : 0}>
              {p.ready ? "●" : "○"} {p.id}
            </ThemeText>
            <ThemeText attributes={TextAttributes.DIM}>
              {"  — " + p.label}
              {p.ready ? " [logged in]" : ""}
              {p.active ? " (active)" : ""}
            </ThemeText>
          </box>
        )
      })}
    </box>
  )
}
