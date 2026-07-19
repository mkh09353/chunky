import { describe, expect, test } from "bun:test"
import { interestingOutline, validateHttpUrl, type CdpNode } from "./cdp.ts"

describe("browser CDP pure helpers", () => {
  test("validates navigation URLs", () => {
    expect(validateHttpUrl("https://example.com")).toBeNull()
    expect(validateHttpUrl("http://localhost:4599")).toBeNull()
    expect(validateHttpUrl("file:///tmp/x")).toBe("URL must use http or https")
    expect(validateHttpUrl("not a url")).toBe("URL must be a valid http(s) URL")
  })
  test("renders interesting accessibility nodes and refs", () => {
    const nodes: CdpNode[] = [
      { backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Save" } },
      { backendDOMNodeId: 2, role: { value: "textbox" }, name: { value: "Name" }, value: { value: "Ada" } },
      { backendDOMNodeId: 3, role: { value: "generic" }, name: { value: "" } },
    ]
    const result = interestingOutline(nodes)
    expect(result.text).toContain('button "Save" [e1]')
    expect(result.text).toContain('textbox "Name" value="Ada" [e2]')
    expect(result.refs.get("e1")).toBe(1)
    expect(result.refs.get("e2")).toBe(2)
  })
})
