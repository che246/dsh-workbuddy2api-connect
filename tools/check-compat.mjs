#!/usr/bin/env node
/**
 * 用 DSH 自己的 `evaluatePluginCompatibility` 判定本插件的 manifest 能否装上当前运行时。
 *
 * 为什么需要这一步：DSH 从 0.2.1 起会对第三方插件的 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
 * peer 做**精确的 semver 比对**（`satisfies(runtimeVersion, range)`），而它的版本号是预发布
 * 序列（0.2.0-rc.2 → 0.2.1-rc.2 → …）。npm 的 semver 对预发布有额外规则：只有 range 里出现了
 * 同一个 X.Y.Z 的预发布比较符，该版本才算满足——所以 `>=0.2.0-rc.2`、`>=0.2.0-0 <0.3.0` 这类
 * 看起来宽松的写法，都判定不了 `0.2.1-rc.2`。结论就是：**不要用 peer 去钉 dsh 版本**，
 * 官方自己的插件也都没有钉；升级后跑这个脚本确认一次即可。
 *
 * 用法：
 *   node tools/check-compat.mjs                     # 判定仓库根目录的 package.json
 *   node tools/check-compat.mjs <manifest.json>     # 判定指定清单
 *
 * 退出码：0 = 兼容；1 = 不兼容或无法判定（会打印 DSH 给出的 requirements 细节）。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** DSH 桌面版的实现目录（可用 DSH_APP_DIR 覆盖）。 */
const APP_DIR =
  process.env.DSH_APP_DIR ?? 'D:/Programs/DeepSeek Harness/resources/app/dsh'

/** 从 DSH 实现目录里加载 app-boot，拿到官方判定逻辑。 */
async function loadAppBoot() {
  const entry = path.join(APP_DIR, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
  return import(pathToFileURL(entry).href)
}

/** 找到 manifest 路径（默认仓库根目录）。 */
function manifestPath() {
  const given = process.argv[2]
  if (given !== undefined) return path.resolve(given)
  return path.resolve(process.cwd(), 'package.json')
}

const boot = await loadAppBoot()
const runtime = boot.getDshRuntimeVersion?.() ?? '(未导出 getDshRuntimeVersion)'
const file = manifestPath()
const manifest = JSON.parse(await readFile(file, 'utf8'))

console.log(`运行时   : dsh ${runtime}`)
console.log(`清单     : ${file}`)
console.log(`插件     : ${manifest.name}@${manifest.version}`)

const issue = boot.evaluatePluginCompatibility(manifest)
if (issue === undefined) {
  console.log('判定     : 兼容 ✓')
  process.exit(0)
}

console.log('判定     : 不兼容 ✗')
console.log(`requirements: ${JSON.stringify(issue.requirements)}`)
console.log(`exempted    : ${issue.exempted}`)
console.log('')
console.log(boot.pluginCompatibilityWarning(issue))
process.exit(1)
