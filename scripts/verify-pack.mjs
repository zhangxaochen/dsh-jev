/**
 * Smoke-test the published artifact: pack it, install the tarball into a scratch
 * directory, and import it the way the host would.
 *
 * The unit suite imports `lib/` from the working tree, so nothing there proves the
 * tarball installs and resolves - a broken `main`, `types` or `exports` target would
 * only show up for a user who ran `dsh plugin add dsh-jev`.
 *
 * Usage: pnpm run verify:pack
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'jev-pack-'))

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: true, ...options })
}

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail })
}

try {
  // Pack into the scratch directory so the tarball never lands in the workspace.
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', scratch]))
  const tarball = join(scratch, packed[0].filename)
  check('the tarball is produced', packed[0].filename.endsWith('.tgz'), packed[0].filename)

  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'smoke', type: 'module', private: true }), 'utf8')
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', tarball], { cwd: scratch })

  // Import it the way the host does: by package name, resolved from the install.
  const entry = join(scratch, 'node_modules', 'dsh-jev')
  const mod = await import(pathToFileURL(join(entry, 'lib', 'index.js')).href)

  const expected = ['apply', 'name', 'applyLoopGuard', 'applySafetyGuard', 'applyToolPruner', 'applySkillRouter', 'applyResultShaper', 'registerJevTools']
  const missing = expected.filter((key) => mod[key] === undefined)
  check('the entry exports everything the host mounts', missing.length === 0, missing.join(',') || expected.length + ' exports')

  const services = ['ToolPrunerService', 'SkillRouterService', 'ResultShaperService', 'MetricsCollector', 'TypeSafeClient']
  const missingServices = services.filter((key) => mod[key] === undefined)
  check('the service classes ship too', missingServices.length === 0, missingServices.join(',') || services.length + ' classes')

  // The manifest must still resolve its own declared entries inside the install.
  const installedPkg = JSON.parse(
    execFileSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', join(entry, 'package.json')], { encoding: 'utf8' })
  )
  const targets = [installedPkg.main, installedPkg.types, installedPkg.dsh.bundle.patch]
  const broken = targets.filter((target) => !existsSync(join(entry, target.replace(/^\.\//, ''))))
  check('the installed manifest points at files that exist', broken.length === 0, broken.join(',') || targets.join(' '))

  // The patch file must be readable from the install, since the host parses it.
  const patch = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', join(entry, 'cordis.patch.yml')],
    { encoding: 'utf8' }
  )
  check('the installed patch file is readable and mounts dsh-jev', patch.includes('id: dsh-jev') && patch.includes('name: dsh-jev'))
} catch (err) {
  check('the pack smoke test runs', false, err instanceof Error ? err.message : String(err))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}


let failures = 0
console.log('=== published artifact smoke test ===')
for (const entry of checks) {
  if (!entry.ok) failures += 1
  console.log((entry.ok ? 'ok   ' : 'FAIL ') + entry.label + (entry.detail ? '  (' + entry.detail + ')' : ''))
}
console.log(failures === 0 ? '\nthe tarball installs and resolves like a published package.' : '\n' + failures + ' check(s) failed.')
process.exit(failures === 0 ? 0 : 1)
