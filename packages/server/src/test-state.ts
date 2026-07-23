import { mkdtempSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

function validPrefix(prefix: string): boolean {
  return /^[A-Za-z0-9._-]+-$/.test(prefix)
}

export function createIsolatedTestState(prefix: string): {
  root: string
  db: string
  settings: string
} {
  if (!validPrefix(prefix)) throw new Error(`invalid test-state prefix: ${prefix}`)
  const root = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    db: join(root, "chunky.db"),
    settings: join(root, "settings.json"),
  }
}

export function removeIsolatedTestState(root: string, prefix: string): void {
  const resolvedRoot = resolve(root)
  const resolvedTemp = resolve(tmpdir())
  if (
    !validPrefix(prefix)
    || dirname(resolvedRoot) !== resolvedTemp
    || !basename(resolvedRoot).startsWith(prefix)
  ) {
    throw new Error(`refusing unsafe test cleanup outside ${resolvedTemp}/${prefix}*`)
  }
  rmSync(resolvedRoot, { recursive: true, force: true })
}
