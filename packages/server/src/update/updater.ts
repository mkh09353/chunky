import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// TODO: change this when Chunky moves repositories.
export const GITHUB_REPOSITORY = "maxheadley/chunky"
export const CHUNKY_DIR = process.env.CHUNKY_DIR || join(homedir(), ".chunky")
export const APP_DIR = join(CHUNKY_DIR, "app")
const STATE_DIR = join(CHUNKY_DIR, "state")

export type ReleaseInfo = { version: string; tarballUrl: string; checksum?: string }
export type UpdateCheck = { current: string; latest: string | null; available: boolean; checkedAt?: number }

function normalize(v: string) { return v.replace(/^v/, "") }
export function currentVersion(): string {
  try { return JSON.parse(readFileSync(join(dirnameApp(), "package.json"), "utf8")).version || "0.1.0" } catch { return "0.1.0" }
}
function dirnameApp() { return existsSync(join(APP_DIR, "package.json")) ? APP_DIR : join(import.meta.dir, "../../../../") }

export async function latestRelease(version?: string): Promise<ReleaseInfo> {
  const endpoint = version ? `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(version.startsWith("v") ? version : `v${version}`)}` : `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`
  const response = await fetch(endpoint, { headers: { accept: "application/vnd.github+json", "user-agent": "chunky-updater" } })
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status})`)
  const release = await response.json() as { tag_name?: string; tarball_url?: string; assets?: Array<{ name: string; browser_download_url: string }> }
  const tar = release.assets?.find((a) => /\.tar\.gz$|\.tgz$/.test(a.name))
  if (!release.tag_name || !tar) throw new Error("release has no tarball asset")
  const checksumAsset = release.assets?.find((a) => a.name === "latest.json")
  let checksum: string | undefined
  if (checksumAsset) {
    const c = await fetch(checksumAsset.browser_download_url).then((r) => r.ok ? r.json() : null) as { sha256?: string } | null
    checksum = c?.sha256
  }
  return { version: normalize(release.tag_name), tarballUrl: tar.browser_download_url, checksum }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = currentVersion()
  try { const release = await latestRelease(); return { current, latest: release.version, available: normalize(release.version) !== normalize(current), checkedAt: Date.now() } }
  catch { return { current, latest: null, available: false, checkedAt: Date.now() } }
}

async function command(args: string[], cwd: string) {
  const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" }); const code = await p.exited
  if (code !== 0) throw new Error(`${args[0]} failed (exit ${code})`)
}
export async function update(version?: string): Promise<ReleaseInfo> {
  mkdirSync(CHUNKY_DIR, { recursive: true }); rmSync(`${APP_DIR}.new`, { recursive: true, force: true }); mkdirSync(`${APP_DIR}.new`, { recursive: true })
  const release = await latestRelease(version)
  const bytes = new Uint8Array(await (await fetch(release.tarballUrl)).arrayBuffer())
  if (release.checksum) { const got = createHash("sha256").update(bytes).digest("hex"); if (got !== release.checksum) throw new Error("release checksum mismatch") }
  const archive = join(CHUNKY_DIR, "update.tar.gz"); await Bun.write(archive, bytes)
  await command(["tar", "-xzf", archive, "--strip-components=1", "-C", `${APP_DIR}.new`], CHUNKY_DIR)
  await command(["bun", "install", "--ignore-scripts"], `${APP_DIR}.new`)
  rmSync(`${APP_DIR}.old`, { recursive: true, force: true })
  if (existsSync(APP_DIR)) renameSync(APP_DIR, `${APP_DIR}.old`)
  renameSync(`${APP_DIR}.new`, APP_DIR); rmSync(archive, { force: true })
  return release
}
export function rollback() {
  if (!existsSync(`${APP_DIR}.old`)) throw new Error("no rollback available")
  const temp = `${APP_DIR}.rollback`; renameSync(APP_DIR, temp); renameSync(`${APP_DIR}.old`, APP_DIR); renameSync(temp, `${APP_DIR}.old`)
}
export function persistCheck(result: UpdateCheck) { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(join(STATE_DIR, "update-check.json"), JSON.stringify(result, null, 2) + "\n") }
export function readPersistedCheck(): UpdateCheck | null { try { return JSON.parse(readFileSync(join(STATE_DIR, "update-check.json"), "utf8")) } catch { return null } }
