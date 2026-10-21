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
  },
})
