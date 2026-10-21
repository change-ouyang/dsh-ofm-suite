// 跑全部测试：node test/run-all.mjs
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let failed = 0
for (const file of ['unit.test.mjs', 'http.test.mjs']) {
  console.log(`\n=== ${file} ===`)
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed++
}
console.log(failed === 0 ? '\n全部测试通过' : `\n${failed} 个测试文件失败`)
process.exitCode = failed === 0 ? 0 : 1
