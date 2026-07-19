import type { ElectrobunConfig } from "electrobun/bun"

// CDP port for the built-in browser pane's CEF webview.
//
// 9222 is Chrome/Chromium's own default, so a user with a real debuggable
// Chrome running would collide; 9223 keeps us out of its way. Read at BUILD
// time (this config is evaluated by the electrobun CLI, which bakes the flags
// into the bundle's Resources/build.json), so overriding it means rebuilding:
//   CHUNKY_CDP_PORT=9444 bun run app:dev
// The bun process reads the same env var to report the port it expects, so the
// two stay in agreement.
const CDP_PORT = process.env.CHUNKY_CDP_PORT || "9223"

export default {
  app: {
    name: "Chunky",
    identifier: "com.chunky.app",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      "dist/chunky-config.json": "views/mainview/chunky-config.json",
    },
    watchIgnore: ["dist/**"],
    mac: {
      // Bundles Chromium (CEF) ALONGSIDE the system WebView — it does not
      // replace it. `defaultRenderer` is deliberately left unset, so it stays
      // "native": the main UI window keeps running on WKWebView and only the
      // browser pane opts into CEF (renderer: "cef" on its <electrobun-webview>).
      // This is what makes the pane CDP-controllable while the app chrome keeps
      // WKWebView's lower memory footprint.
      //
      // COST: the electrobun CLI downloads a CEF tarball from GitHub releases on
      // the first build that needs it (hundreds of MB, cached under
      // node_modules/.../electrobun/dist-macos-arm64/cef) and copies the
      // framework into the .app. Expect a much slower first build and a far
      // larger bundle.
      bundleCEF: true,
      chromiumFlags: {
        // Chrome DevTools Protocol endpoint for the pane. Agent tooling drives
        // the pane through this (see scripts/cdp-smoke.ts).
        "remote-debugging-port": CDP_PORT,
        // Chromium already defaults the DevTools listener to loopback, but bind
        // it explicitly: this port exposes full page control, and an accidental
        // 0.0.0.0 bind would hand that to the local network.
        "remote-debugging-address": "127.0.0.1",
      },
    },
    // Left on the system WebView: CEF is only wired up and verified for macOS
    // here, and enabling it elsewhere would impose the same large download on
    // platforms nothing has tested yet.
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig
