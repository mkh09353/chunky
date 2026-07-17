import { resolve } from "node:path"

type Waiter = { resolve: () => void }
const queues = new Map<string, Waiter[]>()

async function acquire(path: string): Promise<() => void> {
  const key = resolve(path)
  const queue = queues.get(key) ?? []
  queues.set(key, queue)
  let release!: () => void
  const promise = new Promise<void>((done) => {
    release = () => {
      const next = queue.shift()
      if (next) next.resolve()
      else queues.delete(key)
    }
    if (queue.length === 0) done()
    else queue.push({ resolve: done })
  })
  await promise
  return release
}

export async function withFileLock<T>(absPath: string, fn: () => T | Promise<T>): Promise<T> {
  const release = await acquire(absPath)
  try { return await fn() } finally { release() }
}

/** Acquire several locks in stable order to avoid deadlocks for multi-file patches. */
export async function withFileLocks<T>(paths: string[], fn: () => T | Promise<T>): Promise<T> {
  const releases: (() => void)[] = []
  try {
    for (const path of [...new Set(paths)].sort()) releases.push(await acquire(path))
    return await fn()
  } finally {
    for (const release of releases.reverse()) release()
  }
}
