// 跑全部测试：node test/run-all.mjs
//
// 自足：不依赖 DSH，也不依赖网关在跑。fetch 与文件路径都被打桩/隔离，
// 所以在 CI、别人的机器、网关没启动的情况下都能跑出同样的结果。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = ['host.test.mjs']

let failed = 0
for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed++
}

console.log(failed === 0 ? '\n全部测试通过' : `\n${failed} 个测试文件失败`)
process.exitCode = failed === 0 ? 0 : 1
