import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { manageSkillRepos } from "../skill-repos.ts"

export const manageSkillReposInputShape = {
  action: z
    .enum(["add", "remove", "update", "list", "enable", "disable"])
    .describe(
      "add = clone+register a git remote; remove = unregister and delete the local clone; " +
        "update = git pull (all repos, or one by id); list = show repos and skills; enable/disable changes one skill's persisted state.",
    ),
  url: z
    .string()
    .optional()
    .describe("Git remote URL (https://, git@, or ssh://git@). Required for add; accepted for remove."),
  id: z
    .string()
    .optional()
    .describe(
      "Repo id (filesystem-safe). Optional for add (derived from URL); required for remove/update of a single repo.",
    ),
  branch: z
    .string()
    .optional()
    .describe("Optional branch to pin when adding (default: remote HEAD)."),
  subdir: z.string().optional().describe("Optional relative path inside the clone holding skills. GitHub /tree URLs derive this automatically."),
  skill: z.string().optional().describe("Skill name for enable or disable."),
}

export const manageSkillReposTool = tool(
  async ({ action, url, id, branch, subdir, skill }) =>
    JSON.stringify(await manageSkillRepos(action, { url, id, branch, subdir, skill }), null, 2),
  {
    name: "manage_skill_repos",
    description:
      "Manage Chunky's global skill repositories (git remotes cloned into the server state dir). " +
      "Add a repo so its SKILL.md packages appear in search_skills; remove to unregister; " +
      "update to pull latest; list to inspect. Changes apply immediately. " +
      "Only use when the user asks to install/manage skill packs — not for ordinary coding tasks.",
    schema: z.object(manageSkillReposInputShape),
  },
)
