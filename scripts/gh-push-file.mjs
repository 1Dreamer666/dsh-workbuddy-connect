// Push a single-file change through the GitHub Contents API, for when the git
// transport is unavailable (TLS resets on this network) while the API is not.
//
// Usage: node gh-push-file.mjs <repo> <branch> <repoPath> <localPath> <message>
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const [repo, branch, repoPath, localPath, message] = process.argv.slice(2)
const content = readFileSync(localPath, 'utf8')

const gh = (args, input) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const stderr = error.stderr?.toString() ?? ''
    throw new Error(stderr || String(error))
  }
}

// The current blob sha is required to update an existing file.
let sha
try {
  sha = JSON.parse(gh(['api', `repos/${repo}/contents/${repoPath}?ref=${branch}`])).sha
} catch (error) {
  if (!/404|Not Found/.test(String(error))) throw error
}

const payload = {
  message,
  content: Buffer.from(content, 'utf8').toString('base64'),
  branch,
  ...sha === undefined ? {} : { sha },
}
const result = JSON.parse(gh(
  ['api', '--method', 'PUT', `repos/${repo}/contents/${repoPath}`, '--input', '-'],
  JSON.stringify(payload),
))
console.log(`pushed ${repoPath} -> ${result.commit.sha.slice(0, 7)}`)
