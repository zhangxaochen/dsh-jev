/**
 * Claims about the host that this plugin depends on.
 *
 * The README's division-of-labour table names DSH built-ins, and one of them is
 * load-bearing rather than decorative: `loopGuard.deferExactRepeats` yields exact
 * repeats to `dsh-repeat-tool-reminder`, so that package has to keep existing and
 * keep its thresholds. The hook signatures the guards use are the same kind of
 * dependency - section 15 of the calibration record had to correct an assumption
 * about them once already, which is exactly why they belong in a gate.
 *
 * Skips when no DSH runtime is installed; the integration script covers the same
 * ground through live services on a machine that has one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_PACKAGES = [
  'dsh-repeat-tool-reminder',
  'dsh-spill-policy',
  'dsh-compaction-tool-result-pruner',
]

function dshNodeModules(): string | undefined {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
  for (const profile of ['desktop', 'web', 'headless', 'tui', 'acp']) {
    const root = join(dshHome, 'profiles', profile, 'node_modules')
    if (existsSync(join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))) return root
  }
  return undefined
}

/** Pre-release aware comparison of two `major.minor.patch[-prerelease]` strings. */
function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core, pre = ''] = value.split('-')
    return { nums: core.split('.').map(Number), pre }
  }
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff
  }
  // A release outranks its own pre-releases.
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

/** Parse the minimum from an `engines` range like `>=0.1.5-rc.2`. */
function minimumFromRange(range: string): string {
  const match = range.match(/>=\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/)
  assert.ok(match, 'engines range must state a minimum the gate can compare: ' + range)
  return match[1]
}

const nodeModules = dshNodeModules()

test('the DSH built-ins the division of labour names are installed', { skip: !nodeModules }, () => {
  for (const pkg of DSH_PACKAGES) {
    const entry = join(nodeModules!, '@deepseek-ai', pkg, 'lib', 'index.js')
    assert.ok(existsSync(entry), pkg + ' is named in README but is not installed')
  }
})

test('the repeat reminder still owns exact repeats with its documented thresholds', { skip: !nodeModules }, () => {
  // deferExactRepeats: true hands these calls to the built-in, so its defaults
  // are part of this plugin's contract.
  const source = readFileSync(join(nodeModules!, '@deepseek-ai', 'dsh-repeat-tool-reminder', 'lib', 'index.js'), 'utf8')
  const defaults = source.match(/thresholds:[\s\S]*?\.default\(\s*\[([^\]]*)\]/)
  assert.ok(defaults, 'the repeat reminder no longer declares a thresholds default')
  const values = defaults![1]
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value))
  assert.deepEqual(values, [3, 5, 8], 'README documents thresholds 3/5/8 for the built-in')
})

test('the installed DSH satisfies the engine range we publish', { skip: !nodeModules }, () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  const range = String(manifest.engines?.dsh ?? '')
  assert.ok(range.length > 0, 'package.json must state the DSH version it supports')

  const installed = JSON.parse(readFileSync(join(nodeModules!, '@deepseek-ai', 'dsh-tools', 'package.json'), 'utf8')).version
  const minimum = minimumFromRange(range)
  assert.ok(
    compareVersions(installed, minimum) >= 0,
    'installed DSH ' + installed + ' is below the published minimum ' + minimum
  )
})

test('the host dispatches the hooks with the argument counts the guards assume', { skip: !nodeModules }, async () => {
  // Section 15 of the calibration record had to correct an assumption about these
  // shapes, so they are asserted rather than left to prose.
  const toolsSource = readFileSync(join(nodeModules!, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'), 'utf8')

  // pre-execute is dispatched from inside the execution pipeline, so its shape is
  // read from the call site: the payload arguments are `exec` alone.
  assert.match(
    toolsSource,
    /waterfall\([^;]*?"tools\/pre-execute",\s*exec,\s*\(\)\s*=>/,
    'pre-execute must dispatch (exec, next); the listener signature depends on it'
  )

  // post-execute is driven below, so both its call site and its measured shape are
  // checked: the payload arguments are `exec, result`.
  assert.match(
    toolsSource,
    /waterfall\([^;]*?"tools\/post-execute",\s*exec,\s*result,\s*\(\)\s*=>/,
    'post-execute must dispatch (exec, result, next); the listener signature depends on it'
  )

  const load = (pkg: string) => import(pathToFileURL(join(nodeModules!, '@deepseek-ai', pkg, 'lib', 'index.js')).href)
  const { Context } = await load('cordis')
  const SystemPrompt = await load('dsh-system-prompt')
  const Tools = await load('dsh-tools')

  const ctx = new Context()
  ctx.plugin((SystemPrompt as any).default ?? SystemPrompt)
  ctx.plugin((Tools as any).default ?? Tools, { mode: 'native' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const tools = ctx.get('tools')
  const seen: unknown[][] = []
  ctx.on('tools/post-execute', (...args: any[]) => {
    seen.push(args)
    return args[args.length - 1]()
  })

  await tools.postExecute(
    {
      name: 'probe_tool',
      args: {},
      agent: { id: 'contract' },
      token: 't',
      callId: 'c',
      signal: new AbortController().signal,
    },
    { content: [{ type: 'text', text: 'ok' }] }
  )

  assert.equal(seen.length, 1, 'the post-execute listener must be reached')
  const args = seen[0]
  assert.equal(args.length, 3, 'the listener receives (exec, result, next)')
  assert.equal((args[0] as any)?.name, 'probe_tool', 'the first argument is the execution')
  assert.ok(Array.isArray((args[1] as any)?.content), 'the second argument is the result')
  assert.equal(typeof args[2], 'function', 'the third argument is the continuation')
})
test('the patch semantics the README warns about are still the host ones', { skip: !nodeModules }, () => {
  // The README tells users a patch replaces the targeted row's whole config, which
  // it quotes from the host's own bundle patch. If DSH ever switches to a deep
  // merge, that warning becomes wrong advice, so the quote is checked against the
  // installed file.
  const base = join(nodeModules!, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml')
  assert.ok(existsSync(base), 'the dsh-base bundle patch should be installed')
  // The statement is wrapped across several comment lines, so strip the comment
  // markers and join before matching.
  const hostText = readFileSync(base, 'utf8')
    .replace(/^#\s?/gm, '')
    .replace(/\s+/g, ' ')

  assert.match(
    hostText,
    /replaces the targeted row's whole `config` rather than merging into it/,
    'the host no longer states the patch semantics the README quotes; re-verify the warning'
  )
  assert.match(hostText, /last write winning per row/, 'the host no longer states the per-row precedence')

  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
  assert.match(readme, /补丁是「整行替换」，不是逐键合并/, 'the README must keep the warning it quotes')
})

test('our shipped patch uses only the operations the host itself uses', { skip: !nodeModules }, () => {
  // A patch file with an operation the host does not implement would be ignored,
  // leaving the defaults unapplied with nothing to show for it.
  const ours = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
  const operations = [...ours.matchAll(/^-\s*([a-zA-Z-]+):/gm)].map((match) => match[1])
  assert.deepEqual(operations, ['insert'], 'the shipped patch is a single insert over the profile root')

  const rowKeys = [...ours.matchAll(/^\s{4}([a-zA-Z-]+):/gm)].map((match) => match[1])
  const hostKeys = new Set(['id', 'name', 'config', 'disabled', 'inject'])
  for (const key of new Set(rowKeys)) {
    assert.ok(hostKeys.has(key), 'row key "' + key + '" is not one the host bundle patches use')
  }

  const bundled = readFileSync(join(nodeModules!, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'), 'utf8')
  assert.match(bundled, /^-\s*insert:/m, 'the host bundles mount the same way ours does')
})
