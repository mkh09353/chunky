// In-app modals, sharing the onboarding wizard's backdrop/panel look.
//
// These replace the native `window.confirm` the cache guard used to use: a
// blocking OS dialog reads as foreign chrome in a frameless, custom-titlebar
// app (and can't be styled or driven from a test).
import { useEffect, useRef } from "react"

/** Esc-to-dismiss + focus the primary control on mount. Shared by both modals. */
function useModalKeys(onDismiss: () => void, focusRef: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // The composer's own Esc handling (stop the run / clear a queued skill)
      // must not also fire while a modal owns the screen.
      e.preventDefault()
      e.stopPropagation()
      onDismiss()
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onDismiss])

  useEffect(() => {
    focusRef.current?.focus()
  }, [focusRef])
}

/**
 * A yes/no confirmation. Resolved by the caller's `onConfirm`/`onCancel` — see
 * App's `askConfirm`, which wraps this in a promise so an async flow (the
 * cache-guard send) can await the answer inline.
 */
export function ConfirmModal({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useModalKeys(onCancel, confirmRef)

  return (
    <div
      className="chunky-onboarding-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <section
        className="chunky-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chunky-modal-title"
        aria-describedby="chunky-modal-body"
      >
        <h2 id="chunky-modal-title">{title}</h2>
        <p id="chunky-modal-body" className="chunky-onboarding-muted">
          {body}
        </p>
        <div className="chunky-onboarding-actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="chunky-onboarding-primary"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

/**
 * An indeterminate "waiting on something external" modal with a Cancel — used
 * while `/login` polls for the browser loopback callback, which otherwise sat
 * for 150s with no way out and no sign it was still going.
 */
export function WaitModal({
  title,
  body,
  cancelLabel = "Cancel",
  onCancel,
}: {
  title: string
  body: string
  cancelLabel?: string
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useModalKeys(onCancel, cancelRef)

  return (
    // No backdrop-click dismissal: cancelling a sign-in should be deliberate.
    <div className="chunky-onboarding-backdrop">
      <section
        className="chunky-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chunky-wait-title"
      >
        <h2 id="chunky-wait-title">{title}</h2>
        <p className="chunky-onboarding-muted" role="status">
          <span className="chunky-wait-dot" aria-hidden="true" />
          {body}
        </p>
        <div className="chunky-onboarding-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
