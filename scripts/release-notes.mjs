/**
 * The release notes for one version: the CHANGELOG section under that heading.
 *
 * `.github/workflows/release.yml` uses this, so the notes on the GitHub release and
 * the section in CHANGELOG.md cannot disagree. A script rather than an inline shell
 * one-liner because tests/release.spec.ts can run it.
 *
 * Usage: node scripts/release-notes.mjs 0.2.0 > RELEASE_NOTES.md
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Extract the changelog section for one version.
 * @param changelog - the CHANGELOG.md contents
 * @param version - the version to extract, e.g. `0.2.0`
 * @returns the section body, trimmed, with a trailing newline
 */
export function releaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp('^## \\[?' + escaped + '\\]?(\\s|$)')
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) throw new Error('CHANGELOG.md has no section for ' + version)

  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    body.push(line)
  }

  const text = body.join('\n').trim()
  if (text.length === 0) throw new Error('the ' + version + ' changelog section is empty')
  return text + '\n'
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2]
  if (version === undefined) {
    console.error('usage: node scripts/release-notes.mjs <version>')
    process.exit(2)
  }
  try {
    const changelog = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8')
    process.stdout.write(releaseNotes(changelog, version))
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
}
