import { expect, test } from "bun:test"
import { getAppBrowserEndpoint, resetAppBrowserEndpoint, setAppBrowserEndpoint } from "./app-browser.ts"

test("app browser endpoint state validates and resets", () => {
  resetAppBrowserEndpoint()
  expect(getAppBrowserEndpoint()).toBeNull()
  setAppBrowserEndpoint({ cdpPort: 9223, renderer: "cef", debuggable: true })
  expect(getAppBrowserEndpoint()?.cdpUrl).toBe("http://127.0.0.1:9223")
  resetAppBrowserEndpoint()
  expect(getAppBrowserEndpoint()).toBeNull()
})
