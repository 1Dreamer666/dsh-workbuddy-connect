// Fetch a repo file through the GitHub API and print it, for when the git
// transport is down on this network.
import { execFileSync } from 'node:child_process'

const [repo, path, ref = 'main'] = process.argv.slice(2)
const json = execFileSync('gh', ['api', `repos/${repo}/contents/${path}?ref=${ref}`], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const body = JSON.parse(json)
process.stdout.write(Buffer.from(body.content, 'base64').toString('utf8'))
