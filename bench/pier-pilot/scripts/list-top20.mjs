// Emit the top-20 task ids in rank order, and flag any that have no local task directory.
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const list = JSON.parse(readFileSync('D:/code/deep-swe/top20_tasks.json', 'utf8'))
const ids = list
  .sort((a, b) => a.rank - b.rank)
  .map((entry) => entry.task_id)
const missing = ids.filter((id) => !existsSync(join('D:/code/deep-swe/tasks', id, 'task.toml')))

console.log(`top20: ${ids.length} 个`)
ids.forEach((id, index) => console.log(`  ${String(index + 1).padStart(2)}. ${id}`))
console.log(`缺少 task.toml: ${missing.length ? missing.join(', ') : '无'}`)
writeFileSync('D:/code/dsh-jev/tmp/pier-pilot/top20-ids.txt', ids.join('\n') + '\n', 'utf8')
console.log('已写 tmp/pier-pilot/top20-ids.txt')
