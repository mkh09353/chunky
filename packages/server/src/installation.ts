import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Installation root; CHUNKY_HOME remains the independently configurable state directory. */
export function installationDir(): string {
  return resolve(process.env.CHUNKY_DIR || join(homedir(), ".chunky"))
}
