/**
 * Regression drill for the verification net.
 *
 * For each guarantee the repository claims, inject the regression it exists to
 * catch, rebuild, and run the spec that owns it. A guarantee whose regression
 * slips through every gate is a hole: the check either does not run or is masked
 * by another condition (both happened when this was first written).
 *
 * Every mutation is restored in a finally block, but a killed process can leave
 * one file changed, so this refuses to start unless the working tree is clean.
 *
 * Usage: pnpm run drill
 */// Regression drill: for each guarantee, inject the regression it exists to catch
// and check that a gate fails. Runs in a clone; every mutation is restored.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Refuse to run against a dirty tree: a mutation that survives a crash would
// otherwise be indistinguishable from the operator's own work in progress.
const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
if (status.trim().length > 0) {
  console.error('refusing to run: commit or stash the working tree first')
  process.exit(2)
}

const drills = [
  {
    name: 'shipped bundle guards fewer tools',
    file: 'cordis.patch.yml',
    from: '            - write_to_file\n',
    to: '',
    test: 'tests/packaging.spec.ts',
  },
  {
    name: 'documented default differs from the code',
    file: 'README.md',
    from: '`pLoopThreshold?: number`: 「确定死循环」桶的概率质量阈值，范围 0~1（默认 `0.6`）',
    to: '`pLoopThreshold?: number`: 「确定死循环」桶的概率质量阈值，范围 0~1（默认 `0.9`）',
    test: 'tests/docs-consistency.spec.ts',
  },
  {
    name: 'panel polls a route the host does not serve',
    file: 'src/client.ts',
    from: "return '/api/dsh-jev/stats'",
    to: "return '/api/dsh-jev/stats-v2'",
    test: 'tests/packaging.spec.ts',
  },
  {
    name: 'per-item question stops carrying its item',
    file: 'src/tool-pruner.ts',
    from: '`How relevant is the tool "${tool.name}" (${tool.description || \'no description\'}) to fulfilling the user goal: "${userIntent.slice(0, 300)}"?`',
    to: '`How relevant is this tool to fulfilling the user goal: "${userIntent.slice(0, 300)}"?`',
    test: 'tests/question-binding.spec.ts',
  },
  {
    name: 'loop guard stops requiring answer confidence',
    file: 'src/loop-guard.ts',
    from: 'export const DEFAULT_MIN_CONFIDENCE = 0.5',
    to: 'export const DEFAULT_MIN_CONFIDENCE = 0',
    test: 'tests/loop-guard.spec.ts',
  },
  {
    name: 'safety guard falls open on an unusable verdict',
    file: 'src/safety-guard.ts',
    from: "const onError = config.onError ?? 'deny-guarded'",
    to: "const onError = config.onError ?? 'allow'",
    test: 'tests/resilience.spec.ts',
  },
  {
    name: 'dashboard stops showing a measured section',
    file: 'src/metrics.ts',
    from: '`| **🧩 语义结果整形** | 整形 **${this.state().resultShaper.shaped}** 次，精确移除 **${this.state().resultShaper.charsRemoved}** 字符 | 默认关闭；仅对输出密集型工具的重复内容生效，不可用时原样返回 |`,\n',
    to: '',
    test: 'tests/metrics-surface.spec.ts',
  },
  {
    name: 'a verification script writes the operator state',
    file: 'tests/live-pruner.ts',
    from: "process.env.DSH_JEV_METRICS_PATH ??= join(tmpdir(), 'jev-live-pruner-metrics.json')\n",
    to: '',
    test: 'tests/isolation.spec.ts',
  },
  {
    name: 'a missing answer is coerced into a safe value',
    file: 'src/typesafe-client.ts',
    from: "normalized[k] = raw === undefined ? { type: 'noul', unknown: true } : { type: 'noul', noul: raw, probability: raw }",
    to: "normalized[k] = raw === undefined ? { type: 'noul', noul: 0, probability: 0 } : { type: 'noul', noul: raw, probability: raw }",
    test: 'tests/ask-tools.spec.ts',
  },
  {
    name: 'pruner ranks by score instead of keeping order',
    file: 'src/tool-pruner.ts',
    from: 'const finalTools = candidates.filter((tool) => keep.has(tool))',
    to: 'const finalTools = [...retainedTools, ...selected]',
    test: 'tests/tool-pruner.spec.ts',
  },
  {
    // The two worst defects this work found — a waterfall listener that swallowed
    // the step decision (crash on restart) and a shaper that required a string
    // where the service passes blocks (module inert) — were invisible to the unit
    // suite and only caught by the real runtime. Drill them where they were found.
    name: 'pre-step listener swallows the downstream decision',
    file: 'src/loop-guard.ts',
    from: 'return typeof next === \'function\' ? next() : undefined',
    to: 'return undefined',
    command: ['tests/integration-dsh.mjs'],
  },
  {
    name: 'shaper requires a string where the service sends blocks',
    file: 'src/result-shaper.ts',
    from: '      const originalText = extractText(result.content)\n      if (originalText === undefined) return baseDecision',
    to: '      if (typeof result.content !== \'string\') return baseDecision\n      const originalText = result.content',
    command: ['tests/integration-dsh.mjs'],
  },
  {
    // The bench used to reimplement these two rules, so a changed shipped threshold
    // left the CI gate green. It now calls the shipped functions.
    name: 'loop guard threshold change reaches the bench',
    file: 'src/loop-guard.ts',
    from: 'export const DEFAULT_P_LOOP_THRESHOLD = 0.6',
    to: 'export const DEFAULT_P_LOOP_THRESHOLD = 0.99',
    command: ['--experimental-strip-types', 'bench/run.ts', '--offline', '--no-artifacts'],
  },
  // No drill for the removed argument-shape tolerance: with the real two-argument
  // pre-execute call its `hookArgs.length >= 3` guard never fired, so the code was
  // unreachable rather than wrong and there is no regression to inject. The
  // contract it obscured is pinned by the safety-guard case instead.
  {
    // verify:live is the evidence that the historical loop-guard false positives
    // are gone, and it used to restate the thresholds instead of calling the rule.
    name: 'loop guard threshold change reaches verify:live',
    file: 'src/loop-guard.ts',
    from: 'export const DEFAULT_P_LOOP_THRESHOLD = 0.6',
    to: 'export const DEFAULT_P_LOOP_THRESHOLD = 0.99',
    command: ['--experimental-strip-types', 'tests/live-verify.ts'],
    needsKey: true,
  },
  {
    // The bench cannot cover this one: its semantic cases all decide through
    // risk_score, and the model couples hazard with risk, so the hazard-threshold
    // bands are covered synthetically by the unit suite instead.
    name: 'safety guard block threshold is covered somewhere',
    file: 'src/safety-guard.ts',
    from: 'export const DEFAULT_BLOCK_THRESHOLD = 0.85',
    to: 'export const DEFAULT_BLOCK_THRESHOLD = 0.99',
    test: 'tests/safety-guard.spec.ts',
  },
]

/** Whether a live-model drill can run here. */
function hasApiKey() {
  if (process.env.TYPESAFE_API_KEY) return true
  return existsSync(join(process.env.USERPROFILE ?? homedir(), '.dsh', '.env'))
}

/** Whether this machine has a DSH runtime to drive the integration checks. */
function hasDshRuntime() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const profile of ['desktop', 'web', 'headless', 'tui', 'acp']) {
    if (existsSync(join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-tools'))) return true
  }
  return false
}

const results = []
for (const drill of drills) {
  // A script-based drill needs the real runtime; without it the integration script
  // skips by design, and reporting that as an uncaught regression would be wrong.
  if (drill.command && !hasDshRuntime()) {
    results.push({ name: drill.name, skipped: true, why: 'no DSH runtime on this machine' })
    continue
  }
  if (drill.needsKey && !hasApiKey()) {
    results.push({ name: drill.name, skipped: true, why: 'no API key on this machine' })
    continue
  }
  const original = readFileSync(drill.file, 'utf8')
  try {
    if (!original.includes(drill.from)) {
      results.push({ name: drill.name, caught: false, why: 'anchor not found in ' + drill.file })
      continue
    }
    writeFileSync(drill.file, original.replace(drill.from, drill.to), 'utf8')

    // The specs import the built output, so a src mutation is only visible after a
    // build — exactly what `pnpm test`'s pretest does in CI.
    let buildCode = 0
    try {
      execFileSync('pnpm', ['run', 'build'], { stdio: 'ignore', shell: true })
    } catch (err) {
      buildCode = typeof err.status === 'number' ? err.status : 1
    }

    let exitCode = 0
    if (buildCode === 0) {
      // A drill either names a spec or, for the guarantees only the real runtime
      // can exercise, a script that drives the real services.
      const args = drill.command
        ? [...drill.command]
        : ['--import', './tests/isolate.mjs', '--test', drill.test]
      try {
        execFileSync(process.execPath, args, { stdio: 'ignore' })
      } catch (err) {
        // The integration script reports a missing runtime by skipping, which is
        // not a caught regression.
        exitCode = typeof err.status === 'number' ? err.status : 1
      }
    }
    results.push({
      name: drill.name,
      caught: buildCode !== 0 || exitCode !== 0,
      why:
        buildCode !== 0
          ? 'build failed'
          : (drill.command ? drill.command[0] : drill.test) + ' exit ' + exitCode,
    })
  } finally {
    writeFileSync(drill.file, original, 'utf8')
  }
}

let missed = 0
let skipped = 0
for (const result of results) {
  if (result.skipped) {
    skipped += 1
    console.log('SKIPPED ' + result.name.padEnd(52) + ' <- ' + result.why)
    continue
  }
  if (!result.caught) missed += 1
  console.log((result.caught ? 'CAUGHT ' : 'MISSED ') + result.name.padEnd(52) + ' <- ' + result.why)
}
const ran = results.length - skipped
console.log(
  '\n' + (ran - missed) + '/' + ran + ' regressions caught by the net' +
    (skipped > 0 ? ' (' + skipped + ' skipped: no DSH runtime)' : '')
)

// Each iteration rebuilt lib/ from a mutated source, so the last build reflects a
// mutation that no longer exists. Rebuild once more and confirm the tree is back.
try {
  execFileSync('pnpm', ['run', 'build'], { stdio: 'ignore', shell: true })
} catch {
  console.error('the final rebuild failed; run `pnpm run build` before trusting the tree')
  process.exit(1)
}
const leftovers = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
if (leftovers.trim().length > 0) {
  console.error('the drill left changes behind:\n' + leftovers.trim())
  process.exit(1)
}

process.exit(missed === 0 ? 0 : 1)
