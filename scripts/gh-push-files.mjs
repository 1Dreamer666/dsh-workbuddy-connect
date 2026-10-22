// Push several files in one commit through the GitHub API, for when the git
// transport is unavailable (TLS resets on this network) while the API is not.
//
// Usage: node gh-push-files.mjs <repo> <branch> <messageFile> <repoPath:localPath>...
//
// The Contents API commits one file at a time, so this creates the blobs and a
// single tree/commit/ref update instead, keeping the change atomic.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const [repo, branch, messageFile, ...pairs] = process.argv.slice(2)
const message = readFileSync(messageFile, 'utf8').trim()

const gh = (args, input) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 }).trim()
  } catch (error) {
    throw new Error(error.stderr?.toString() || String(error))
  }
}
const api = (path, method = 'GET', payload) =>
  JSON.parse(gh(['api', '--method', method, path, ...payload === undefined ? [] : ['--input', '-']],
    payload === undefined ? undefined : JSON.stringify(payload)))

// Base tree: the current tip of the branch.
const tip = api(`repos/${repo}/git/ref/heads/${branch}`)
const baseCommitSha = tip.object.sha
const baseCommit = api(`repos/${repo}/git/commits/${baseCommitSha}`)

const tree = []
for (const pair of pairs) {
  const [repoPath, localPath] = pair.split('=')
  const content = readFileSync(localPath)
  const blob = api(`repos/${repo}/git/blobs`, 'POST', {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: repoPath, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${blob.sha.slice(0, 7)}  ${repoPath}`)
}

const newTree = api(`repos/${repo}/git/trees`, 'POST', { base_tree: baseCommit.tree.sha, tree })
const commit = api(`repos/${repo}/git/commits`, 'POST', {
  message,
  tree: newTree.sha,
  parents: [baseCommitSha],
})
api(`repos/${repo}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false })
console.log(`pushed ${pairs.length} file(s) -> ${commit.sha.slice(0, 7)}`)
