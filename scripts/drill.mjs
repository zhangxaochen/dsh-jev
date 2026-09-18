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
import { readFileSync, writeFileSync } from 'node:fs'

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
]

const results = []
for (const drill of drills) {
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
      try {
        execFileSync(process.execPath, ['--import', './tests/isolate.mjs', '--test', drill.test], {
          stdio: 'ignore',
        })
      } catch (err) {
        exitCode = typeof err.status === 'number' ? err.status : 1
      }
    }
    results.push({
      name: drill.name,
      caught: buildCode !== 0 || exitCode !== 0,
      why: buildCode !== 0 ? 'build failed' : drill.test + ' exit ' + exitCode,
    })
  } finally {
    writeFileSync(drill.file, original, 'utf8')
  }
}

let missed = 0
for (const result of results) {
  if (!result.caught) missed += 1
  console.log((result.caught ? 'CAUGHT ' : 'MISSED ') + result.name.padEnd(52) + ' <- ' + result.why)
}
console.log('\n' + (results.length - missed) + '/' + results.length + ' regressions caught by the net')

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
