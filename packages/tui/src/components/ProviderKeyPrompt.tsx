import { useState } from "react"
import { ThemeText } from "./ThemeText.js"
import { useInput, usePasteText } from "../useInput.js"
import { ACCENT, WARNING } from "../theme.js"

export type KeyProvider = "telnyx" | "opencode-go"
export function hasKeySetup(id: string): id is KeyProvider {
  return id === "telnyx" || id === "opencode-go"
}

/** Shared by onboarding and provider settings; the secret never enters parent state. */
export function ProviderKeyPrompt({ baseUrl, providerId, onSaved, onCancel }: {
  baseUrl: string
  providerId: KeyProvider
  onSaved: () => Promise<void>
  onCancel: () => void
}) {
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const name = providerId === "telnyx" ? "Telnyx" : "OpenCode Go"
  async function save() {
    if (!apiKey.trim() || busy) return
    setBusy(true); setError(undefined)
    let saved = false
    try {
      const response = await fetch(`${baseUrl}/api/providers/${providerId}/key`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: apiKey.trim() }), signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error("Could not save key")
      saved = true
      setApiKey("")
      await onSaved()
    } catch {
      setError(saved
        ? "Key saved, but refresh failed. Press Esc and select the provider again."
        : `Could not complete ${name} setup. Check your API key and connection, then retry.`)
    } finally { setBusy(false) }
  }
  usePasteText((text) => setApiKey((key) => key + text.replace(/[\r\n]/g, "")), { isActive: !busy })
  useInput((input, key) => {
    if (busy) return
    if (key.escape) { setApiKey(""); onCancel(); return }
    if (key.return) { void save(); return }
    if (key.backspace || key.delete) { setApiKey((value) => value.slice(0, -1)); return }
    if (input && !key.ctrl && !key.meta) setApiKey((value) => value + input)
  })
  return <box flexDirection="column">
    <ThemeText fg={ACCENT}>Connect {name}</ThemeText>
    <ThemeText>{providerId === "telnyx" ? "Paste your API key from portal.telnyx.com. Models refresh from your account." : "Paste your OpenCode Go API key from opencode.ai. Go subscription required."}</ThemeText>
    {providerId === "opencode-go" && <ThemeText>Models refresh from Go. Account access is checked on your first request.</ThemeText>}
    <ThemeText>API key: {"•".repeat(apiKey.length)}▌</ThemeText>
    {error && <ThemeText fg={WARNING}>{error}</ThemeText>}
    <ThemeText>{busy ? (providerId === "telnyx" ? "Verifying API key…" : "Saving API key…") : "Enter saves · Esc back"}</ThemeText>
  </box>
}
