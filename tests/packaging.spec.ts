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
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

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
