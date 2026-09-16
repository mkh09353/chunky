import type { TextProps } from "@opentui/react"
import { TEXT } from "../theme.js"

/** Supply the theme's foreground whenever a component has no explicit color. */
export function ThemeText({ fg, ...props }: TextProps) {
  return <text {...props} fg={fg ?? TEXT} />
}
