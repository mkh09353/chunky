import { expect, test } from "bun:test"
import { reapDecisions, normalizeRemote, type ReapCandidate } from "./pr-actions.ts"
test("link cleanup only selects managed closed PRs",()=>{const entries:ReapCandidate[]=[{key:"o/a#1",link:{sessionId:"1",chunkyManaged:true}},{key:"o/a#2",link:{sessionId:"2",chunkyManaged:false}}]; expect(reapDecisions(entries,new Set())).toHaveLength(1); expect(reapDecisions(entries,new Set(["o/a#1"]))).toHaveLength(0)})
test("normalizes GitHub remotes",()=>{expect(normalizeRemote("git@github.com:Org/Repo.git")).toBe("org/repo");expect(normalizeRemote("https://github.com/Org/Repo")).toBe("org/repo")})
