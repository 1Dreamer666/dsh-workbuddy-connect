import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Mirror the build-time define from tsdown.config.ts so tests see the same version. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

export default defineConfig({
  define: {
    __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // A hung test must fail, not hang the run: without a per-test ceiling a
    // single stuck `vi.waitFor` holds the whole job on one runner, which is
    // how a 20-minute timeout gets burned with no log to show for it. The
    // slowest legitimate test here waits up to 30s for a module load on a cold
    // CI disk, so 60s leaves headroom without masking a real hang.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // `verbose` so a timeout names the file and test that held the runner.
    reporters: process.env.CI === 'true' ? ['verbose'] : ['default'],
    // A test that leaves an interval or a socket open keeps the worker's event
    // loop alive; vitest then waits on it rather than exiting. Locally the
    // process is fast enough to win the race, on the ubuntu runner it is not —
    // the run sat for 12 minutes after the last assertion, with no file ever
    // reported. `teardownTimeout` bounds that wait, and `pool: 'forks'` gives
    // each file a real child process vitest can kill outright instead of a
    // thread it can only ask to stop.
    teardownTimeout: 10_000,
    pool: 'forks',
    // `pool: 'forks'` plus the default worker count sat indefinitely on the
    // ubuntu runner: every file passes when run on its own (verified by
    // dispatching the suite in halves), but the full parallel run stalled with
    // no file ever reported. The runner has 4 vCPUs and each fork here imports
    // the whole pi-ai surface, so the default fan-out oversubscribes it.
    // Two workers keeps the run parallel enough to fit the step budget while
    // staying inside what the runner can actually hold.
    ...process.env.CI === 'true' ? { maxWorkers: 2, minWorkers: 1 } : {},
  },
})
