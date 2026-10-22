// Repair mangled comment text in the release workflow and report anything else
// that looks like a lost leading character.
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'H:/bu/repo/dsh-workbuddy-connect/.github/workflows/release.yml'
const src = readFileSync(path, 'utf8')

// `# ail-fast` -> `# fail-fast`; the leading `f` was eaten by PowerShell's
// backtick escape when the line was written.
let out = src.replace(/^(\s*)#\s+ail-fast/mu, '$1# fail-fast')

// Report any comment whose first word starts lowercase with a hyphenated
// keyword, which is the signature of the same corruption.
const suspicious = out.split('\n')
  .map((line, index) => ({ line, index: index + 1 }))
  .filter(({ line }) => /^\s*#\s+[a-z]{1,4}-[a-z]/u.test(line))
if (suspicious.length > 0) {
  console.error('still suspicious:')
  for (const s of suspicious) console.error(`  ${s.index}: ${s.line.trim()}`)
}

writeFileSync(path, out)
console.log(out === src ? 'no change' : 'repaired')
