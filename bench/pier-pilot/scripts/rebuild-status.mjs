// Rebuild top20-status.json from what is on disk. The driver's in-process bookkeeping can
// mis-attribute directories when two pairs run at once, so disk truth wins: every job
// directory names its task (truncated) and its arm is visible in setup.txt.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PILOT = 'D:/code/dsh-jev/tmp/pier-pilot'
const JOBS = 'D:/code/deep-swe/jobs'
const ids = readFileSync(join(PILOT, 'top20-ids.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
const byPrefix = new Map(ids.map((id) => [id.slice(0, 28), id]))

const entries = {}
for (const jobName of readdirSync(JOBS)) {
  // Only today's runs: yesterday's jobs used the pre-fix plugin build and must not leak in.
  if (!jobName.startsWith('2026-09-20')) continue
  const jobDir = join(JOBS, jobName)
  let inner
  try {
    inner = readdirSync(jobDir).filter((name) => name.includes('__'))
  } catch {
    continue
  }
  for (const name of inner) {
    const prefix = name.split('__')[0]
    const task = ids.find((id) => id.startsWith(prefix) || prefix.startsWith(id.slice(0, 28)))
    if (!task) continue
    const base = join(jobDir, name)
    const agentDir = join(base, 'artifacts', 'agent')
    const record = {}
    const setup = join(agentDir, 'setup.txt')
    if (existsSync(setup)) {
      const text = readFileSync(setup, 'utf8')
      // Authoritative marker: the treatment profile carries the plugin line, and the control
      // profile path differs. Both arms have the provider installed, so node_modules alone
      // cannot tell them apart.
      record.arm = text.includes('plugin in profile:') ? 'B' : 'A'
      record.provider_ok = text.includes('provider: commandcode')
      record.model_ok = text.includes('model: deepseek/deepseek-v4.1-flash')
    }
    const rewardFile = join(base, 'verifier', 'reward.json')
    if (existsSync(rewardFile)) {
      try {
        record.reward = JSON.parse(readFileSync(rewardFile, 'utf8')).reward
      } catch {}
    }
    const resultFile = join(base, 'result.json')
    if (existsSync(resultFile)) {
      try {
        const payload = JSON.parse(readFileSync(resultFile, 'utf8'))
        record.f2p = (payload.f2p ?? []).length
        record.p2p = (payload.p2p ?? []).length
      } catch {}
    }
    if (!record.arm) continue
    const current = entries[task] ?? { task }
    // Keep the newest directory per arm that actually carries a reward.
    if (!current[record.arm] || (record.reward !== undefined && current[record.arm].reward === undefined)) {
      current[record.arm] = { job: name, ...record }
    }
    entries[task] = current
  }
}

writeFileSync(join(PILOT, 'top20-status.json'), JSON.stringify(entries, null, 2) + '\n', 'utf8')

const cell = (value) => (value === undefined ? '  -  ' : String(value).padEnd(5))
console.log('| # | task | A reward | B reward | A f2p | B f2p | route |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
ids.forEach((task, index) => {
  const entry = entries[task] ?? {}
  const route = [entry.A, entry.B].every((arm) => !arm || (arm.provider_ok && arm.model_ok)) ? 'ok' : 'CHECK'
  const done = entry.A?.reward !== undefined && entry.B?.reward !== undefined
  console.log(
    `| ${index + 1} | ${task}${done ? '' : ' (pending)'} | ${cell(entry.A?.reward)} | ${cell(entry.B?.reward)} | ` +
      `${cell(entry.A?.f2p)} | ${cell(entry.B?.f2p)} | ${route} |`
  )
})
const done = ids.filter((task) => entries[task]?.A?.reward !== undefined && entries[task]?.B?.reward !== undefined).length
console.log(`\n完成 ${done}/${ids.length} 个任务（两臂都有分数）`)
