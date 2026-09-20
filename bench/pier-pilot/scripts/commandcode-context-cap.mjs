#!/usr/bin/env node
/**
 * Local, non-upstream patch for `@mars-sea/dsh-commandcode-provider`.
 *
 * WHY: the adapter takes every model's context window straight from the Command
 * Code catalog (`CommandCodeAdapter.resolveModel()` -> `context.contextWindow`),
 * and its `Config` schema has no field that lowers it. The DeepSeek provider has
 * one (`llm-deepseek.models[].contextWindow`, edited by the Models page), so
 * `commandcode` is the only route where the window cannot be capped by config.
 *
 * WHAT: this patch adds the same capability to the commandcode route — a
 * `contextWindowOverrides` map in the `llm-commandcode` settings section:
 *
 *   llm-commandcode:
 *     contextWindowOverrides:
 *       deepseek/deepseek-v4.1-flash: 300000
 *
 * Edits per installed `lib/index.js`:
 *   1. `contextWindowOverrides: z.dict(z.number())` in the Config schema, so the
 *      settings section validates and keeps the key;
 *   2. `readContextWindowOverrides()` plus `commandcodeContextWindow()`;
 *   3. `resolveAdapterOptions()` passes the map through to the adapter;
 *   4. `resolveModel()` (the path `LlmAdapter.prepareCall()` uses, so token
 *      metering, the context ring, and compaction all see the capped window);
 *   5. `listModels()` (the model picker's window badge).
 *
 * USAGE
 *   node ~/.dsh/patches/commandcode-context-cap.mjs            # apply (idempotent)
 *   node ~/.dsh/patches/commandcode-context-cap.mjs --check    # report only, exit 1 when not in effect
 *
 * The VALUE lives in `~/.dsh/settings.yaml`, never in this script and never in
 * the patched bundle: an upgrade replaces `lib/index.js` (re-run this script),
 * but the settings block survives and keeps capping. Re-run after every
 * `dsh plugin` install/upgrade of this plugin.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const NS = 'llm-commandcode'
const FIELD = 'contextWindowOverrides'
const SETTINGS = join(homedir(), '.dsh', 'settings.yaml')
const PLUGIN = join('@mars-sea', 'dsh-commandcode-provider', 'lib', 'index.js')
const PROFILES = ['desktop', 'tui', 'web', 'acp', 'headless']
const MARKER = 'commandcodeContextWindow'
/** Marker of the superseded v1 patch (caps table baked into the bundle). */
const V1_MARKER = 'COMMANDCODE_CONTEXT_WINDOW_CAPS'

const HELPER = `/**
* LOCAL PATCH (not upstream): per-model context-window caps from the
* \`${NS}.${FIELD}\` settings key. Re-apply the support patch with
* \`node ~/.dsh/patches/commandcode-context-cap.mjs\` after a plugin upgrade.
*/
function commandcodeContextWindow(model, contextWindow, overrides) {
	const cap = overrides === void 0 ? void 0 : overrides[model];
	return contextWindow !== void 0 && cap !== void 0 && contextWindow > cap ? cap : contextWindow;
}
var CommandCodeAdapter = class extends LlmAdapter {`

/** Anchors, in apply order. Each `from` must occur exactly once in a clean bundle. */
const EDITS = [
  {
    name: 'Config schema',
    from: '	modelVisibility: z.dict(z.boolean()),',
    to: `	modelVisibility: z.dict(z.boolean()),
	contextWindowOverrides: z.dict(z.number()),`,
  },
  {
    name: 'cap helper',
    from: 'var CommandCodeAdapter = class extends LlmAdapter {',
    to: HELPER,
  },
  {
    name: 'overrides reader',
    from: `function readModelVisibility(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const entries = Object.entries(raw).filter((entry) => entry[0] !== "" && typeof entry[1] === "boolean");
	return entries.length === 0 ? void 0 : Object.fromEntries(entries);
}`,
    to: `function readModelVisibility(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const entries = Object.entries(raw).filter((entry) => entry[0] !== "" && typeof entry[1] === "boolean");
	return entries.length === 0 ? void 0 : Object.fromEntries(entries);
}
/**
* Per-model context-window caps from the settings section, cleaned for the
* adapter. A non-object or a non-positive-integer entry is dropped rather than
* reaching the model info the harness meters against.
* @param raw - The \`${FIELD}\` value from any config source.
* @returns A frozen model id -> window map, or undefined when nothing is set.
*/
function readContextWindowOverrides(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const entries = Object.entries(raw).filter((entry) => entry[0] !== "" && typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0);
	return entries.length === 0 ? void 0 : Object.fromEntries(entries);
}`,
  },
  {
    name: 'resolveAdapterOptions',
    from: `		modelVisibility: readModelVisibility(config.modelVisibility)
	};`,
    to: `		modelVisibility: readModelVisibility(config.modelVisibility),
		contextWindowOverrides: readContextWindowOverrides(config.${FIELD})
	};`,
  },
  {
    name: 'resolveModel',
    from: `		const entry = this.catalog.find((m) => m.id === model) ?? (await this.loadCatalog(signal)).find((m) => m.id === model);
		const efforts = KNOWN_EFFORTS[model];
		const vision = KNOWN_IMAGE_MODELS.has(model);
		return {
			provider,
			id: model,
			name: entry ? \`\${entry.name} (CC)\` : model,
			description: capabilityDescription(model, entry?.contextWindow),
			inputModalities: vision ? ["text", "image"] : ["text"],
			...entry ? {
				context: { contextWindow: entry.contextWindow },`,
    to: `		const entry = this.catalog.find((m) => m.id === model) ?? (await this.loadCatalog(signal)).find((m) => m.id === model);
		const contextWindow = commandcodeContextWindow(model, entry?.contextWindow, this.deps.options().${FIELD});
		const efforts = KNOWN_EFFORTS[model];
		const vision = KNOWN_IMAGE_MODELS.has(model);
		return {
			provider,
			id: model,
			name: entry ? \`\${entry.name} (CC)\` : model,
			description: capabilityDescription(model, contextWindow),
			inputModalities: vision ? ["text", "image"] : ["text"],
			...entry ? {
				context: { contextWindow },`,
  },
  {
    name: 'listModels',
    from: `	async listModels(provider, opts) {
		const catalog = await this.loadCatalog();
		const toInfo = (model) => {
			const vision = KNOWN_IMAGE_MODELS.has(model.id);
			return {
				provider,
				id: model.id,
				name: \`\${model.name} (CC)\`,
				description: capabilityDescription(model.id, model.contextWindow),`,
    to: `	async listModels(provider, opts) {
		const catalog = await this.loadCatalog();
		const contextWindowOverrides = this.deps.options().${FIELD};
		const toInfo = (model) => {
			const vision = KNOWN_IMAGE_MODELS.has(model.id);
			return {
				provider,
				id: model.id,
				name: \`\${model.name} (CC)\`,
				description: capabilityDescription(model.id, commandcodeContextWindow(model.id, model.contextWindow, contextWindowOverrides)),`,
  },
]

/** Undo the superseded v1 patch (a caps table baked into the bundle). */
function stripV1(source) {
  if (!source.includes(V1_MARKER)) return source
  return source
    .replace(/\/\*\*\n\* LOCAL PATCH[\s\S]*?\nfunction commandcodeContextWindow\(model, contextWindow\) \{[\s\S]*?\n\}\n/, '')
    .replace('commandcodeContextWindow(model.id, model.contextWindow)', 'model.contextWindow')
    .replace('const contextWindow = commandcodeContextWindow(model, entry?.contextWindow);\n\t\t', '')
    .replace('description: capabilityDescription(model, contextWindow),', 'description: capabilityDescription(model, entry?.contextWindow),')
    .replace('context: { contextWindow },', 'context: { contextWindow: entry.contextWindow },')
}

/**
 * Replace a file's contents without exposing a half-written module to a
 * concurrent reader (DSH may be importing this bundle while the patch runs).
 * @param file - absolute path to rewrite.
 * @param text - complete new contents.
 */
function writeAtomic(file, text) {
  const staging = `${file}.patch-tmp`
  writeFileSync(staging, text)
  renameSync(staging, file)
}

/**
 * Rewrite one bundle in place.
 * @param file - absolute path of the installed `lib/index.js`.
 * @returns `patched`, `repaired`, or `clean`.
 */
function applyOne(file) {
  const original = readFileSync(file, 'utf8')
  const staged = stripV1(original)
  const current = staged.includes('function commandcodeContextWindow(model, contextWindow, overrides)')
  if (current) {
    // Support already present; only rewrite when the file still carries v1 leftovers.
    return staged === original ? 'clean' : (writeAtomic(file, staged), 'repaired')
  }
  let patched = staged
  for (const edit of EDITS) {
    const occurrences = patched.split(edit.from).length - 1
    if (occurrences !== 1) throw new Error(`anchor for "${edit.name}" matched ${occurrences} times — upstream changed; adapt the script`)
    patched = patched.replace(edit.from, edit.to)
  }
  writeAtomic(file, patched)
  return 'patched'
}

/** Every installed copy of the plugin, one per profile that has it. */
function installedFiles() {
  return PROFILES
    .map((profile) => join(homedir(), '.dsh', 'profiles', profile, 'node_modules', PLUGIN))
    .filter((file) => existsSync(file))
}

/**
 * Read `llm-commandcode.contextWindowOverrides` out of settings.yaml.
 * @param text - raw settings.yaml contents.
 * @returns model id -> window map, or undefined when the namespace is absent.
 */
function readOverridesFromSettings(text) {
  const lines = text.split(/\r?\n/)
  const nsAt = lines.findIndex((line) => /^llm-commandcode:\s*(?:#.*)?$/.test(line))
  if (nsAt < 0) return undefined
  const out = {}
  let inBlock = false
  for (let index = nsAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) break
    if (new RegExp(`^\\s{2}${FIELD}:\\s*(?:#.*)?$`).test(line)) {
      inBlock = true
      continue
    }
    if (inBlock && indent >= 4) {
      const matched = /^\s+("[^"]+"|'[^']+'|[^:#]+):\s*(\d+)\s*(?:#.*)?$/.exec(line)
      if (matched !== null) out[matched[1].trim().replace(/^["']|["']$/g, '')] = Number(matched[2])
      continue
    }
    inBlock = false
  }
  return out
}

/**
 * Report whether the cap is supported by the bundle AND in effect for the
 * settings values.
 * @param file - absolute path of the installed `lib/index.js`.
 * @returns `ok`, `clean` (unpatched), `stale` (v1 patch), or `mismatch`.
 */
async function checkOne(file, overrides) {
  const source = readFileSync(file, 'utf8')
  if (source.includes(V1_MARKER)) return 'stale'
  if (!source.includes('function commandcodeContextWindow(model, contextWindow, overrides)')) return 'clean'
  const mod = await import(pathToFileURL(file).href)
  for (const [id, cap] of Object.entries(overrides)) {
    const adapter = Object.create(mod.CommandCodeAdapter.prototype)
    adapter.deps = { options: () => ({ contextWindowOverrides: overrides }) }
    // The catalog reports a window 10x the cap, so the probe proves the clamp runs.
    adapter.catalog = [{ id, name: id, contextWindow: cap * 10, maxTokens: 65_536 }]
    const info = await adapter.resolveModel('commandcode', id)
    if (info.context?.contextWindow !== cap) return 'mismatch'
  }
  return 'ok'
}

const installed = installedFiles()
if (installed.length === 0) {
  console.error('no installed commandcode plugin found under ~/.dsh/profiles/*/node_modules — nothing to patch')
  process.exit(1)
}

const settingsText = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : ''
const overrides = readOverridesFromSettings(settingsText)

if (!process.argv.includes('--check')) {
  for (const file of installed) {
    const profile = file.split(/[\\/]/).at(-6)
    try {
      const state = applyOne(file)
      console.log(`${profile}: ${state === 'clean' ? 'clean (support patch already present)' : state} (${file})`)
    } catch (error) {
      console.error(`${profile}: ${error.message}`)
      process.exitCode = 1
    }
  }
  if (overrides === undefined || Object.keys(overrides).length === 0) {
    console.log(`\n${NS}.${FIELD} is not set in ${SETTINGS}; add:\n`)
    console.log(`${NS}:\n  ${FIELD}:\n    deepseek/deepseek-v4.1-flash: 300000\n`)
  }
  process.exit(process.exitCode ?? 0)
}

let failed = overrides === undefined || Object.keys(overrides).length === 0
if (failed) {
  console.error(`${NS}.${FIELD} is empty or missing in ${SETTINGS} — the patch is installed but caps nothing`)
} else {
  console.log(`settings: ${Object.entries(overrides).map(([id, cap]) => `${id} -> ${cap}`).join(', ')}`)
}
for (const file of installed) {
  const profile = file.split(/[\\/]/).at(-6)
  if (failed) continue
  const state = await checkOne(file, overrides)
  const label = {
    ok: 'cap in effect',
    clean: 'NOT PATCHED (support patch missing — re-run without --check)',
    stale: 'v1 patch still present — re-run without --check',
    mismatch: 'PROBE MISMATCH — bundle ignores the settings value',
  }[state]
  if (state !== 'ok') failed = true
  console.log(`${profile}: ${label}`)
}
process.exit(failed ? 1 : 0)
