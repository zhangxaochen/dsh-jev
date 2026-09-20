/**
 * Release contract.
 *
 * Publishing is the one operation that cannot be undone, and it is spread over three
 * places holding the same number: the tag, `package.json` and `CHANGELOG.md`. The
 * workflow checks them at release time; these checks keep the workflow itself from
 * drifting into something that publishes from a branch push, publishes without
 * provenance, or publishes before the gates ran.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseNotes } from '../scripts/release-notes.mjs'

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
const release = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

test('the version package.json declares has a changelog section', () => {
  // An unreleased version whose notes section is missing would publish with empty
  // release notes, because the notes are cut out of that section.
  const pattern = new RegExp('^## \\[?' + pkg.version.replace(/\./g, '\\.') + '\\]?', 'm')
  assert.match(
    changelog,
    pattern,
    'package.json says ' + pkg.version + ' but CHANGELOG.md has no section for it'
  )
})

test('the release workflow can only publish from a version tag', () => {
  assert.match(release, /tags: \['v\*'\]/, 'release.yml must be triggered by version tags')
  assert.doesNotMatch(release, /^\s*branches:/m, 'a branch push must never reach the publish job')
  assert.match(release, /id-token: write/, 'trusted publishing needs an OIDC token')
  assert.match(release, /contents: write/, 'creating the GitHub release needs contents: write')
})

test('the release workflow gates the tag before it publishes', () => {
  // The tag can point at a commit no branch push ever verified, so the same gates
  // run here - through the reusable CI workflow, so the two cannot drift apart.
  assert.match(ci, /workflow_call:/, 'ci.yml must stay callable as a reusable workflow')
  assert.match(
    release,
    /uses: \.\/\.github\/workflows\/ci\.yml/,
    'the tag must pass the CI gates before publishing'
  )
  assert.match(release, /GITHUB_REF_NAME/, 'the tag is never compared with the package version')
  assert.match(release, /CHANGELOG\.md/, 'the changelog is not checked for the released version')
  assert.match(release, /npm publish --provenance/, 'publishing must carry a provenance attestation')
})

test('the release notes are the changelog section for the released version', () => {
  // The extractor is what the GitHub release body comes from, so a version that
  // silently produced the wrong slice (the previous section, the whole file, or
  // nothing) would publish release notes that do not describe the release.
  const notes = releaseNotes(changelog, pkg.version)
  assert.ok(notes.trim().length > 0, 'the extractor returned an empty section')
  assert.doesNotMatch(notes, /^## /m, 'the section must stop at the next version heading')
  assert.match(notes, /###/, 'a changelog section carries subsections such as Added or Changed')
  assert.throws(() => releaseNotes(changelog, '99.99.99'), /no section for 99\.99\.99/)
})
