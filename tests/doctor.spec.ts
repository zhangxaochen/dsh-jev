import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareBuilds, METRICS_SCHEMA_VERSION, readRunningState, runDoctor } from '../scripts/doctor.js'
import { PLUGIN_NAME } from '../scripts/sync-profiles.js'

function tempRoot() {
  const root = join(tmpdir(), 'jev-doctor-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  mkdirSync(root, { recursive: true })
  return root
}

function writeBuild(dir, contents, version = '0.2.0') {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  for (const [name, text] of Object.entries(contents)) {
    writeFileSync(join(dir, 'lib', name), text, 'utf8')
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version }), 'utf8')
}

function installProfile(dshHome, profile, contents, version = '0.2.0') {
  const dir = join(dshHome, 'profiles', profile, 'node_modules', PLUGIN_NAME)
  writeBuild(dir, contents, version)
  return dir
}

test('compareBuilds reports parity, drift and missing modules', () => {
  const dshHome = tempRoot()
  const repo = tempRoot()
  writeBuild(repo, { 'a.js': 'export const a = 1\n', 'b.js': 'export const b = 2\n' })

  const same = installProfile(dshHome, 'desktop', { 'a.js': 'export const a = 1\n', 'b.js': 'export const b = 2\n' })
  const parity = compareBuilds(repo, same)
  assert.equal(parity.ok, true)
  assert.equal(parity.checked, 2)

  const drifted = installProfile(dshHome, 'headless', { 'a.js': 'export const a = 1\n', 'b.js': 'export const b = 99\n' })
  const drift = compareBuilds(repo, drifted)
  assert.equal(drift.ok, false)
  assert.deepEqual(drift.mismatched, ['b.js'])

  const incomplete = installProfile(dshHome, 'web', { 'a.js': 'export const a = 1\n' })
  const missing = compareBuilds(repo, incomplete)
  assert.deepEqual(missing.missing, ['b.js'])
  assert.equal(missing.ok, false)

  rmSync(dshHome, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

test('readRunningState distinguishes the measured schema from the legacy one', () => {
  const dshHome = tempRoot()

  const absent = readRunningState(dshHome)
  assert.equal(absent.present, false)
  assert.equal(absent.loadedMeasuredBuild, false)

  writeFileSync(join(dshHome, 'jev-stats.json'), JSON.stringify({ version: 1, lastUpdatedAt: 'X' }), 'utf8')
  const legacy = readRunningState(dshHome)
  assert.equal(legacy.version, 1)
  assert.equal(legacy.loadedMeasuredBuild, false)

  writeFileSync(
    join(dshHome, 'jev-stats.json'),
    JSON.stringify({ version: METRICS_SCHEMA_VERSION, lastUpdatedAt: 'Y' }),
    'utf8'
  )
  const measured = readRunningState(dshHome)
  assert.equal(measured.loadedMeasuredBuild, true)

  writeFileSync(join(dshHome, 'jev-stats.json'), '{broken', 'utf8')
  assert.equal(readRunningState(dshHome).loadedMeasuredBuild, false)

  rmSync(dshHome, { recursive: true, force: true })
})

test('runDoctor asks for a restart when files are current but the host is not', () => {
  const dshHome = tempRoot()
  const repo = tempRoot()
  const contents = { 'index.js': 'export const v = 2\n' }
  writeBuild(repo, contents)
  installProfile(dshHome, 'desktop', contents)
  writeFileSync(join(dshHome, 'jev-stats.json'), JSON.stringify({ version: 1 }), 'utf8')

  const report = runDoctor({ repoRoot: repo, dshHome })
  assert.equal(report.verdict.copiesMatch, true)
  assert.equal(report.verdict.versionsMatch, true)
  assert.equal(report.verdict.restartRequired, true)
  assert.equal(report.verdict.ready, false)

  rmSync(dshHome, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

test('runDoctor reports ready once the host has loaded the current build', () => {
  const dshHome = tempRoot()
  const repo = tempRoot()
  const contents = { 'index.js': 'export const v = 2\n' }
  writeBuild(repo, contents)
  installProfile(dshHome, 'desktop', contents)
  writeFileSync(join(dshHome, 'jev-stats.json'), JSON.stringify({ version: METRICS_SCHEMA_VERSION }), 'utf8')

  const report = runDoctor({ repoRoot: repo, dshHome })
  assert.equal(report.verdict.ready, true)
  assert.equal(report.verdict.restartRequired, false)

  rmSync(dshHome, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

test('runDoctor flags a version drift between the repo and an installed copy', () => {
  const dshHome = tempRoot()
  const repo = tempRoot()
  const contents = { 'index.js': 'export const v = 2\n' }
  writeBuild(repo, contents, '0.2.0')
  installProfile(dshHome, 'desktop', contents, '0.1.0')

  const report = runDoctor({ repoRoot: repo, dshHome })
  assert.equal(report.verdict.copiesMatch, true)
  assert.equal(report.verdict.versionsMatch, false)
  assert.equal(report.verdict.ready, false)

  rmSync(dshHome, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})
