import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { integrationServerEnvironment, reserveIntegrationServer } from "./test-server.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

test("scrubs inherited launcher identity and gives tests isolated paths", () => {
  const env = integrationServerEnvironment({ prefix: "chunky-test-server-", env: {
    CHUNKY_SERVER_NONCE: "inherited", CHUNKY_SERVER_ID: "inherited", CHUNKY_DISCOVERY_RECORD: "inherited",
    CHUNKY_BUILD_ID: "inherited", CHUNKY_VERSION: "inherited",
  } }, "/tmp/chunky-test-server", 5123)
  for (const key of ["CHUNKY_SERVER_NONCE", "CHUNKY_SERVER_ID", "CHUNKY_DISCOVERY_RECORD", "CHUNKY_BUILD_ID", "CHUNKY_VERSION"]) expect(env[key]).toBeUndefined()
  expect(env.CHUNKY_TEST_PARENT_PID).toBe(String(process.pid))
  expect(env.CHUNKY_DB).toBe("/tmp/chunky-test-server/chunky.db")
})

test("stop is idempotent and removes state after terminating its child", async () => {
  const server = reserveIntegrationServer({ prefix: "chunky-test-server-" })
  cleanups.push(server.stop)
  const proc = await server.start()
  await server.stop()
  expect(existsSync(server.root)).toBe(false)
  await server.stop()
}, 15_000)
