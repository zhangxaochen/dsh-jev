// The real scoreboard: Pier's verifier numbers, not step counts.
//
// reward is binary - 1 only when every F2P test passes and no P2P regresses - which makes a
// 20-task comparison noisy. The verifier also records partial credit (f2p/p2p pass ratios),
// which is a continuous measure of how close each arm got and is the better basis for asking
// whether the plugin helps.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PILOT = 'D:/code/dsh-jev/tmp/pier-pilot'
const JOBS = 'D:/code/deep-swe/jobs'
const ids = readFileSync(join(PILOT, 'top20-ids.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const pairs = new Map()
for (const job of existsSync(JOBS) ? readdirSync(JOBS) : []) {
  if (!job.startsWith('2026-09-20')) continue
  for (const inner of readdirSync(join(JOBS, job))) {
    const base = join(JOBS, job, inner)
    const prefix = inner.split('__')[0]
    const task = ids.find((id) => id.startsWith(prefix) || prefix.startsWith(id.slice(0, 28)))
    if (!task) continue
    const setup = join(base, 'artifacts', 'agent', 'setup.txt')
    const rewardFile = join(base, 'verifier', 'reward.json')
    if (!existsSync(setup) || !existsSync(rewardFile)) continue
    let payload
    try {
      payload = JSON.parse(readFileSync(rewardFile, 'utf8'))
    } catch {
      continue
    }
    if (payload.reward === undefined || payload.reward < 0) continue
    const arm = readFileSync(setup, 'utf8').includes('plugin in profile:') ? 'B' : 'A'
    const entry = pairs.get(task) ?? {}
    entry[arm] = { ...payload, job }
    pairs.set(task, entry)
  }
}

const pct = (value) => (value === undefined ? '  -  ' : `${(value * 100).toFixed(2)}%`)
console.log('| task | A reward | A F2P | A P2P | A partial | B reward | B F2P | B P2P | B partial | Δpartial (B−A) |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
const deltas = []
let wins = 0
let losses = 0
for (const task of ids) {
  const entry = pairs.get(task)
  if (!entry?.A || !entry?.B) continue
  const a = entry.A
  const b = entry.B
  const delta = (b.partial ?? 0) - (a.partial ?? 0)
  deltas.push(delta)
  if (delta > 0.0005) wins += 1
  if (delta < -0.0005) losses += 1
  console.log(
    `| ${task} | ${a.reward} | ${a.f2p_passed ?? '-'}/${a.f2p_total ?? '-'} | ${a.p2p_passed ?? '-'}/${a.p2p_total ?? '-'} | ` +
      `${pct(a.partial)} | ${b.reward} | ${b.f2p_passed ?? '-'}/${b.f2p_total ?? '-'} | ${b.p2p_passed ?? '-'}/${b.p2p_total ?? '-'} | ` +
      `${pct(b.partial)} | ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(3)}pp |`
  )
}
if (deltas.length) {
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length
  console.log(
    `\n${deltas.length} 对：partial 平均差 ${(mean * 100).toFixed(3)}pp（正 = 插件更好 ✓）` +
      ` · 插件更好 ${wins} 对 · 对照更好 ${losses} 对 · 持平 ${deltas.length - wins - losses} 对`
  )
}
