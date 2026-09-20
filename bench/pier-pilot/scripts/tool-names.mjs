// Tally tool names per session, so two arms can be compared on which tools they actually
// called - the direct way to see whether pruning removed something the agent needed.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const decode = (file) => {
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
    try { text += zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8') } catch { /* tail */ }
  }
  return text
}

const session = (() => {
  const target = process.argv[2]
  if (statSync(target).isFile()) return target
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.zstd')) found.push(path)
    }
  }
  walk(target)
  return found.sort((a, b) => statSync(b).size - statSync(a).size)[0]
})()

const calls = new Map()
const results = new Map()
for (const line of decode(session).split('\n')) {
  if (!line) continue
  let record
  try { record = JSON.parse(line) } catch { continue }
  const data = record?.data
  if (record.type === 'tool/call') {
    const name = data?.name ?? data?.message?.name
    if (name) calls.set(name, (calls.get(name) ?? 0) + 1)
  }
}
console.log('session:', session.split(/[\\/]/).slice(-3).join('/'))
console.log('| tool | calls |')
console.log('| --- | --- |')
for (const [name, count] of [...calls].sort((a, b) => b[1] - a[1])) {
  console.log(`| ${name} | ${count} |`)
}
process.exit(0)
