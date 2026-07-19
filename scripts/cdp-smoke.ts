#!/usr/bin/env bun
/**
 * Smoke-test the desktop app's built-in browser pane over the Chrome DevTools
 * Protocol.
 *
 * The pane runs on CEF (see packages/app/electrobun.config.ts), which exposes a
 * DevTools listener on 127.0.0.1. This script proves the whole chain end to end:
 * the port is listening, a page target exists, and we can both drive navigation
 * and read state back out of it.
 *
 * USAGE
 *   1. bun run server                      # the harness
 *   2. bun run app:dev                     # the desktop app (CEF build)
 *   3. open the browser pane (globe icon in the TopNav) and let a page load
 *   4. bun run scripts/cdp-smoke.ts        # this script
 *
 * OPTIONS (env)
 *   CHUNKY_CDP_PORT   DevTools port                    (default 9223)
 *   CDP_URL           URL to navigate the pane to      (default example.com)
 *   CHUNKY_URL        harness base URL; when set, the port is discovered from
 *                     GET /api/app/browser instead of the default
 *
 * EXIT CODES
 *   0 success · 1 no CDP listener / no page target / protocol error
 *
 * No dependencies: fetch + Bun's built-in WebSocket only.
 */

const DEFAULT_PORT = Number(process.env.CHUNKY_CDP_PORT || 9223)
const NAV_URL = process.env.CDP_URL || "https://example.com"

/** One CDP target as reported by /json/list. */
interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

/** Ask the harness where the app said its pane is, so this script keeps working
 *  when the port was overridden at build time. Best-effort. */
async function discoverPort(): Promise<number> {
  const harness = process.env.CHUNKY_URL
  if (!harness) return DEFAULT_PORT
  try {
    const res = await fetch(`${harness}/api/app/browser`)
    if (!res.ok) return DEFAULT_PORT
    const body = (await res.json()) as {
      browser?: { cdpPort?: number; debuggable?: boolean; renderer?: string } | null
    }
    const announced = body.browser
    if (!announced?.cdpPort) return DEFAULT_PORT
    if (announced.debuggable === false) {
      console.warn(
        `! harness reports the pane is running on "${announced.renderer}" — no CDP listener expected`,
      )
    }
    console.log(`· discovered port ${announced.cdpPort} from ${harness}/api/app/browser`)
    return announced.cdpPort
  } catch {
    return DEFAULT_PORT
  }
}

/**
 * Minimal CDP client. The protocol is JSON-RPC over a websocket: every request
 * carries a monotonic id and the reply comes back out of order, so responses are
 * matched by id rather than assumed sequential.
 */
class CdpSession {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
      }
      if (msg.id == null) return // an event, not a reply — not needed here
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    })
  }

  static connect(url: string, timeoutMs = 5000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => reject(new Error("websocket connect timed out")), timeoutMs)
      ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new CdpSession(ws))
      })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error(`could not open websocket to ${url}`))
      })
    })
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

async function main(): Promise<number> {
  const port = await discoverPort()
  const base = `http://127.0.0.1:${port}`

  // ---- /json/version -------------------------------------------------------
  let version: Record<string, string>
  try {
    const res = await fetch(`${base}/json/version`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    version = (await res.json()) as Record<string, string>
  } catch (err) {
    console.error(`✗ no CDP listener on ${base} — ${(err as Error).message}`)
    console.error("  Is the app running a CEF build with the browser pane open?")
    console.error("  Check the app log for: 'browser pane: CEF, CDP on …'")
    return 1
  }
  console.log(`✓ ${base}/json/version`)
  console.log(`  Browser:        ${version.Browser ?? "?"}`)
  console.log(`  Protocol:       ${version["Protocol-Version"] ?? "?"}`)
  console.log(`  User-Agent:     ${version["User-Agent"] ?? "?"}`)

  // ---- /json/list ----------------------------------------------------------
  const targets = (await (await fetch(`${base}/json/list`)).json()) as CdpTarget[]
  console.log(`\n✓ ${base}/json/list — ${targets.length} target(s)`)
  for (const t of targets) {
    console.log(`  [${t.type}] ${t.title || "(untitled)"}`)
    console.log(`         ${t.url}`)
  }

  // The pane is a normal page target. Skip devtools:// pages, which are the
  // inspector's own UI rather than user content.
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"))
  if (!page?.webSocketDebuggerUrl) {
    console.error("\n✗ no page target with a websocket debugger URL")
    console.error("  Open the browser pane in the app and let a page load first.")
    return 1
  }
  console.log(`\n· driving target: ${page.title || page.url}`)

  // ---- drive it ------------------------------------------------------------
  const cdp = await CdpSession.connect(page.webSocketDebuggerUrl)
  try {
    await cdp.send("Page.enable")
    await cdp.send("Runtime.enable")

    const before = (await cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result?: { value?: string } }
    console.log(`  title before:   ${JSON.stringify(before.result?.value ?? null)}`)

    console.log(`\n· Page.navigate → ${NAV_URL}`)
    const nav = (await cdp.send("Page.navigate", { url: NAV_URL })) as {
      frameId?: string
      errorText?: string
    }
    if (nav.errorText) {
      console.error(`✗ navigation failed: ${nav.errorText}`)
      return 1
    }

    // Page.navigate resolves when the navigation is *committed*, not when the
    // document is ready, so poll for the title rather than racing it.
    let title: string | null = null
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const res = (await cdp.send("Runtime.evaluate", {
        expression: "document.readyState === 'complete' ? document.title : null",
        returnByValue: true,
      })) as { result?: { value?: string | null } }
      if (res.result?.value) {
        title = res.result.value
        break
      }
    }

    if (title == null) {
      console.error("✗ page did not finish loading within 10s")
      return 1
    }

    const href = (await cdp.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    })) as { result?: { value?: string } }

    console.log(`\n✓ Runtime.evaluate("document.title") → ${JSON.stringify(title)}`)
    console.log(`  location.href:  ${href.result?.value ?? "?"}`)
    console.log("\n✓ CDP smoke test passed — the pane is agent-controllable.")
    return 0
  } finally {
    cdp.close()
  }
}

// Not top-level `await`: this file has no imports, so TS treats it as a script
// rather than a module, where top-level await isn't allowed (TS1375).
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`✗ ${(err as Error).message}`)
    process.exit(1)
  },
)
