import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Theme } from "@astryxdesign/core/theme"
import { neutralTheme } from "@astryxdesign/theme-neutral/built"
import "./index.css"
import App from "./App"
import { installComposerRepaintFix } from "./lib/composerRepaintFix"
import { ThemeModeProvider } from "./lib/theme"

installComposerRepaintFix()

// ThemeModeProvider owns the system/light/dark preference and keeps <html>'s
// data-theme + color-scheme in sync; it hands Astryx's <Theme> the already-RESOLVED
// concrete mode. We never pass mode="system" — that would drop data-theme and leave
// color-scheme as the ambiguous `light dark` pair, which is exactly what broke the
// composer's text rendering in WKWebView. See lib/theme.tsx's header comment.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeModeProvider>
      {(resolved) => (
        <Theme theme={neutralTheme} mode={resolved}>
          <App />
        </Theme>
      )}
    </ThemeModeProvider>
  </StrictMode>,
)
