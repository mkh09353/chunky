// Unit tests for lazy Agent Skills discovery + load/search tools.
// Run: bun test packages/server/src/skills.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  discoverSkills,
  findSkillFiles,
  formatLoadResult,
  formatSearchResults,
  loadSkill,
  parseSkillMarkdown,
  projectAncestors,
  searchSkills,
} from "./skills.ts"
import { loadSkillTool, searchSkillsTool } from "./tools/skills.ts"

const ROOT = join(tmpdir(), `chunky-skills-test-${process.pid}`)

function wipe() {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* ok */
  }
}

function skillDir(base: string, name: string, fm: { name?: string; description: string }, body: string) {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  const nameLine = fm.name !== undefined ? `name: ${fm.name}\n` : ""
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\n${nameLine}description: ${fm.description}\n---\n\n${body}\n`,
  )
  return dir
}

afterEach(() => {
  wipe()
})

describe("parseSkillMarkdown", () => {
  test("extracts name, description, and body", () => {
    const { frontmatter, body } = parseSkillMarkdown(
      `---\nname: pdf-tools\ndescription: Work with PDFs\n---\n\n# PDF\n\nDo stuff.\n`,
    )
    expect(frontmatter.name).toBe("pdf-tools")
    expect(frontmatter.description).toBe("Work with PDFs")
    expect(body).toContain("# PDF")
    expect(body).toContain("Do stuff.")
  })

  test("handles missing frontmatter", () => {
    const { frontmatter, body } = parseSkillMarkdown("# just body")
    expect(frontmatter).toEqual({})
    expect(body).toBe("# just body")
  })

  test("handles multiline description", () => {
    const { frontmatter } = parseSkillMarkdown(
      `---\nname: multi\ndescription: >\n  line one\n  line two\n---\n\nbody\n`,
    )
    expect(frontmatter.name).toBe("multi")
    expect(String(frontmatter.description)).toContain("line one")
    expect(String(frontmatter.description)).toContain("line two")
  })
})

describe("findSkillFiles / discoverSkills", () => {
  test("finds nested SKILL.md and treats skill root as leaf", () => {
    const root = join(ROOT, "skills-root")
    skillDir(root, "alpha", { name: "alpha", description: "Alpha skill" }, "alpha body")
    // Nested under a non-skill dir
    skillDir(join(root, "group"), "beta", { name: "beta", description: "Beta skill" }, "beta body")
    // Nested SKILL under a skill root should NOT be found as separate skill
    mkdirSync(join(root, "alpha", "nested"), { recursive: true })
    writeFileSync(join(root, "alpha", "nested", "SKILL.md"), "---\nname: nested\ndescription: x\n---\n")

    const files = findSkillFiles(root)
    expect(files.some((f) => f.endsWith(join("alpha", "SKILL.md")))).toBe(true)
    expect(files.some((f) => f.includes(join("group", "beta")))).toBe(true)
    expect(files.some((f) => f.includes("nested"))).toBe(false)
  })

  test("project skills override user skills of the same name", () => {
    // Point discovery at a fake home by only using project roots under ROOT.
    // discoverSkills always scans real home — so we test project overwrite via
    // two project ancestor levels instead: nearer project wins.
    const far = join(ROOT, "repo")
    const near = join(far, "sub")
    mkdirSync(near, { recursive: true })
    // Fake git root at far so ancestors stop there
    mkdirSync(join(far, ".git"))
    skillDir(join(far, ".agents", "skills"), "shared", { name: "shared", description: "far desc" }, "far body")
    skillDir(join(near, ".agents", "skills"), "shared", { name: "shared", description: "near desc" }, "near body")
    skillDir(join(near, ".agents", "skills"), "only-near", { name: "only-near", description: "near only" }, "x")

    const found = discoverSkills(near)
    const shared = found.find((s) => s.name === "shared")
    expect(shared?.description).toBe("near desc")
    expect(found.some((s) => s.name === "only-near")).toBe(true)
  })

  test("projectAncestors stops at .git", () => {
    const repo = join(ROOT, "git-repo")
    const nested = join(repo, "a", "b")
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(repo, ".git"))
    const anc = projectAncestors(nested)
    expect(anc[0]).toBe(nested)
    expect(anc.some((p) => p === repo)).toBe(true)
    // Should not climb past repo
    expect(anc[anc.length - 1]).toBe(repo)
  })
})

describe("searchSkills", () => {
  test("filters by tokens (AND)", () => {
    const ws = join(ROOT, "search-ws")
    mkdirSync(ws, { recursive: true })
    mkdirSync(join(ws, ".git"))
    skillDir(join(ws, ".chunky", "skills"), "pdf-extract", {
      name: "pdf-extract",
      description: "Extract text from PDF documents",
    }, "body")
    skillDir(join(ws, ".chunky", "skills"), "deploy-k8s", {
      name: "deploy-k8s",
      description: "Deploy services to kubernetes",
    }, "body")

    const all = searchSkills(ws)
    expect(all.some((s) => s.name === "pdf-extract")).toBe(true)
    expect(all.some((s) => s.name === "deploy-k8s")).toBe(true)

    const pdf = searchSkills(ws, "pdf extract")
    expect(pdf).toHaveLength(1)
    expect(pdf[0].name).toBe("pdf-extract")

    const none = searchSkills(ws, "zzznomatch")
    expect(none).toHaveLength(0)
  })
})

describe("loadSkill re-emit (compaction-safe)", () => {
  test("repeat load re-emits full body rather than short notice", () => {
    const ws = join(ROOT, "load-ws")
    mkdirSync(ws, { recursive: true })
    mkdirSync(join(ws, ".git"))
    skillDir(join(ws, ".agents", "skills"), "runbook", {
      name: "runbook",
      description: "Ops runbook for deploys",
    }, "## Steps\n\n1. check health\n2. roll out\n")

    const first = loadSkill(ws, "runbook", "scope-a")
    expect("error" in first).toBe(false)
    if ("error" in first) return
    expect(first.alreadyLoaded).toBe(false)
    expect(first.body).toContain("check health")
    expect(formatLoadResult(first)).toContain("## Skill: runbook")
    expect(formatLoadResult(first)).toContain(first.baseDir)
    expect(formatLoadResult(first)).not.toMatch(/Re-emitted/)

    // Second load in same scope: still full body (survives summarization drop).
    const second = loadSkill(ws, "runbook", "scope-a")
    expect("error" in second).toBe(false)
    if ("error" in second) return
    expect(second.alreadyLoaded).toBe(false)
    expect(second.body).toContain("check health")
    expect(formatLoadResult(second)).toContain("check health")
    expect(formatLoadResult(second)).toContain("## Skill: runbook")

    // Different scope: full body, not marked alreadyLoaded
    const other = loadSkill(ws, "runbook", "scope-b")
    expect("error" in other).toBe(false)
    if ("error" in other) return
    expect(other.alreadyLoaded).toBe(false)
    expect(other.body).toContain("roll out")
  })

  test("unknown skill returns error; prefix match works", () => {
    const ws = join(ROOT, "prefix-ws")
    mkdirSync(ws, { recursive: true })
    mkdirSync(join(ws, ".git"))
    skillDir(join(ws, ".claude", "skills"), "git-release", {
      name: "git-release",
      description: "Release helper",
    }, "release body")

    const miss = loadSkill(ws, "nope", "s")
    expect("error" in miss).toBe(true)

    const prefix = loadSkill(ws, "git-rel", "s")
    expect("error" in prefix).toBe(false)
    if ("error" in prefix) return
    expect(prefix.name).toBe("git-release")
  })
})

describe("tools", () => {
  test("search_skills and load_skill via tool invoke", async () => {
    const ws = join(ROOT, "tool-ws")
    mkdirSync(ws, { recursive: true })
    mkdirSync(join(ws, ".git"))
    skillDir(join(ws, ".codex", "skills"), "lint-fix", {
      name: "lint-fix",
      description: "Fix lint errors systematically",
    }, "Use the linter output.")

    const cfg = { configurable: { workspace: ws, thread_id: "thread-skills-1" } }
    const listed = String(await searchSkillsTool.invoke({}, cfg))
    expect(listed).toContain("lint-fix")
    expect(listed).toContain("Fix lint errors")
    // Metadata only — body not in search
    expect(listed).not.toContain("Use the linter output")

    const filtered = String(await searchSkillsTool.invoke({ query: "lint" }, cfg))
    expect(filtered).toContain("lint-fix")

    const loaded = String(await loadSkillTool.invoke({ name: "lint-fix" }, cfg))
    expect(loaded).toContain("## Skill: lint-fix")
    expect(loaded).toContain("Use the linter output")

    // Repeat load re-emits body (compaction-safe), not a short notice only.
    const again = String(await loadSkillTool.invoke({ name: "lint-fix" }, cfg))
    expect(again).toContain("Use the linter output")
    expect(again).toContain("## Skill: lint-fix")
  })

  test("formatSearchResults empty message mentions install locations", () => {
    const msg = formatSearchResults([], "zzz")
    expect(msg).toContain("No skills matching")
    const empty = formatSearchResults([])
    expect(empty).toMatch(/No skills discovered/)
  })
})
