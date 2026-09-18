/**
 * Copy the built plugin into every DSH profile that already has it installed.
 *
 * The previous script hardcoded one profile under USERPROFILE. A deployment can
 * mount the plugin in several profiles (desktop, web, headless, tui), and each
 * one loads its own copy, so syncing only one of them silently leaves the others
 * on the old build.
 *
 * Usage:
 *   node scripts/sync-profiles.js              # sync every profile that has dsh-jev
 *   node scripts/sync-profiles.js --dry-run    # list what would change, touch nothing
 *   node scripts/sync-profiles.js --profile web
 *
 * Note: DSH profiles in this deployment mount no HMR plugin, so a synced file is
 * only picked up after the host restarts. The script says so when it finishes.
 */

import { copyFileSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = 'dsh-jev'

/** Resolve the DSH home the same way the host does. */
export function resolveDshHome(env = process.env) {
  if (env.DSH_HOME) return env.DSH_HOME
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  return join(home, '.dsh')
}

/**
 * Find every profile directory holding an installed copy of the plugin.
 * @param dshHome absolute DSH home
 * @returns absolute paths of the installed plugin directories
 */
export function findInstalledPluginDirs(dshHome) {
  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return []
  const found = []
  for (const entry of readdirSync(profilesDir)) {
    const candidate = join(profilesDir, entry, 'node_modules', PLUGIN_NAME)
    try {
      if (statSync(candidate).isDirectory()) found.push({ profile: entry, dir: candidate })
    } catch {
      /* not installed in this profile */
    }
  }
  return found
}

/** Files that make up the installed plugin. */
export function installPayload(repoRoot) {
  return {
    dirs: [{ from: join(repoRoot, 'lib'), to: 'lib' }],
    files: ['package.json', 'cordis.patch.yml', 'README.md'],
  }
}

/**
 * Sync the repo build into the selected profiles.
 * @returns a per-profile report of what was written
 */
export function syncProfiles({ repoRoot, dshHome, profile, dryRun = false }) {
  const all = findInstalledPluginDirs(dshHome)
  const targets = profile ? all.filter((entry) => entry.profile === profile) : all
  const payload = installPayload(repoRoot)
  const report = []

  for (const target of targets) {
    const written = []
    if (!dryRun) {
      for (const dir of payload.dirs) {
        cpSync(dir.from, join(target.dir, dir.to), { recursive: true, force: true })
        written.push(dir.to)
      }
      for (const file of payload.files) {
        const from = join(repoRoot, file)
        if (!existsSync(from)) continue
        copyFileSync(from, join(target.dir, file))
        written.push(file)
      }
    }
    report.push({ profile: target.profile, dir: target.dir, written, dryRun })
  }

  return {
    dshHome,
    scanned: all.map((entry) => entry.profile),
    synced: report.map((entry) => entry.profile),
    skipped: profile ? all.filter((entry) => entry.profile !== profile).map((entry) => entry.profile) : [],
    report,
  }
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const profileIndex = args.indexOf('--profile')
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined

  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const dshHome = resolveDshHome()
  const result = syncProfiles({ repoRoot, dshHome, profile, dryRun })

  if (result.scanned.length === 0) {
    console.error(`No profile under ${dshHome} has ${PLUGIN_NAME} installed; nothing to do.`)
    process.exitCode = 1
    return
  }

  for (const entry of result.report) {
    console.log(`${dryRun ? '[dry-run] ' : ''}${entry.profile}: ${entry.dir}`)
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped (not selected): ${result.skipped.join(', ')}`)
  }
  console.log(
    `\nSynced ${result.synced.length} profile(s). DSH mounts no HMR plugin here, so restart the host to load the new build.`
  )
}

if (process.argv[1] && process.argv[1].endsWith('sync-profiles.js')) {
  main()
}
