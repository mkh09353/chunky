// Unit tests for managed skill repositories (settings + clone/discovery glue).
// Run: bun test packages/server/src/skill-repos.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

const ROOT = join(tmpdir(), `chunky-skill-repos-${process.pid}-${Date.now()}`)
const SETTINGS = join(ROOT, "settings.json")
const BARE = join(ROOT, "bare.git")
const WORK = join(ROOT, "work")

process.env.CHUNKY_SETTINGS = SETTINGS

mkdirSync(ROOT, { recursive: true })
writeFileSync(SETTINGS, "{}")

const settings = await import("./settings.ts")
const {
  skillRepoIdFromUrl,
  validateSkillRepoUrl,
  manageSkillRepos,
  listSkillRepoStatus,
  managedSkillRoots,
  skillRepoPath,
} = await import("./skill-repos.ts")
const { discoverSkills } = await import("./skills.ts")
const { manageSkillReposTool } = await import("./tools/manage-skill-repos.ts")
const { executorToolsFor } = await import("./agent.ts")

function git(args: string[], cwd?: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
  return r
}

// Seed a local bare repo with one skill so clone/update tests stay offline.
function seedBare() {
  rmSync(WORK, { recursive: true, force: true })
  rmSync(BARE, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  git(["init", "-b", "main"], WORK)
  git(["config", "user.email", "test@example.com"], WORK)
  git(["config", "user.name", "Test"], WORK)
  const skill = join(WORK, "hello-skill")
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: hello-skill\ndescription: A hello skill from a managed repo\n---\n\n# Hello\n\nDo hello things.\n",
  )
  git(["add", "."], WORK)
  git(["commit", "-m", "init"], WORK)
  git(["clone", "--bare", WORK, BARE])
}

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* ok */
  }
})

afterEach(() => {
  // Drop registry between tests; wipe clones.
  writeFileSync(SETTINGS, "{}")
  // Clear settings module cache so loadSettings re-reads disk... actually it
  // keeps an in-memory cache. Use remove for each known id instead.
  for (const r of settings.listSkillRepos()) {
    settings.removeSkillRepo(r.id)
  }
  const clones = join(ROOT, "skill-repos")
  try {
    rmSync(clones, { recursive: true, force: true })
  } catch {
    /* ok */
  }
})

describe("url / id helpers", () => {
  test("derives stable ids from common git URL forms", () => {
    expect(skillRepoIdFromUrl("https://github.com/owner/repo.git")).toBe("github-com-owner-repo")
    expect(skillRepoIdFromUrl("git@github.com:owner/repo.git")).toBe("github-com-owner-repo")
    expect(skillRepoIdFromUrl("ssh://git@github.com/owner/repo")).toBe("github-com-owner-repo")
  })

  test("accepts remotes and absolute paths; rejects relative junk", () => {
    expect(validateSkillRepoUrl("https://github.com/a/b")).toBe("https://github.com/a/b")
    expect(validateSkillRepoUrl("file:///tmp/foo.git")).toBe("file:///tmp/foo.git")
    expect(validateSkillRepoUrl("/tmp/foo.git")).toBe("/tmp/foo.git")
    expect(() => validateSkillRepoUrl("not a url")).toThrow()
    expect(() => validateSkillRepoUrl("./relative")).toThrow()
    expect(() => validateSkillRepoUrl("../escape")).toThrow()
  })
})

describe("manageSkillRepos lifecycle", () => {
  test("add clones, list shows present, discovery finds skills, remove cleans up", async () => {
    seedBare()
    const added = (await manageSkillRepos("add", { url: BARE, id: "test-hello" })) as {
      action: string
      repo: { id: string; path: string; present: boolean }
    }
    expect(added.action).toBe("add")
    expect(added.repo.id).toBe("test-hello")
    expect(added.repo.present).toBe(true)
    expect(existsSync(join(added.repo.path, "hello-skill", "SKILL.md"))).toBe(true)

    const listed = listSkillRepoStatus()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe("test-hello")
    expect(listed[0]!.present).toBe(true)

    const roots = managedSkillRoots()
    expect(roots.some((r) => r.id === "test-hello")).toBe(true)

    // Discovery should surface the managed skill (workspace can be empty).
    const emptyWs = join(ROOT, "empty-ws")
    mkdirSync(emptyWs, { recursive: true })
    const skills = discoverSkills(emptyWs)
    const hit = skills.find((s) => s.name === "hello-skill")
    expect(hit).toBeDefined()
    expect(hit!.source).toBe("repo")
    expect(hit!.sourceLabel).toBe("repo:test-hello")

    const removed = (await manageSkillRepos("remove", { id: "test-hello" })) as {
      removed: boolean
      id: string
    }
    expect(removed.removed).toBe(true)
    expect(existsSync(skillRepoPath("test-hello"))).toBe(false)
    expect(listSkillRepoStatus()).toHaveLength(0)
    expect(discoverSkills(emptyWs).find((s) => s.name === "hello-skill")).toBeUndefined()
  })

  test("update pulls new commits", async () => {
    seedBare()
    await manageSkillRepos("add", { url: BARE, id: "upd" })

    // Push a new skill to the bare via the work tree.
    const skill2 = join(WORK, "bye-skill")
    mkdirSync(skill2, { recursive: true })
    writeFileSync(
      join(skill2, "SKILL.md"),
      "---\nname: bye-skill\ndescription: Bye skill\n---\n\nbody\n",
    )
    git(["add", "."], WORK)
    git(["commit", "-m", "add bye"], WORK)
    git(["push", BARE, "main"], WORK)

    const updated = (await manageSkillRepos("update", { id: "upd" })) as {
      updated: number
      failed: number
      repos: Array<{ id: string; lastError?: string }>
    }
    expect(updated.updated).toBe(1)
    expect(updated.failed).toBe(0)
    expect(existsSync(join(skillRepoPath("upd"), "bye-skill", "SKILL.md"))).toBe(true)
  })

  test("duplicate add is rejected", async () => {
    seedBare()
    await manageSkillRepos("add", { url: BARE, id: "dup" })
    await expect(manageSkillRepos("add", { url: BARE, id: "dup" })).rejects.toThrow(/already/)
  })

  test("the executor exposes manage_skill_repos", async () => {
    const names = executorToolsFor({ provider: "codex", model: "gpt-5.5" }).tools.map((t) => t.name)
    expect(names).toContain("manage_skill_repos")

    seedBare()
    const output = String(
      await manageSkillReposTool.invoke({ action: "add", url: BARE, id: "tool-add" }),
    )
    expect(JSON.parse(output)).toMatchObject({ action: "add", repo: { id: "tool-add" } })
    expect(settings.skillRepoById("tool-add")).toBeDefined()
  })

  test("project skills override managed repo skills of the same name", async () => {
    seedBare()
    await manageSkillRepos("add", { url: BARE, id: "override-test" })

    const ws = join(ROOT, "proj-ws")
    const projSkill = join(ws, ".agents", "skills", "hello-skill")
    mkdirSync(projSkill, { recursive: true })
    writeFileSync(
      join(projSkill, "SKILL.md"),
      "---\nname: hello-skill\ndescription: Project wins\n---\n\nproject body\n",
    )
    // Need a .git so projectAncestors stops at ws
    mkdirSync(join(ws, ".git"), { recursive: true })

    const skills = discoverSkills(ws)
    const hit = skills.find((s) => s.name === "hello-skill")
    expect(hit).toBeDefined()
    expect(hit!.source).toBe("project")
    expect(hit!.description).toBe("Project wins")
  })
})
