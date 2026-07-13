// A small, reusable toast layer — the generalization of the old copy badge.
// Anything can fire an ephemeral notice via useToast().show(...); toasts auto-
// dismiss and stack in the top-right, EXCEPT ones given an `at` point (e.g. the
// copy-on-select confirmation) which float right at that spot, like the badge did.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { ACCENT } from "../theme.js"

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface ToastInput {
  message: string
  variant?: ToastVariant
  /** Anchor the toast to a screen cell (e.g. the mouse-release point) instead of
   *  the corner stack. Used by copy-on-select so the confirmation lands at the
   *  cursor. */
  at?: { x: number; y: number }
  /** Auto-dismiss delay; defaults to 1600ms anchored, 2400ms in the corner. */
  ttlMs?: number
}

interface Toast {
  id: number
  message: string
  variant: ToastVariant
  at?: { x: number; y: number }
}

export interface ToastApi {
  show: (input: ToastInput) => void
}

const ToastContext = createContext<ToastApi>({ show: () => {} })

/** Fire ephemeral notices from anywhere under <ToastContext.Provider>. */
export function useToast(): ToastApi {
  return useContext(ToastContext)
}

/** Owns toast state + dismiss timers. Call ONCE (in App), pass `api` to the
 *  provider and `toasts` to <ToastOverlay>. */
export function useToastController(): { toasts: Toast[]; api: ToastApi } {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const show = useCallback((input: ToastInput) => {
    const id = ++idRef.current
    setToasts((prev) => [...prev, { id, message: input.message, variant: input.variant ?? "info", at: input.at }])
    const ttl = input.ttlMs ?? (input.at ? 1600 : 2400)
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      timers.current.delete(id)
    }, ttl)
    timers.current.set(id, timer)
  }, [])

  useEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
    }
  }, [])

  // Stable api so context consumers don't re-render on every stream tick.
  const api = useMemo<ToastApi>(() => ({ show }), [show])
  return { toasts, api }
}

const { BOLD } = TextAttributes

const VARIANT: Record<ToastVariant, { bg: string; fg: string; icon: string }> = {
  success: { bg: "#22c55e", fg: "#04160b", icon: "✓" },
  info: { bg: ACCENT, fg: "#1a1526", icon: "•" },
  warning: { bg: "#eab308", fg: "#241f04", icon: "⚠" },
  error: { bg: "#ef4444", fg: "#2b0707", icon: "✗" },
}

function Pill({ toast }: { toast: Toast }) {
  const v = VARIANT[toast.variant]
  return (
    <box backgroundColor={v.bg} paddingLeft={1} paddingRight={1}>
      <text fg={v.fg} attributes={BOLD}>
        {`${v.icon} ${toast.message}`}
      </text>
    </box>
  )
}

/** Renders the live toasts on top of everything. Mount ONCE inside the root box
 *  (its absolute children position relative to the terminal). */
export function ToastOverlay({ toasts }: { toasts: Toast[] }) {
  const renderer = useRenderer()
  const corner = toasts.filter((t) => !t.at)
  const anchored = toasts.filter((t): t is Toast & { at: { x: number; y: number } } => !!t.at)
  return (
    <>
      {corner.length > 0 && (
        <box position="absolute" top={1} right={2} zIndex={1000} flexDirection="column">
          {corner.map((t, i) => (
            <box key={t.id} marginTop={i === 0 ? 0 : 1}>
              <Pill toast={t} />
            </box>
          ))}
        </box>
      )}
      {anchored.map((t) => {
        const width = t.message.length + 4 // icon + space + padding
        const left = Math.min(Math.max(0, t.at.x + 1), Math.max(0, renderer.terminalWidth - width))
        const top = Math.min(Math.max(0, t.at.y - 1), Math.max(0, renderer.terminalHeight - 1))
        return (
          <box key={t.id} position="absolute" left={left} top={top} zIndex={1001}>
            <Pill toast={t} />
          </box>
        )
      })}
    </>
  )
}

export { ToastContext }
