/**
 * Packaging contracts the host enforces at load time.
 *
 * Two silent failure modes are covered here:
 * 1. the settings panel is loaded as a classic script, so an ESM-only construct
 *    left in the bundle would make the host reject the module;
 * 2. DSH rejects a plugin whose bundle config names a key its schema does not
 *    declare, so a typo in cordis.patch.yml breaks the plugin for every user.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import {
  DEFAULT_ASK_APPROVAL_THRESHOLD,
  DEFAULT_BLOCK_THRESHOLD,
  DEFAULT_GUARDED_TOOLS,
} from '../lib/safety-guard.js'
import {
  DEFAULT_COOLDOWN_STEPS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_NO_PROGRESS_THRESHOLD,
  DEFAULT_P_LOOP_THRESHOLD,
  DEFAULT_TRIGGER_THRESHOLD,
} from '../lib/loop-guard.js'
import {
  DEFAULT_MAX_TOOLS,
  DEFAULT_MIN_INTENT_CHARS,
  DEFAULT_MIN_KEEP,
} from '../lib/tool-pruner.js'
import { DEFAULT_ALWAYS_RETAIN } from '../lib/tool-pruner.js'

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const TYPES_SOURCE = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
const PATCH = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

/** Field names declared by one exported interface in src/types.ts. */
function interfaceFields(name) {
  const block = TYPES_SOURCE.match(new RegExp('export interface ' + name + ' \\{([\\s\\S]*?)\\n\\}'))
  assert.ok(block, 'interface ' + name + ' not found in src/types.ts')
  return [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1])
}

/** The bundle config keys named under `config:` in cordis.patch.yml. */
function patchConfigKeys() {
  const lines = PATCH.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'config:')
  assert.ok(start >= 0, 'cordis.patch.yml has no config block')
  const configIndent = lines[start].length - lines[start].trimStart().length
  const keys = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= configIndent) break
    // Direct children of `config:` are the section names.
    if (indent === configIndent + 2 && line.includes(':')) keys.push(line.trim().replace(/:.*$/, ''))
  }
  return keys
}

test('the settings panel loads as a classic script, not an ES module', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'the bundle still contains ESM syntax')
  assert.ok(source.includes('__ModuleLoader__'), 'the bundle does not register through the module loader')
  // vm.Script throws on ESM syntax, which is exactly what the host would do.
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'client.js' }))
})

test('the panel module registers itself and exposes the apply contract', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const seen = []

  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => seen.push(registration) } },
    console,
    document: undefined,
  }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

  assert.equal(seen.length, 1, 'exactly one module registration is expected')
  const [registration] = seen
  assert.equal(registration.id, 'dsh-jev')
  assert.equal(typeof registration.factory, 'function')

  // Minimal react surface: the panel only builds elements and holds state.
  const element = (type, props, ...children) => ({ type, props, children })
  const react = {
    createElement: element,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    Fragment: 'Fragment',
  }
  const exports = registration.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })

  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots'])

  const effects = []
  const slots = []
  const ctx = {
    effect: (fn, label) => effects.push({ label, dispose: fn() }),
    slots: {
      inject: (name, factory) => slots.push({ name, result: factory() }),
      register: (config, component) => ({ config, component }),
    },
  }
  exports.apply(ctx)

  assert.equal(effects.length, 1, 'the panel installs its styles through an effect')
  assert.equal(slots.length, 1)
  assert.equal(slots[0].name, 'settings.section')
  assert.equal(slots[0].result.config.id, 'jev')
  assert.equal(slots[0].result.config.order, 25)
  assert.equal(typeof slots[0].result.component, 'function')
})

test('every key in the shipped bundle config is declared in the types', () => {
  const declared = new Set([
    ...interfaceFields('TypeSafeSuiteConfig'),
    ...interfaceFields('TypeSafeClientConfig'),
    ...interfaceFields('LoopGuardConfig'),
    ...interfaceFields('SafetyGuardConfig'),
    ...interfaceFields('ToolPrunerConfig'),
    ...interfaceFields('SkillRouterConfig'),
    ...interfaceFields('ResultShaperConfig'),
  ])

  const keys = patchConfigKeys()
  assert.ok(keys.length >= 4, 'expected the shipped config to name its sections, saw ' + keys.join(', '))
  const unknown = keys.filter((key) => !declared.has(key))
  assert.deepEqual(unknown, [], 'cordis.patch.yml names keys the schema rejects: ' + unknown.join(', '))
})

/** The YAML list items nested under one `key:` inside the shipped config. */
function patchList(key) {
  const lines = PATCH.split('\n')
  const start = lines.findIndex((line) => line.trim() === key + ':')
  assert.ok(start >= 0, 'cordis.patch.yml does not configure ' + key)
  const keyIndent = lines[start].length - lines[start].trimStart().length
  const items = []
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= keyIndent) break
    if (trimmed.startsWith('- ')) items.push(trimmed.slice(2))
  }
  return items
}

test('the shipped bundle protects at least the tools the library guards by default', () => {
  const shipped = new Set(patchList('guardedTools'))
  const missing = DEFAULT_GUARDED_TOOLS.filter((tool) => !shipped.has(tool))
  assert.deepEqual(
    missing,
    [],
    'the bundle config silently narrows the guarded set: ' + missing.join(', ')
  )
  // File writes carry credential material into repositories, so their absence
  // would be a security regression rather than a preference.
  for (const tool of ['write_to_file', 'replace_file_content']) {
    assert.ok(shipped.has(tool), tool + ' must be inspected by the shipped bundle')
  }
})

test('the shipped bundle never drops a default always-retain tool', () => {
  const shipped = new Set(patchList('alwaysRetain'))
  const missing = DEFAULT_ALWAYS_RETAIN.filter((tool) => !shipped.has(tool))
  assert.deepEqual(missing, [], 'the bundle config stops retaining: ' + missing.join(', '))
})

test('the manifest points at files that exist and ships every exported module', () => {
  assert.ok(existsSync(join(ROOT, pkg.main)), 'main entry missing')
  assert.ok(existsSync(join(ROOT, pkg.types)), 'types entry missing')
  assert.ok(existsSync(join(ROOT, pkg.dsh.bundle.patch)), 'bundle patch missing')

  for (const [name, target] of Object.entries(pkg.exports)) {
    assert.ok(existsSync(join(ROOT, target.default)), 'export ' + name + ' points at a missing file')
    assert.ok(existsSync(join(ROOT, target.types)), 'export ' + name + ' has no types file')
  }

  const shipped = new Set(pkg.files)
  assert.ok(shipped.has('lib'), 'the lib directory must ship')
  assert.ok(existsSync(join(ROOT, 'lib', 'client.js')), 'the settings panel bundle must ship')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'), 'settings slot dependency')
})

test('the settings panel polls the route the host actually registers', () => {
  const clientSource = readFileSync(join(ROOT, 'src', 'client.ts'), 'utf8')
  const indexSource = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')

  const requested = clientSource.match(/return '(\/api\/[^']+)'/)
  assert.ok(requested, 'the panel must fetch a concrete stats route')

  // Both the connection route and the web server route must serve that path;
  // a mismatch leaves the panel silently empty.
  const served = [...indexSource.matchAll(/path: '(\/api\/[^']+)'/g)].map((match) => match[1])
  assert.ok(served.length >= 2, 'expected the connection and web server routes')

  for (const path of served) {
    assert.equal(path, requested[1], 'a registered route differs from the panel endpoint')
  }

  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(bundle.includes(requested[1]), 'the built panel must carry the same endpoint')
})

/** The scalar value pinned for one `key:` inside the shipped config. */
function patchScalar(key) {
  const line = PATCH.split('\n').find((entry) => entry.trim().startsWith(key + ':'))
  assert.ok(line, 'cordis.patch.yml does not configure ' + key)
  const raw = line.trim().slice(key.length + 1).trim()
  if (raw === 'true') return true
  if (raw === 'false') return false
  const asNumber = Number(raw)
  return Number.isFinite(asNumber) && raw.length > 0 ? asNumber : raw
}

/** Every scalar pinned inside the shipped config: `key: value` on one line. */
function patchScalars() {
  const lines = PATCH.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'config:')
  assert.ok(start >= 0, 'cordis.patch.yml has no config block')
  const configIndent = lines[start].length - lines[start].trimStart().length
  const scalars = {}
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= configIndent) break
    const match = line.match(/^\s+(\w+):\s+(\S+)\s*$/)
    if (!match) continue
    const raw = match[2]
    scalars[match[1]] = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw
  }
  return scalars
}

test('every value the shipped bundle pins still matches the code default', () => {
  // A patch replaces the row's whole config, so these values are what every user
  // actually runs. If a code default moves and the patch keeps the old number, the
  // deployed behaviour silently contradicts the documented default: the README is
  // checked against the code, but nothing checked the patch. Keys the patch omits
  // fall back to the code default by construction, so absence is fine.
  const DEFAULTS = {
    triggerThreshold: DEFAULT_TRIGGER_THRESHOLD,
    noProgressThreshold: DEFAULT_NO_PROGRESS_THRESHOLD,
    pLoopThreshold: DEFAULT_P_LOOP_THRESHOLD,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    cooldownSteps: DEFAULT_COOLDOWN_STEPS,
    maxHistory: DEFAULT_MAX_HISTORY,
    deferExactRepeats: true,
    blockThreshold: DEFAULT_BLOCK_THRESHOLD,
    askApprovalThreshold: DEFAULT_ASK_APPROVAL_THRESHOLD,
    onError: 'deny-guarded',
    onUncertain: 'deny-guarded',
    maxTools: DEFAULT_MAX_TOOLS,
    minScoreThreshold: 2,
    minIntentChars: DEFAULT_MIN_INTENT_CHARS,
    minKeep: DEFAULT_MIN_KEEP,
  }

  const pinned = patchScalars()
  assert.ok(Object.keys(pinned).length > 0, 'the shipped patch should pin the reviewed defaults')

  for (const [key, value] of Object.entries(pinned)) {
    assert.ok(
      Object.hasOwn(DEFAULTS, key),
      'cordis.patch.yml pins "' + key + '"; register it here so a code default change cannot drift past'
    )
    assert.equal(value, DEFAULTS[key], 'cordis.patch.yml pins ' + key + ' away from the code default')
  }
})
test('the shipped bundle leaves the experimental shaper off', () => {
  // result-shaper changes what the model sees and is opt-in; shipping a patch that
  // enables it would contradict both the README and the module's own contract.
  assert.doesNotMatch(PATCH, /^\s*resultShaper:/m, 'the shipped patch must not enable resultShaper')
  assert.doesNotMatch(PATCH, /^\s*askTools:/m, 'the shipped patch should lean on the code default here')
})

test('the published tarball carries everything the host loads and nothing else', () => {
  // The host loads three things from the package: the plugin entry, the settings
  // panel bundle, and the patch file `dsh.bundle.patch` points at. The repository
  // assertions above only prove those exist here; the tarball is what users get, and
  // a `files` edit that dropped the patch would break the bundle mount silently.
  const packed = JSON.parse(
    // Windows exposes npm as a .cmd shim, so the pack call needs a shell.
    execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true })
  )[0].files.map((entry: { path: string }) => entry.path) as string[]

  const required = [
    'package.json',
    pkg.main.replace(/^\.\//, ''),
    pkg.types.replace(/^\.\//, ''),
    pkg.dsh.bundle.patch.replace(/^\.\//, ''),
    'lib/client.js',
    'README.md',
    'CHANGELOG.md',
  ]
  const missing = required.filter((file) => !packed.includes(file))
  assert.deepEqual(missing, [], 'the tarball is missing files the host needs')

  // Everything the build produces must ship, so a new module cannot be forgotten.
  const built = readdirSync(join(ROOT, 'lib')).filter((name) => name.endsWith('.js'))
  const missingModules = built.filter((name) => !packed.includes('lib/' + name))
  assert.deepEqual(missingModules, [], 'the tarball omits built modules')

  // Tests, scratch files and the bench are development-only.
  const noise = packed.filter((file) => /^(tests|tmp|bench|scripts|src|\.github)\//.test(file))
  assert.deepEqual(noise, [], 'the tarball ships development files')
})

test('the client half declares the platform and slot this deployment loads', () => {
  // The settings panel only loads if the manifest's client block matches the host's
  // platform id and injects a slot the host provides. Both were checked against the
  // plugins that already work in this deployment - dshmarket and
  // dsh-commandcode-usage declare `platform: "web"` and inject
  // @deepseek-ai/dsh-client-ui-settings, the same pair this manifest uses.
  assert.equal(pkg.dsh?.client?.platform, 'web', 'the panel is registered for a platform the host does not use')
  assert.ok(
    Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'),
    'the panel must inject the settings slot'
  )
  // Shipping the client half is what makes DSH load it at all.
  assert.ok(existsSync(join(ROOT, 'lib', 'client.js')), 'the built panel bundle is missing')
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('lib'), 'lib must be shipped for the panel to load')
})

test('the panel refreshes on a short timer instead of once', () => {
  // The dashboard is only useful if it polls: a 4000ms interval is the whole mechanism,
  // and nothing pinned it, so a thousand-fold change still passed every test.
  const source = readFileSync(join(ROOT, 'src', 'client.ts'), 'utf8')
  const poll = source.match(/setInterval\([^,]+,\s*([0-9_]+)\s*\)/)
  assert.ok(poll, 'the panel must poll rather than load once')
  const delay = Number(poll![1].replace(/_/g, ''))
  assert.ok(delay > 0 && delay <= 10_000, 'the poll interval must be a few seconds, got ' + delay + 'ms')
})
