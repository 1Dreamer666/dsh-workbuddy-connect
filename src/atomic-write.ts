/**
 * Self-contained atomic file write + cooperative file lock.
 *
 * Why this exists: upstream `dsh-workbuddy-connect` imported `writeFileAtomic`
 * and `withFileLock` from `@deepseek-ai/dsh-atomic-write`. The 0.2.1-rc.1
 * Desktop runtime no longer exposes that package to plugin bundles, so every
 * load died with `ERR_MODULE_NOT_FOUND` before the provider could register.
 * Re-implementing both primitives locally removes the runtime dependency
 * entirely — the bundle then needs nothing but `node:fs`, and loads on any
 * 0.2.x host regardless of which packages the App chooses to surface.
 *
 * Semantics are kept identical to the upstream helpers so call sites do not
 * change behaviour:
 * - {@link writeFileAtomic} writes a sibling temp file, optionally fsyncs it,
 *   then renames over the target, so readers never observe a partial document.
 * - {@link withFileLock} is advisory and cooperative: it serialises writers
 *   that go through this module, it does not stop foreign processes.
 *
 * @module dsh-workbuddy-connect/atomic-write
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Options for {@link writeFileAtomic}. */
export interface WriteFileAtomicOptions {
  /** Permission bits for the written file. Default `0o600`. */
  mode?: number
  /** Permission bits for created parent directories. Default `0o700`. */
  dirMode?: number
  /** fsync the temp file before renaming. Default `true`. */
  fsync?: boolean
}

/** Options for {@link withFileLock}. */
export interface FileLockOptions {
  /** How long to wait for a contended lock before giving up. Default 5s. */
  timeoutMs?: number
  /** Age at which an existing lock file is considered stale and reclaimed. Default 30s. */
  staleMs?: number
  /** Polling interval while waiting. Default 25ms. */
  retryMs?: number
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_LOCK_RETRY_MS = 25

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Atomically replace `path` with `data`.
 *
 * The write lands in a sibling temp file first, then `rename(2)` moves it into
 * place — on POSIX and on Windows (Node renames with replace semantics) that
 * is a single atomic swap, so a concurrent reader sees either the old or the
 * new document, never a half-written one. The temp file is removed if any step
 * fails, and the parent directory is created on demand.
 *
 * Note that `mode` applies to newly created files; on Windows it is
 * best-effort and silently ignored for files that already exist.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const { mode = 0o600, dirMode = 0o700, fsync: sync = true } = options
  await mkdir(dirname(path), { recursive: true, mode: dirMode })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temp, 'w', mode)
    try {
      await handle.writeFile(data)
      if (sync) await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    // Never leave temp debris behind; the caller sees the original failure.
    try {
      await rm(temp, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

/**
 * Remove `lockPath` when it is older than `staleMs`, reporting whether it was
 * reclaimed. A lock left behind by a killed process would otherwise block
 * writers forever, and there is no portable way to test liveness by PID here.
 */
async function reclaimStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs <= staleMs) return false
    await rm(lockPath, { force: true })
    return true
  } catch {
    // Lock vanished between the EEXIST and the stat — treat as reclaimed.
    return true
  }
}

/**
 * Run `fn` while holding an advisory lock for `path`.
 *
 * The lock is a sibling `.lock` file created with `O_EXCL`. Contention spins
 * until `timeoutMs`, reclaiming locks older than `staleMs` along the way; if
 * the wait expires the callback still runs, because failing a credential or
 * catalog write is worse than writing without the lock. The lock file is
 * always released in `finally`.
 *
 * @returns whatever `fn` resolves to.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleMs = DEFAULT_LOCK_STALE_MS,
    retryMs = DEFAULT_LOCK_RETRY_MS,
  } = options
  const lockPath = `${path}.lock`
  const deadline = Date.now() + timeoutMs

  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(String(process.pid))
      } finally {
        await handle.close()
      }
      acquired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await reclaimStaleLock(lockPath, staleMs)) continue
      if (Date.now() >= deadline) return await fn()
      await sleep(retryMs)
    }
  }

  try {
    return await fn()
  } finally {
    try {
      await rm(lockPath, { force: true })
    } catch {
      /* ignore */
    }
  }
}
