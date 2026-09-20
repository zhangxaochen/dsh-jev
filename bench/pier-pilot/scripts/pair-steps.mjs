// Across every completed pair, compare the arms' step counts and rewards.
//
// One lost task could be noise. If the plugin arm systematically stops earlier, that is a
// mechanism worth naming: fewer steps means less work, which costs reward on tasks that are
// not saturated.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const PILOT = 'D:/code/dsh-jev/tmp/pier-pilot'
const JOBS = 'D:/code/deep-swe/jobs'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ids = readFileSync(join(PILOT, 'top20-ids.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)

function decode(file) {
  const buffer = readFileSync(file)
  const offsets = []
  let index = buffer.indexOf(MAGIC)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(MAGIC, index + 4)
  }
  let text = ''
  for (let i = 0; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8')
    } catch {}
  }
  return text
}

function armOf(base) {
  const setup = join(base, 'artifacts', 'agent', 'setup.txt')
  if (!existsSync(setup)) return undefined
  return readFileSync(setup, 'utf8').includes('plugin in profile:') ? 'B' : 'A'
}

function steps(base) {
  const session = join(base, 'artifacts', 'agent', 'sessions', 'session.v3.jsonl.zstd')
  if (!existsSync(session)) return undefined
  return decode(session).split('\n').filter((line) => line.includes('"step/start"')).length
}

const pairs = new Map()
if (existsSync(JOBS)) {
  for (const job of readdirSync(JOBS)) {
    if (!job.startsWith('2026-09-20')) continue
    for (const inner of readdirSync(join(JOBS, job))) {
      const base = join(JOBS, job, inner)
      const prefix = inner.split('__')[0]
      const task = ids.find((id) => id.startsWith(prefix) || prefix.startsWith(id.slice(0, 28)))
      if (!task) continue
      const arm = armOf(base)
      const rewardFile = join(base, 'verifier', 'reward.json')
      if (!arm || !existsSync(rewardFile)) continue
      let reward
      try {
        reward = JSON.parse(readFileSync(rewardFile, 'utf8')).reward
      } catch {}
      if (reward === undefined || reward < 0) continue
      const entry = pairs.get(task) ?? {}
      // Prefer whichever run carries a session file.
      if (!entry[arm] || (!entry[arm].steps && steps(base))) entry[arm] = { reward, steps: steps(base), job }
      pairs.set(task, entry)
    }
  }
}

console.log('| task | A steps | A reward | B steps | B reward | Δ steps (B−A) |')
console.log('| --- | --- | --- | --- | --- | --- |')
const deltas = []
for (const task of ids) {
  const entry = pairs.get(task)
  if (!entry?.A || !entry?.B) continue
  const delta = entry.A.steps && entry.B.steps ? entry.B.steps - entry.A.steps : undefined
  if (delta !== undefined) deltas.push(delta)
  console.log(
    `| ${task} | ${entry.A.steps ?? '-'} | ${entry.A.reward} | ${entry.B.steps ?? '-'} | ${entry.B.reward} | ${
      delta === undefined ? '-' : (delta > 0 ? '+' : '') + delta
    } |`
  )
}
if (deltas.length) {
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
  const wins = deltas.filter((d) => d < 0).length
  console.log(`\n对比 ${deltas.length} 对：平均步数差 ${mean.toFixed(1)}（负数 = 插件臂更少步 ✓），插件臂步数更少的 ${wins}/${deltas.length}`)
}
