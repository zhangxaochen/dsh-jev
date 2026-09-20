// Read Pier's CTRF test report: which tests failed, and why.
//
// A 41-test gap smells like a whole file failing on a missing export rather than scattered
// breakage, and the failure messages say which.
import { readFileSync, existsSync } from 'node:fs'

const [path, limit = '12'] = process.argv.slice(2)
if (!existsSync(path)) {
  console.log('no report at', path)
  process.exit(1)
}
const report = JSON.parse(readFileSync(path, 'utf8'))
const tests = report?.results?.tests ?? []
const byStatus = {}
for (const test of tests) byStatus[test.status] = (byStatus[test.status] ?? 0) + 1
console.log('status counts:', JSON.stringify(byStatus))

const failed = tests.filter((test) => test.status !== 'passed')
const dedupe = new Map()
for (const test of failed) {
  const message = (test.message ?? test.trace ?? '').split('\n').find((line) => line.trim()) ?? ''
  const key = message.slice(0, 120)
  dedupe.set(key, (dedupe.get(key) ?? 0) + 1)
}
console.log(`\n${failed.length} 个未通过，按首个错误行归类（取前 8 类）：`)
for (const [message, count] of [...dedupe].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(4)} × ${message}`)
}
console.log(`\n前 ${limit} 个失败测试名：`)
for (const test of failed.slice(0, Number(limit))) console.log(`  - ${test.name}`)
