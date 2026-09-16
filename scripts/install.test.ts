import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, realpathSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const root = realpathSync(mkdtempSync(join(tmpdir(), "chunky-install-")))
const home = join(root, "home")
const bin = join(root, "bin")
const source = join(root, "source")
mkdirSync(join(source, "scripts"), { recursive: true })
mkdirSync(home)
mkdirSync(bin)
for (const name of ["install.sh", "get.sh"]) cpSync(join(import.meta.dir, name), join(source, "scripts", name))
writeFileSync(join(source, "package.json"), '{"version":"1.0.0"}')
writeFileSync(join(source, "chunky.ts"), 'console.log(JSON.stringify({dir:process.env.CHUNKY_DIR, home:process.env.CHUNKY_HOME, command:process.env.CHUNKY_COMMAND, args:process.argv.slice(2)}))')
function executable(name: string, body: string) { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }) }
executable("bun", 'if [ "$1" = install ]; then exit 0; fi\nexec "$REAL_BUN" "$@"')
executable("uname", 'echo Test') // No platform SDK is needed by the fixture.
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, REAL_BUN: process.execPath, CHUNKY_BIN_DIR: bin, CHUNKY_DIR: "", CHUNKY_COMMAND: "", CHUNKY_HOME: "" }
async function run(args: string[], extra = {}) {
  const p = Bun.spawn(args, { env: { ...env, ...extra }, cwd: root, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  expect(code, err || out).toBe(0)
  return out
}
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("custom installers preserve command, root, arguments, and independent state", async () => {
  const custom = join(home, "work space ' $literal `literal`")
  await run(["bash", join(source, "scripts/install.sh")])
  await run(["bash", join(source, "scripts/install.sh"), "--name", "baa_chunky", "--dir", custom])
  writeFileSync(join(custom, "state", "marker"), "work")
  const personal = readFileSync(join(bin, "chunky"), "utf8")
  const launch = JSON.parse(await run([join(bin, "baa_chunky"), "update", "--check"], { CHUNKY_DIR: "/wrong", CHUNKY_HOME: "/wrong" }))
  expect(launch).toEqual({ dir: custom, home: join(custom, "state"), command: "baa_chunky", args: ["update", "--check"] })
  // Reinstall by directory alone remembers the name.
  await run(["bash", join(source, "scripts/install.sh"), "--dir", custom])
  expect(readFileSync(join(bin, "chunky"), "utf8")).toBe(personal)
  expect(readFileSync(join(custom, "state", "marker"), "utf8")).toBe("work")

  // Exercise the standalone downloadable installer with a local release archive.
  const archive = join(root, "release.tgz")
  await run(["tar", "-czf", archive, "-C", root, "source"])
  executable("curl", 'case "$*" in\n *releases/latest*) printf \'%s\' \'{"tag_name":"v1.0.0","assets":[{"name":"release.tgz","browser_download_url":"https://fixture/release.tgz"}]}\' ;;\n *) while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp "$FIXTURE_ARCHIVE" "$2"; exit; fi; shift; done; exit 1 ;;\nesac')
  await run(["bash", join(source, "scripts/get.sh"), "--dir", custom], { FIXTURE_ARCHIVE: archive })
  expect(JSON.parse(await run([join(bin, "baa_chunky")])).dir).toBe(custom)
  expect(readFileSync(join(bin, "chunky"), "utf8")).toBe(personal)
  expect(readFileSync(join(custom, "state", "marker"), "utf8")).toBe("work")
}, 30_000)

test("invalid arguments fail before touching an installation", async () => {
  for (const script of ["install.sh", "get.sh"]) {
    for (const args of [["--name", "../chunky"], ["--dir"], ["--unknown"], ["--dir", "/"]]) {
      const p = Bun.spawn(["bash", join(source, "scripts", script), ...args], { env, stdout: "ignore", stderr: "ignore" })
      expect(await p.exited).not.toBe(0)
    }
  }
  expect(existsSync(join(root, "literal"))).toBe(false)
})

test("update and rollback affect only the selected installation", async () => {
  const custom = join(root, "update-work")
  const personal = join(home, ".chunky", "app", "package.json")
  mkdirSync(join(home, ".chunky", "app"), { recursive: true })
  writeFileSync(personal, '{"version":"personal"}')
  const before = readFileSync(personal, "utf8")
  mkdirSync(join(custom, "app"), { recursive: true })
  mkdirSync(join(custom, "state"))
  writeFileSync(join(custom, "app/package.json"), '{"version":"0.9.0"}')
  writeFileSync(join(custom, "state/marker"), "keep")
  const archive = join(root, "updater-release.tgz")
  await run(["tar", "-czf", archive, "-C", root, "source"])
  const updater = join(import.meta.dir, "../packages/server/src/update/updater.ts")
  const script = join(root, "update-test.ts")
  writeFileSync(script, `
    import { update, rollback, currentVersion } from ${JSON.stringify(updater)};
    const archive = await Bun.file(process.env.FIXTURE_ARCHIVE!).arrayBuffer();
    globalThis.fetch = async (url) => String(url).includes('api.github.com')
      ? Response.json({tag_name:'v1.0.0',assets:[{name:'release.tgz',browser_download_url:'https://fixture/release.tgz'}]})
      : new Response(archive);
    await update();
    if (currentVersion() !== '1.0.0') throw Error('update missed target');
    rollback();
    if (currentVersion() !== '0.9.0') throw Error('rollback missed target');
  `)
  await run([process.execPath, script], { CHUNKY_DIR: custom, FIXTURE_ARCHIVE: archive })
  expect(readFileSync(personal, "utf8")).toBe(before)
  expect(readFileSync(join(custom, "state/marker"), "utf8")).toBe("keep")
})

test("custom user skills and workflows keep other auto-discovery", async () => {
  const custom = join(root, "skill-work")
  function skill(path: string, name: string) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nfixture`)
  }
  skill(join(custom, "skills/work"), "work-fixture")
  skill(join(home, ".chunky/skills/personal"), "personal-fixture")
  skill(join(home, ".agents/skills/shared"), "shared-fixture")
  const workspace = join(home, "workspace")
  mkdirSync(workspace)
  const script = join(root, "skills-test.ts")
  writeFileSync(script, `
    import { discoverSkills } from ${JSON.stringify(join(import.meta.dir, "../packages/server/src/skills.ts"))};
    import { userWorkflowsDir } from ${JSON.stringify(join(import.meta.dir, "../packages/server/src/workflow/registry.ts"))};
    console.log(JSON.stringify({names:discoverSkills(${JSON.stringify(workspace)}).map(s=>s.name), workflows:userWorkflowsDir()}));
  `)
  const result = JSON.parse(await run([process.execPath, script], { CHUNKY_DIR: custom, CHUNKY_SETTINGS: join(custom, "state/settings.json") }))
  expect(result.names).toContain("work-fixture")
  expect(result.names).toContain("shared-fixture")
  expect(result.names).not.toContain("personal-fixture")
  expect(result.workflows).toBe(join(custom, "workflows"))
})

test("private Bun is available to launcher children without a global Bun", async () => {
  const custom = join(root, "private-bun")
  await run(["bash", join(source, "scripts/install.sh"), "--dir", custom, "--name", "private_chunky"])
  mkdirSync(join(custom, "bun/bin"), { recursive: true })
  cpSync(join(bin, "bun"), join(custom, "bun/bin/bun"))
  writeFileSync(join(custom, "app/chunky.ts"), 'console.log(Bun.which("bun"))')
  expect((await run([join(bin, "private_chunky")], { PATH: "/usr/bin:/bin" })).trim()).toBe(join(custom, "bun/bin/bun"))
})

test("codegraph caches use the selected state directory", async () => {
  const state = join(root, "graph-state")
  const workspace = join(root, "graph-workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, "main.ts"), "function workSymbol() {}")
  await run(["git", "init", "-q", workspace])
  await run(["git", "-C", workspace, "add", "."])
  const script = join(root, "graph-test.ts")
  writeFileSync(script, `
    import {getCodegraph, destroyCodegraphs} from ${JSON.stringify(join(import.meta.dir, "../packages/server/src/codegraph/index.ts"))};
    await getCodegraph(${JSON.stringify(workspace)}).query('workSymbol', false);
    destroyCodegraphs();
  `)
  await run([process.execPath, script], { CHUNKY_SETTINGS: join(state, "settings.json") })
  expect(readdirSync(join(state, "codegraph"))).toHaveLength(1)
  expect(existsSync(join(home, ".chunky/state/codegraph"))).toBe(false)
})

test("environment configuration works and explicit flags take precedence", async () => {
  const configured = join(root, "env-install")
  const overridden = join(root, "flag-install")
  const config = { CHUNKY_DIR: configured, CHUNKY_COMMAND: "env_chunky" }
  await run(["bash", join(source, "scripts/install.sh")], config)
  expect(JSON.parse(await run([join(bin, "env_chunky")])).dir).toBe(configured)
  await run(["bash", join(source, "scripts/install.sh"), "--dir", overridden, "--name", "flag_chunky"], config)
  expect(JSON.parse(await run([join(bin, "flag_chunky")])).dir).toBe(overridden)
  expect(JSON.parse(await run([join(bin, "env_chunky")])).dir).toBe(configured)
})
