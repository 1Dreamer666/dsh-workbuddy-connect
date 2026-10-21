/**
 * Removal of a temporary directory in a test, retrying the transient Windows
 * failures that a just-disposed host leaves behind.
 *
 * Why this exists: a host under test writes `.workbuddy-host-heartbeat.json`
 * (and, on some paths, a version cache) shortly before it is disposed. On
 * Windows the handle is released asynchronously, so a `rm -r` issued right
 * after disposal can fail with `EPERM` on the `unlink` of that one file — not
 * `ENOTEMPTY`, which is the race the older retry in
 * `settings-integration.spec.ts` was written for, and which is why that one
 * did not cover this failure. Linux and macOS release the handle synchronously
 * enough that the same code passes, so this only shows up on the Windows
 * runners.
 *
 * Retries are bounded and only absorb the transient codes: a genuine
 * permission problem (e.g. a directory owned by another user) still throws, so
 * a real fixture bug is not masked as a flake.
 */
import { rm } from 'node:fs/promises'

/** Codes that mean "the filesystem is not ready yet", not "this will never work". */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'])

/** How long to keep retrying before letting the original error through. */
const DEFAULT_ATTEMPTS = 20
const DEFAULT_DELAY_MS = 25

/**
 * Remove `path` recursively, retrying transient Windows filesystem errors.
 *
 * @param path - the directory to remove.
 * @param attempts - total attempts before rethrowing; defaults to 20 (~0.5s).
 */
export async function removeTempDir(path: string, attempts = DEFAULT_ATTEMPTS): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (attempt + 1 >= attempts || code === undefined || !TRANSIENT_CODES.has(code)) throw error
      // Linear backoff: the window is a few tens of milliseconds in practice,
      // so a growing sleep only costs the retries that were going to succeed
      // anyway.
      await new Promise(resolve => setTimeout(resolve, DEFAULT_DELAY_MS))
    }
  }
}
