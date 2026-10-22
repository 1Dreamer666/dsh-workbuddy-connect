// Split the release workflow's verify matrix: Windows/macOS stay required and
// in the matrix; Linux moves to its own advisory job so its failures cannot
// cancel the others through any matrix interaction.
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'H:/bu/repo/dsh-workbuddy-connect/.github/workflows/release.yml'
let src = readFileSync(path, 'utf8')

const guard = (cond, message) => { if (!cond) { console.error('ABORT: ' + message); process.exit(1) } }

// 1) Remove the advisory comment + continue-on-error line up to (not including)
//    `strategy:`. The earlier greedy form swallowed the matrix with it.
guard(src.includes("continue-on-error: ${{ matrix.os == 'ubuntu-latest' }}"), 'continue-on-error line not found')
src = src.replace(
  /    # Linux is advisory\.[\s\S]*?    continue-on-error: \$\{\{ matrix\.os === 'ubuntu-latest' \}\}\n/u,
  'PLACEHOLDER_NEVER',
)
if (src.includes('PLACEHOLDER_NEVER')) {
  console.error('ABORT: strict pattern matched; use the narrower form')
  process.exit(1)
}
// Narrow fallback: drop just the comment block and the single line.
src = src.replace(/    # Linux is advisory\.(?:[^]*?)\n    continue-on-error: \$\{\{ matrix\.os == 'ubuntu-latest' \}\}\n/u, '')
src = src.replace(
  /    # fail-fast must stay off(?:[^]*?)      fail-fast: false\n/u,
  '      # Required platforms only: a cancelled sibling is the one outcome that\n' +
  '      # can hide a passing platform, and Linux lives in its own advisory job\n' +
  '      # below precisely so it cannot cancel these.\n' +
  '      fail-fast: false\n',
)
src = src.replace(
  /      # Enumerated rather than a plain os list so the shard-free shape is\n      # explicit: a matrix entry cannot reference `matrix\.os` from inside its\n      # own matrix, and the earlier computed form was rejected for that reason\.\n/u,
  '',
)
src = src.replace(/          - os: ubuntu-latest\n            node: 22\n/u, '')

// 2) Replace the Linux branch inside the test step with the plain parallel run.
guard(src.includes('if [ \'${{ matrix.os }}\' = \'ubuntu-latest\' ]; then'), 'linux branch not found')
src = src.replace(
  /          if \[ '\$\{\{ matrix\.os \}\}' = 'ubuntu-latest' \]; then[\s\S]*?          else\n            pnpm exec vitest run --reporter=verbose --reporter=junit \\\n              --outputFile\.junit=ci-logs\/junit\.xml 2>&1 \| tee ci-logs\/test\.log\n          fi\n/u,
  '          pnpm exec vitest run --reporter=verbose --reporter=junit \\\n' +
  '            --outputFile.junit=ci-logs/junit.xml 2>&1 | tee ci-logs/test.log\n',
)

// 3) Add the advisory Linux job just before the gate.
const gateAnchor = '  # One shared gate for everything downstream'
guard(src.includes(gateAnchor), 'gate anchor not found')
const advisory = `  # Linux, advisory.
  #
  # It has failed this suite in every configuration tried — parallel, two
  # shards, capped workers, the threads pool, one serial process, and one
  # process per file — while the same files pass individually there and the
  # whole suite passes on Windows and macOS in the same run. What is left is
  # fixture behaviour under that runner (it executes as root, and its
  # temporary-directory semantics differ), not product behaviour.
  #
  # Separate job rather than a matrix entry: an entry marked
  # \`continue-on-error\` still let a failing Linux run cancel macOS, and a
  # cancelled job reports as cancelled however the entry was marked. A distinct
  # job with \`continue-on-error: true\` is the shape that keeps the failure
  # visible without touching the required ones.
  linux:
    name: linux (advisory)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    continue-on-error: true
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.tag || github.ref }}
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: typecheck
        timeout-minutes: 6
        run: pnpm run typecheck
      - name: test
        timeout-minutes: 12
        run: |
          set -euo pipefail
          mkdir -p ci-logs
          failures=0
          for f in \$(ls tests/*.spec.ts | sort); do
            out="\$(mktemp)"
            if timeout --foreground -k 10 180s pnpm exec vitest run "\$f" --reporter=verbose \\
                  --outputFile.junit="ci-logs/\$(basename "\$f" .spec.ts).xml" > "\$out" 2>&1; then
              cat "\$out" >> ci-logs/test.log
            else
              echo "::error::\${f} failed or timed out (rc=\$?)"
              tail -40 "\$out"
              cat "\$out" >> ci-logs/test.log
              failures=\$((failures + 1))
              pkill -f vitest >/dev/null 2>&1 || true
            fi
            rm -f "\$out"
          done
          [ "\$failures" -eq 0 ]
      - name: upload test log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-log-ubuntu
          path: ci-logs/
          if-no-files-found: warn
          retention-days: 14

`
src = src.replace(gateAnchor, advisory + gateAnchor)

writeFileSync(path, src)
console.log('rewritten')
