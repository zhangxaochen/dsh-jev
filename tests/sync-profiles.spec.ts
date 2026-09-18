import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findInstalledPluginDirs, PLUGIN_NAME, resolveDshHome, syncProfiles } from '../scripts/sync-profiles.js'

function tempRoot() {
  const root = join(tmpdir(), 'jev-sync-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  mkdirSync(root, { recursive: true })
  return root
}

function makeProfile(dshHome, profile) {
  const dir = join(dshHome, 'profiles', profile, 'node_modules', PLUGIN_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeRepo(root) {
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'index.js'), 'export const build = "new"\n', 'utf8')
  writeFileSync(join(root, 'package.json'), '{"name":"dsh-jev","version":"0.2.0"}', 'utf8')
  writeFileSync(join(root, 'cordis.patch.yml'), 'patch\n', 'utf8')
  return root
}

test('resolveDshHome honours DSH_HOME before the platform home', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh')
  assert.equal(resolveDshHome({ USERPROFILE: '/users/x' }), join('/users/x', '.dsh'))
  assert.equal(resolveDshHome({ HOME: '/home/x' }), join('/home/x', '.dsh'))
})

test('findInstalledPluginDirs lists only profiles that actually have the plugin', () => {
  const dshHome = tempRoot()
  makeProfile(dshHome, 'desktop')
  makeProfile(dshHome, 'headless')
  mkdirSync(join(dshHome, 'profiles', 'web', 'node_modules'), { recursive: true })

  const found = findInstalledPluginDirs(dshHome)
  assert.deepEqual(
    found.map((entry) => entry.profile).sort(),
    ['desktop', 'headless']
  )

  rmSync(dshHome, { recursive: true, force: true })
  assert.deepEqual(findInstalledPluginDirs(dshHome), [])
})

test('syncProfiles copies the build into every installed profile', () => {
  const dshHome = tempRoot()
  const repoRoot = makeRepo(tempRoot())
  const desktop = makeProfile(dshHome, 'desktop')
  const headless = makeProfile(dshHome, 'headless')

  const result = syncProfiles({ repoRoot, dshHome })

  assert.deepEqual(result.synced.sort(), ['desktop', 'headless'])
  assert.deepEqual(result.skipped, [])
  for (const dir of [desktop, headless]) {
    assert.equal(readFileSync(join(dir, 'lib', 'index.js'), 'utf8'), 'export const build = "new"\n')
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '0.2.0')
    assert.equal(existsSync(join(dir, 'cordis.patch.yml')), true)
  }
})

test('syncProfiles narrows to one profile and reports the rest as skipped', () => {
  const dshHome = tempRoot()
  const repoRoot = makeRepo(tempRoot())
  makeProfile(dshHome, 'desktop')
  makeProfile(dshHome, 'web')

  const result = syncProfiles({ repoRoot, dshHome, profile: 'web' })
  assert.deepEqual(result.synced, ['web'])
  assert.deepEqual(result.skipped, ['desktop'])
})

test('syncProfiles with dryRun touches nothing but still reports targets', () => {
  const dshHome = tempRoot()
  const repoRoot = makeRepo(tempRoot())
  const desktop = makeProfile(dshHome, 'desktop')

  const result = syncProfiles({ repoRoot, dshHome, dryRun: true })
  assert.deepEqual(result.synced, ['desktop'])
  assert.equal(existsSync(join(desktop, 'lib', 'index.js')), false)

  rmSync(dshHome, { recursive: true, force: true })
  rmSync(repoRoot, { recursive: true, force: true })
})
