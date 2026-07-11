/// <reference types="vite/client" />

// Electrobun injects these into the webview. Only present inside the packaged
// app; used by lib/pickFolder.ts to detect the native RPC bridge.
interface Window {
  __electrobunRpcSocketPort?: number
  __electrobunWebviewId?: number
}
