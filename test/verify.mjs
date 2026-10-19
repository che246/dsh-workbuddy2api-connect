#!/usr/bin/env node
/**
 * dsh-workbuddy2api-connect 的离线/在线验证台。
 *
 * 用一个假的 Cordis 上下文把插件真的跑起来（真 `apply()`、真 `PiAiAdapter`、真
 * pi-ai、真网关、真 HTTP 处理函数），逐条核对：
 *   1. 纯映射函数（模型名 / 思考档位 / 最大上下文）
 *   2. 真跑插件：拉模型表、注册 provider、逐条上下文比对
 *   3. 真发一条最小对话（含「关闭思考」与「默认档」两条实测）
 *   4. 界面接口：status / save / refresh 三个同源路由，含校验、环回门禁、
 *      凭据写入与热重注册
 *
 * 用法：
 *   node test/verify.mjs             # 在线（会真发 5 条最小对话）
 *   node test/verify.mjs --offline   # 离线：只核对纯映射函数
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  apply,
  bareModelId,
  credentialRefFor,
  deriveRouteId,
  displayNameOf,
  isDeepSeekFamily,
  modelsUrl,
  parseCatalog,
  rateOf,
  reasoningFields,
  toPiModel,
  WEB_BASE,
} from '../lib/index.js'

const offline = process.argv.includes('--offline')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ────────────────────────── [1] 离线：纯映射函数 ──────────────────────────

console.log('\n[1] 纯映射函数（不联网）')

const sample = parseCatalog({
  data: [
    {
      id: 'cn:glm-5.3',
      name: 'GLM-5.3',
      context_length: 1_000_000,
      max_output_tokens: 131_072,
      supports_reasoning: true,
      reasoning_supported_efforts: ['low', 'high', 'max'],
      can_disable_thinking: true,
      supports_images: true,
      credits: 'x0.79',
    },
    {
      id: 'cn:deepseek-v4-flash',
      name: 'Deepseek-V4-Flash',
      context_length: 1_000_000,
      max_output_tokens: 50_000,
      supports_reasoning: true,
      reasoning_supported_efforts: ['low', 'high', 'xhigh'],
      can_disable_thinking: true,
      supports_images: true,
      credits: 'x0.17',
    },
    {
      id: 'cn:auto',
      name: 'Auto',
      context_length: 256_000,
      max_output_tokens: 32_000,
      supports_reasoning: true,
      only_reasoning: true,
      supports_images: true,
    },
  ],
})

check('模型表解析出 3 条', sample.length === 3, `实际 ${sample.length}`)
check('域前缀剥离', bareModelId('global:gpt-5.6') === 'gpt-5.6')
check('deepseek 系判定（裸名口径）', isDeepSeekFamily('cn:deepseek-v4-flash') === true && isDeepSeekFamily('cn:glm-5.3') === false)
check('倍率规范', rateOf(sample[0]) === 'x0.79', `${rateOf(sample[0])}`)
check('倍率后缀只在 showRate 时出现', displayNameOf(sample[0], true) === 'GLM-5.3 · x0.79' && displayNameOf(sample[0], false) === 'GLM-5.3')

const glmReasoning = reasoningFields(sample[0])
check('glm：声明档位照抄', glmReasoning.reasoning === true && glmReasoning.thinkingLevelMap.low === 'low' && glmReasoning.thinkingLevelMap.high === 'high' && glmReasoning.thinkingLevelMap.max === 'max')
check('glm：未声明档位锁死为 null', glmReasoning.thinkingLevelMap.medium === null && glmReasoning.thinkingLevelMap.minimal === null)
check('glm：非 deepseek 系不给 off（网关照抄 thinking 但上游忽略它）', glmReasoning.thinkingLevelMap.off === null)

const dsReasoning = reasoningFields(sample[1])
check('deepseek：can_disable_thinking → off 可用', dsReasoning.thinkingLevelMap.off === 'off')
check('deepseek：xhigh 声明即出现', dsReasoning.thinkingLevelMap.xhigh === 'xhigh')

// 不变式：只有默认档也能明确下发时才提供 off——否则「未选档位」会被 pi-ai 的
// deepseek 分支翻译成 thinking.type=disabled，等于用户没选却被静默关掉思考。
const dsMedium = parseCatalog({ data: [{ id: 'cn:deepseek-only-medium', name: 'DS', supports_reasoning: true, reasoning_supported_efforts: ['medium'], can_disable_thinking: true }] })[0]
check('默认档不在支持集里 → 不给 off（避免静默关思考）', reasoningFields(dsMedium, { defaultLevel: 'high' }).thinkingLevelMap?.off === null)
check('默认档在支持集里 → 给 off', reasoningFields(dsMedium, { defaultLevel: 'medium' }).thinkingLevelMap?.off === 'off')
check('不指定默认档 → 按声明给 off', reasoningFields(dsMedium).thinkingLevelMap?.off === 'off')

const autoReasoning = reasoningFields(sample[2])
check('无档位声明的模型 → 非推理（不给假档位控件）', autoReasoning.reasoning === false)

const dsModel = toPiModel(sample[1], { provider: 'p', baseUrl: 'http://x/v1', defaultContextWindow: 262_144, defaultMaxTokens: 32_768, maxTokensCap: 0, showRate: true })
check('上下文取 context_length', dsModel.contextWindow === 1_000_000, `${dsModel.contextWindow}`)
check('输出上限取 max_output_tokens', dsModel.maxTokens === 50_000, `${dsModel.maxTokens}`)
check('deepseek 走 deepseek thinkingFormat（off 才能变成 thinking.type=disabled）', dsModel.compat.thinkingFormat === 'deepseek')
check('max_tokens 主字段', dsModel.compat.maxTokensField === 'max_tokens')
check('图像能力进 input', dsModel.input.join(',') === 'text,image')

const glmModel = toPiModel(sample[0], { provider: 'p', baseUrl: 'http://x/v1', defaultContextWindow: 262_144, defaultMaxTokens: 32_768, maxTokensCap: 131_072, showRate: false })
check('maxTokensCap 生效', glmModel.maxTokens === 131_072, `${glmModel.maxTokens}`)
check('非 deepseek 不覆盖 thinkingFormat', glmModel.compat.thinkingFormat === undefined)
check('模型表 URL 拼接', modelsUrl('http://127.0.0.1:7863/v1') === 'http://127.0.0.1:7863/v1/models' && modelsUrl('http://127.0.0.1:7863/api/models/') === 'http://127.0.0.1:7863/api/models')
check('凭据名派生', credentialRefFor('workbuddy2apicn') === 'WB2API_KEY_WORKBUDDY2APICN')
check('路由 id 按分组名称派生（ASCII 折小写）', deriveRouteId('work2api-CN', new Set()) === 'work2api-cn', deriveRouteId('work2api-CN', new Set()))
check('路由 id 派生：非 ASCII 名称退化为 wb2api', deriveRouteId('我的网关', new Set()) === 'wb2api', deriveRouteId('我的网关', new Set()))
check('路由 id 派生：重名加序号', deriveRouteId('My GW', new Set(['my-gw'])) === 'my-gw-2', deriveRouteId('My GW', new Set(['my-gw'])))
check('路由 id 派生：空白折叠为单个连字符、保留合法的点', deriveRouteId('  A  b..c  ', new Set()) === 'a-b..c', deriveRouteId('  A  b..c  ', new Set()))
check('路由 id 派生：去掉首尾符号', deriveRouteId('---x---', new Set()) === 'x', deriveRouteId('---x---', new Set()))

if (offline) {
  console.log(`\n离线核对完成：${checks - failures}/${checks} 通过`)
  process.exit(failures === 0 ? 0 : 1)
}

// ────────────────────────── 假上下文 ──────────────────────────

/** 从 DSH 凭据文件的 refs 段解析出 `名称: 值`。 */
function credentialsRefs() {
  const file = process.env['DSH_CREDENTIALS'] ?? join(homedir(), '.dsh', '.credentials.yaml')
  try {
    const text = readFileSync(file, 'utf8')
    const at = text.indexOf('refs:')
    const out = {}
    if (at === -1) return out
    for (const line of text.slice(at).split(/\r?\n/).slice(1)) {
      const match = /^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/.exec(line)
      if (match !== null) out[match[1]] = match[2]
    }
    return out
  } catch {
    return {}
  }
}

const refs = credentialsRefs()
const routes = [
  {
    id: 'workbuddy2apicn',
    displayName: 'work2api-CN',
    baseURL: process.env['WB2API_CN_BASE'] ?? 'http://192.168.1.201:7863/v1',
    apiKeyEnv: 'WORKBUDDY2APICN_API_KEY',
  },
  {
    id: 'workbuddy2api',
    displayName: 'work2api-AI',
    baseURL: process.env['WB2API_GLOBAL_BASE'] ?? 'http://192.168.1.201:7864/v1',
    apiKeyEnv: 'WORKBUDDY2API_API_KEY',
  },
]

const work = mkdtempSync(join(tmpdir(), 'wb2api-verify-'))
const configFile = join(work, 'routes.json')

const logs = []
const effects = []
const httpRoutes = new Map()
const keyWrites = []
let registrations = 0
let registered

const scope = {
  logger: {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message, error) => logs.push(['error', `${message}${error === undefined ? '' : ` ${error?.message ?? error}`}`]),
    debug: () => {},
  },
  get: (service) => {
    if (service === 'credentials') {
      return {
        resolve: async (ref) => (refs[ref] === undefined ? undefined : { value: refs[ref] }),
        set: async (ref, value) => {
          keyWrites.push({ action: 'set', ref, value })
          refs[ref] = value
        },
        unset: async (ref) => {
          keyWrites.push({ action: 'unset', ref })
          delete refs[ref]
        },
      }
    }
    return undefined
  },
  effect: (callback) => {
    const disposer = callback()
    if (typeof disposer === 'function') effects.push(disposer)
  },
  emit: (event) => logs.push(['emit', event]),
  inject: (names, callback) => {
    if (names.includes('webServer')) callback(scope)
  },
  webServer: {
    register: (route) => {
      httpRoutes.set(route.path, route.handler)
      return () => httpRoutes.delete(route.path)
    },
  },
  llm: {
    registerAdapter: (providers, adapter) => {
      registrations += 1
      registered = { providers, adapter }
      return () => {
        registered = undefined
      }
    },
  },
}

apply(scope, { routes, refreshMinutes: 30, timeoutMs: 20_000, showRate: true, maxTokensCap: 0, configFile })

// ────────────────────────── [2] 真跑插件 ──────────────────────────

console.log(`\n[2] 真跑插件（${routes.map((route) => route.id).join(', ')}）`)

check('注册了一次适配器', registered !== undefined, registered === undefined ? '没注册' : `routes=[${registered.providers.join(', ')}]`)

/** 等插件把真模型表拉回来。 */
async function waitForModels(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const models = await registered.adapter.listModels(provider)
    if (models.length > 0) return models
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return []
}

for (const route of routes) {
  const models = await waitForModels(route.id)
  check(`路由 ${route.id} 拉到模型`, models.length > 0, `${models.length} 个`)

  const sampleModel = models[0]
  if (sampleModel === undefined) continue
  const resolved = await registered.adapter.resolveModel(route.id, sampleModel.id)
  check(
    `路由 ${route.id} 首个模型的上下文窗口已带上`,
    typeof resolved.context?.contextWindow === 'number' && resolved.context.contextWindow > 0,
    `${sampleModel.id} → contextWindow=${resolved.context?.contextWindow}`,
  )

  const response = await fetch(modelsUrl(route.baseURL), { headers: { authorization: `Bearer ${refs[route.apiKeyEnv]}` } })
  const raw = parseCatalog(await response.json())
  let mismatched = 0
  for (const entry of raw) {
    const model = await registered.adapter.resolveModel(route.id, entry.id).catch(() => undefined)
    if (model === undefined) { mismatched += 1; continue }
    if (entry.contextWindow !== undefined && model.context?.contextWindow !== entry.contextWindow) mismatched += 1
  }
  check(`路由 ${route.id} 上下文窗口与网关逐条一致`, mismatched === 0, `不一致 ${mismatched}/${raw.length}`)

  const withThinking = raw.filter((entry) => reasoningFields(entry, { defaultLevel: 'high' }).reasoning === true)
  const withOff = raw.filter((entry) => reasoningFields(entry, { defaultLevel: 'high' }).thinkingLevelMap?.off === 'off')
  console.log(
    `    ${route.id}: ${raw.length} 个模型，` +
    `上下文 ${Math.round(Math.min(...raw.map((entry) => entry.contextWindow ?? 0)) / 1000)}K–${Math.round(Math.max(...raw.map((entry) => entry.contextWindow ?? 0)) / 1000)}K，` +
    `带思考档 ${withThinking.length} 个，可关思考 ${withOff.length} 个（${withOff.map((entry) => entry.id).join(', ') || '无'}）`,
  )
}

// ────────────────────────── [3] 真发最小对话 ──────────────────────────

console.log('\n[3] 真发一条最小对话（走插件注册的适配器）')

/** 跑一次 harness 层流式调用，收集分片。 */
async function streamOnce(provider, model, reasoningEffort) {
  const chunks = []
  const options = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回一个字：好' }] }],
    system: '你是极简助手.',
    maxTokens: 32,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
  const iterator = registered.adapter.stream(options)[Symbol.asyncIterator]()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const next = await iterator.next()
    if (next.done === true) break
    chunks.push(next.value)
  }
  return chunks
}

const textOf = (chunks) => chunks
  .filter((chunk) => chunk.type === 'text-delta' || chunk.type === 'text')
  .map((chunk) => chunk.delta ?? chunk.text ?? '')
  .join('')

const cnRoute = routes.find((route) => route.id === 'workbuddy2apicn') ?? routes[0]
if (cnRoute !== undefined) {
  try {
    const chunks = await streamOnce(cnRoute.id, 'cn:glm-5.3', 'high')
    check('glm-5.3（reasoningEffort=high）流式返回正文', textOf(chunks).length > 0, JSON.stringify(textOf(chunks).slice(0, 40)))
  } catch (error) {
    check('glm-5.3（reasoningEffort=high）流式返回正文', false, error.message)
  }

  try {
    const chunks = await streamOnce(cnRoute.id, 'cn:deepseek-v4-flash', 'off')
    const kinds = new Set(chunks.map((chunk) => chunk.type))
    check('deepseek-v4-flash（显式 off）有正文', textOf(chunks).length > 0, JSON.stringify(textOf(chunks).slice(0, 40)))
    check('deepseek-v4-flash（显式 off）没有思考块', !kinds.has('reasoning-delta') && !kinds.has('reasoning'), [...kinds].join(','))
  } catch (error) {
    check('deepseek-v4-flash（显式 off）流式返回正文', false, error.message)
  }

  try {
    const chunks = await streamOnce(cnRoute.id, 'cn:deepseek-v4-flash', undefined)
    const kinds = new Set(chunks.map((chunk) => chunk.type))
    check('deepseek-v4-flash（未给档位）走路由默认档而非静默关思考', kinds.has('reasoning-delta') || kinds.has('reasoning'), [...kinds].join(','))
  } catch (error) {
    check('deepseek-v4-flash（未给档位）走路由默认档', false, error.message)
  }
}

// ────────────────────────── [4] 界面接口 ──────────────────────────

console.log('\n[4] 界面接口（status / save / refresh）')

/** 假响应对象。 */
function fakeRes() {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(body) {
      res.body = body === undefined ? undefined : body.toString()
    },
    json() {
      return res.body === undefined ? undefined : JSON.parse(res.body)
    },
  }
  return res
}

/** 假请求对象（async iterable body）。 */
function fakeReq({ method = 'GET', host = '127.0.0.1:19387', origin, body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return {
    method,
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
}

const handlerFor = (suffix) => httpRoutes.get(`${WEB_BASE}${suffix}`)

check('三个界面路由都挂上了', ['/status', '/save', '/refresh'].every((suffix) => typeof handlerFor(suffix) === 'function'), [...httpRoutes.keys()].join(', '))

{
  const res = fakeRes()
  await handlerFor('/status')(fakeReq(), res)
  const body = res.json()
  check('GET status 返回 200', res.statusCode === 200, `HTTP ${res.statusCode}`)
  check('status 列出两条路由', body?.routes?.length === 2, `${body?.routes?.length}`)
  check('status 带模型数与上下文范围', body?.routes?.[0]?.models > 0 && body?.routes?.[0]?.contextMax > 0, `models=${body?.routes?.[0]?.models} ctx=${body?.routes?.[0]?.contextMin}–${body?.routes?.[0]?.contextMax}`)
  check('status 报告密钥已配置', body?.routes?.every((route) => route.hasKey === true) === true)
  check('status 绝不回传密钥本身', !res.body.includes(refs['WORKBUDDY2API_API_KEY'] ?? '###') && !res.body.includes(refs['WORKBUDDY2APICN_API_KEY'] ?? '###'))
  check('status 带配置文件路径与刷新周期', typeof body?.configFile === 'string' && body.configFile === configFile, body?.configFile)
}

{
  const res = fakeRes()
  await handlerFor('/status')(fakeReq({ host: 'evil.example.com' }), res)
  check('非环回 Host 被拒（403）', res.statusCode === 403, `HTTP ${res.statusCode}`)
}

{
  const res = fakeRes()
  await handlerFor('/status')(fakeReq({ origin: 'https://evil.example.com' }), res)
  check('非环回 Origin 被拒（403）', res.statusCode === 403, `HTTP ${res.statusCode}`)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ id: 'bad id', baseURL: 'http://127.0.0.1:1/v1' }] } }), res)
  check('非法路由 id 被拒（400）', res.statusCode === 400 && /不合法/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ displayName: '', baseURL: 'http://127.0.0.1:1/v1' }] } }), res)
  check('既无 id 也无分组名称被拒（400）', res.statusCode === 400 && /分组名称/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ displayName: 'X', baseURL: 'http://127.0.0.1:1/v1' }, { displayName: 'X', baseURL: 'http://127.0.0.1:2/v1' }] } }), res)
  check('分组名称重复被拒（400）', res.statusCode === 400 && /分组名称重复/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ id: 'x', baseURL: 'ftp://example.com' }] } }), res)
  check('非 http(s) URL 被拒（400）', res.statusCode === 400 && /http/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({ method: 'POST', body: { routes: [{ id: 'dup', baseURL: 'http://127.0.0.1:1/v1' }, { id: 'dup', baseURL: 'http://127.0.0.1:2/v1' }] } }), res)
  check('重复路由 id 被拒（400）', res.statusCode === 400 && /重复/u.test(res.json()?.error ?? ''), res.json()?.error)
}

{
  // 模型选择：status 要给出可选清单；保存 exclude 之后，注册出去的模型表里就没有它们了
  const plain = fakeRes()
  await handlerFor('/status')(fakeReq(), plain)
  const plainBody = plain.json()
  const firstRoute = plainBody?.routes?.[0]
  check('status 每条路由带完整模型清单（供界面勾选）',
    Array.isArray(firstRoute?.catalog) && firstRoute.catalog.length === firstRoute.models && typeof firstRoute.catalog[0]?.id === 'string',
    `catalog=${firstRoute?.catalog?.length} models=${firstRoute?.models}`)
  check('清单条目带上下文/思考档等要点',
    typeof firstRoute?.catalog?.[0]?.contextWindow === 'number' && Array.isArray(firstRoute?.catalog?.[0]?.efforts),
    JSON.stringify(firstRoute?.catalog?.[0]))
  check('默认没有排除任何模型（全部启用）',
    Array.isArray(firstRoute?.exclude) && firstRoute.exclude.length === 0 && firstRoute.enabled === firstRoute.models,
    `exclude=${JSON.stringify(firstRoute?.exclude)} enabled=${firstRoute?.enabled}`)

  const targetId = firstRoute.catalog.find((item) => item.id !== 'cn:deepseek-v4.1-flash')?.id ?? firstRoute.catalog[0].id
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: plainBody.routes.map((route, at) => ({
        id: route.id,
        displayName: route.displayName,
        baseURL: route.baseURL,
        ...(at === 0 ? { exclude: [targetId, targetId, 42, '', 'x'.repeat(500)] } : {}),
      })),
    },
  }), res)
  const saved = res.json()
  const route = saved?.routes?.[0]
  check('保存 exclude 后 enabled 减少', route?.enabled === route?.models - 1, `enabled=${route?.enabled} models=${route?.models}`)
  check('exclude 已去重并丢掉非字符串/空串/超长项',
    JSON.stringify(route?.exclude) === JSON.stringify([targetId]),
    JSON.stringify(route?.exclude))

  const injected = await (registered?.adapter?.listModels?.('workbuddy2apicn') ?? [])
  const injectedIds = injected.map((model) => model.id)
  check('被排除的模型没有进入注册的模型表', !injectedIds.includes(targetId),
    `排除 ${targetId}；注入 ${injectedIds.length} 个：${injectedIds.slice(0, 3).join(', ')}…`)
  check('其余模型照常注册', injectedIds.length === firstRoute.models - 1, `注入 ${injectedIds.length} 个，预期 ${firstRoute.models - 1} 个`)

  const after = fakeRes()
  await handlerFor('/status')(fakeReq(), after)
  check('status 回显当前排除列表',
    JSON.stringify(after.json()?.routes?.[0]?.exclude) === JSON.stringify([targetId]),
    JSON.stringify(after.json()?.routes?.[0]?.exclude))

  // 复位：把排除清掉，后续断言仍然看到全量模型
  const reset = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: { routes: after.json().routes.map((item) => ({ id: item.id, displayName: item.displayName, baseURL: item.baseURL })) },
  }), reset)
  check('清空 exclude 后恢复全部启用', reset.json()?.routes?.[0]?.enabled === reset.json()?.routes?.[0]?.models,
    `enabled=${reset.json()?.routes?.[0]?.enabled} models=${reset.json()?.routes?.[0]?.models}`)
}

{
  // /probe：按界面当前的 URL/Key 现拉模型表；失败要把原因说清楚
  const okProbe = fakeRes()
  await handlerFor('/probe')(fakeReq({
    method: 'POST',
    body: { baseURL: routes[0].baseURL, apiKey: refs['WORKBUDDY2APICN_API_KEY'] },
  }), okProbe)
  const okBody = okProbe.json()
  check('probe 用 URL+Key 拉到模型清单', okBody?.ok === true && Array.isArray(okBody.catalog) && okBody.catalog.length > 0,
    `models=${okBody?.models} error=${okBody?.error ?? ''}`)
  check('probe 返回的清单条目同 /status 一样带要点', typeof okBody?.catalog?.[0]?.contextWindow === 'number' && Array.isArray(okBody?.catalog?.[0]?.efforts),
    JSON.stringify(okBody?.catalog?.[0]))
  check('probe 回报它请求的地址', typeof okBody?.url === 'string' && okBody.url.endsWith('/models'), okBody?.url)

  const badKey = fakeRes()
  await handlerFor('/probe')(fakeReq({ method: 'POST', body: { baseURL: routes[0].baseURL, apiKey: 'sk-definitely-wrong' } }), badKey)
  const badKeyBody = badKey.json()
  check('probe 遇到密钥错误如实报错（不静默空表）',
    badKeyBody?.ok === false && /401|invalid_api_key/u.test(badKeyBody?.error ?? ''), badKeyBody?.error)

  const offline = fakeRes()
  await handlerFor('/probe')(fakeReq({ method: 'POST', body: { baseURL: 'http://127.0.0.1:45999/v1', apiKey: 'x' } }), offline)
  const offlineBody = offline.json()
  check('probe 连不上端口时说清是「连不上/端口没监听」',
    offlineBody?.ok === false && /连不上|ECONNREFUSED/u.test(offlineBody?.error ?? ''), offlineBody?.error)

  const badUrl = fakeRes()
  await handlerFor('/probe')(fakeReq({ method: 'POST', body: { baseURL: 'ftp://example.com/v1' } }), badUrl)
  check('probe 拒绝非 http(s) URL', badUrl.statusCode === 400 && /http/u.test(badUrl.json()?.error ?? ''), badUrl.json()?.error)

  const emptyUrl = fakeRes()
  await handlerFor('/probe')(fakeReq({ method: 'POST', body: { baseURL: '   ' } }), emptyUrl)
  check('probe 没填 URL 时提示先填 URL', emptyUrl.statusCode === 400 && /请先填 URL/u.test(emptyUrl.json()?.error ?? ''), emptyUrl.json()?.error)

  // 既有路由：不带 apiKey，按凭据名从库里取已保存的那把
  const stored = fakeRes()
  await handlerFor('/probe')(fakeReq({ method: 'POST', body: { id: 'workbuddy2apicn', baseURL: routes[0].baseURL } }), stored)
  check('probe 对已保存路由自动用凭据库里的 Key', stored.json()?.ok === true, stored.json()?.error)
}

{
  const before = registrations
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        // 既有路由：只改分组名、**不带凭据名**（界面正常保存时的形态）
        { id: 'workbuddy2apicn', displayName: 'CN-改过名', baseURL: routes[0].baseURL },
        // 新路由：界面上填一个 Key，凭据名留空 → 由宿主派生
        { id: 'myroute', displayName: '我的网关', baseURL: routes[1].baseURL, apiKey: refs['WORKBUDDY2API_API_KEY'] },
      ],
    },
  }), res)
  const body = res.json()
  check('保存成功并返回 200', res.statusCode === 200, `HTTP ${res.statusCode} ${body?.error ?? ''}`)
  check('保存后热重注册（未重启）', registrations > before, `${before} → ${registrations}`)
  check('新路由已生效', registered?.providers?.includes('myroute') === true, `routes=[${registered?.providers?.join(', ')}]`)
  check('改名生效', body?.routes?.some((route) => route.id === 'workbuddy2apicn' && route.displayName === 'CN-改过名') === true)
  check(
    '未带凭据名的既有路由沿用原凭据名（不会被改成派生名而丢密钥）',
    body?.routes?.find((route) => route.id === 'workbuddy2apicn')?.apiKeyEnv === 'WORKBUDDY2APICN_API_KEY',
    body?.routes?.find((route) => route.id === 'workbuddy2apicn')?.apiKeyEnv,
  )
  check(
    '新路由的密钥写进凭据库（按派生凭据名）',
    keyWrites.some((write) => write.action === 'set' && write.ref === credentialRefFor('myroute') && write.value === refs['WORKBUDDY2API_API_KEY']),
    JSON.stringify(keyWrites),
  )
  const onDisk = readFileSync(configFile, 'utf8')
  check('配置文件已落盘且不含明文密钥', JSON.parse(onDisk).routes.length === 2 && !onDisk.includes(refs['WORKBUDDY2API_API_KEY']), `routes=${JSON.parse(onDisk).routes.map((route) => route.id).join(',')}`)
  check('新路由也拉到了模型表（密钥经凭据库生效）', body?.routes?.find((route) => route.id === 'myroute')?.models > 0, `models=${body?.routes?.find((route) => route.id === 'myroute')?.models}`)
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'CN', baseURL: routes[0].baseURL },
        { id: 'myroute', displayName: '我的网关', baseURL: routes[1].baseURL, clearKey: true },
      ],
    },
  }), res)
  check('清除 Key 走凭据库 unset', keyWrites.some((write) => write.action === 'unset' && write.ref === credentialRefFor('myroute')), JSON.stringify(keyWrites.slice(-2)))
  check('清除后状态显示未配置密钥', res.json()?.routes?.find((route) => route.id === 'myroute')?.hasKey === false)
}

{
  const res = fakeRes()
  await handlerFor('/refresh')(fakeReq({ method: 'POST' }), res)
  const body = res.json()
  check('POST refresh 返回 200', res.statusCode === 200, `HTTP ${res.statusCode}`)
  check(
    'refresh 后两条路由都有模型表（被清掉密钥的那条沿用上一份）',
    body?.routes?.every((route) => route.models > 0) === true,
    JSON.stringify(body?.routes?.map((route) => `${route.id}:${route.models}`)),
  )
}

{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'CN', baseURL: routes[0].baseURL, apiKeyEnv: 'WORKBUDDY2APICN_API_KEY' },
        { id: 'badkey', displayName: '错误密钥', baseURL: routes[1].baseURL, apiKey: 'sk-definitely-wrong-key' },
      ],
    },
  }), res)
  const bad = res.json()?.routes?.find((route) => route.id === 'badkey')
  check('错误密钥的失败如实出现在状态里（不是静默空表）', typeof bad?.error === 'string' && /401|invalid_api_key/u.test(bad.error), bad?.error)
}

{
  // 界面只填「分组名称 / URL / Key」：新路由不带 id → 宿主按分组名称派生；
  // 既有路由回传 id（界面不展示）→ 改名不换 provider 名。
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'CN-再次改名', baseURL: routes[0].baseURL },
        { displayName: 'My Gateway', baseURL: routes[1].baseURL, apiKey: refs['WORKBUDDY2API_API_KEY'] },
      ],
    },
  }), res)
  const body = res.json()
  check(
    '新路由不带 id → 按分组名称派生',
    body?.routes?.some((route) => route.id === 'my-gateway' && route.displayName === 'My Gateway') === true,
    JSON.stringify(body?.routes?.map((route) => `${route.id}:${route.displayName}`)),
  )
  check(
    '既有路由改名后 provider 名保持不变（不破坏既有会话与默认模型）',
    body?.routes?.some((route) => route.id === 'workbuddy2apicn' && route.displayName === 'CN-再次改名') === true,
    JSON.stringify(body?.routes?.map((route) => `${route.id}:${route.displayName}`)),
  )
  check(
    '派生路由的凭据名跟着派生 id 走',
    keyWrites.some((write) => write.action === 'set' && write.ref === credentialRefFor('my-gateway')),
    JSON.stringify(keyWrites.slice(-1)),
  )
  check('派生出来的新路由也拉到了模型表', body?.routes?.find((route) => route.id === 'my-gateway')?.models > 0, `models=${body?.routes?.find((route) => route.id === 'my-gateway')?.models}`)
}

// 复位到最初两条路由（配置写在临时目录，这里只是让状态自洽）
{
  const res = fakeRes()
  await handlerFor('/save')(fakeReq({
    method: 'POST',
    body: {
      routes: [
        { id: 'workbuddy2apicn', displayName: 'work2api-CN', baseURL: routes[0].baseURL, apiKeyEnv: 'WORKBUDDY2APICN_API_KEY' },
        { id: 'workbuddy2api', displayName: 'work2api-AI', baseURL: routes[1].baseURL, apiKeyEnv: 'WORKBUDDY2API_API_KEY' },
      ],
    },
  }), res)
  check('复位回两条路由且都能拉到模型', res.json()?.routes?.every((route) => route.models > 0) === true, JSON.stringify(res.json()?.routes?.map((route) => `${route.id}:${route.models}`)))
}

// ────────────────────────── [5] 客户端卡片 ──────────────────────────

console.log('\n[5] 客户端卡片（结构化核对：手写 React 桩）')

/**
 * 极简 React 桩：只实现本卡片用到的 5 个 API。
 * `useState` 按**每次渲染内的调用顺序**占槽位（所以每次渲染前要 `__begin()` 把游标
 * 归零，槽位本身跨渲染保留），`useEffect` 立刻执行回调（测试里靠它触发首次读取），
 * `createElement` 返回可遍历的普通对象。
 */
function createReactStub() {
  const slots = []
  const cleanups = []
  const effectDeps = []
  let cursor = 0
  return {
    slots,
    cleanups,
    /** 每次渲染前调用：重置 hook 游标。 */
    __begin() {
      cursor = 0
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value
      }]
    },
    /**
     * 支持依赖数组的 useEffect（真实 React 的核心语义之一）。
     *
     * 不支持 deps 会让每次渲染都重跑 effect：卡片里「拉 /status」的 effect 就会在
     * 每次渲染后异步回来、把用户刚编辑的草稿覆盖掉——测试会以为功能坏了，其实是桩不对。
     * 依赖不变就跳过；`undefined` 依赖（没传数组）每次重跑，与 React 一致。
     */
    useEffect(callback, deps) {
      const index = cursor++
      const previous = effectDeps[index]
      const firstRun = previous === undefined
      const always = deps === undefined
      const changed = firstRun || always || deps.length !== previous.deps.length || deps.some((value, at) => value !== previous.deps[at])
      effectDeps[index] = { deps: deps ?? null }
      if (!changed) return
      if (previous?.cleanup !== undefined) previous.cleanup?.()
      const cleanup = callback()
      effectDeps[index].cleanup = cleanup
      cleanups.push(cleanup)
    },
    useCallback(callback) {
      return callback
    },
  }
}

/** 深度优先找出第一个满足条件的节点。 */
function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 收集整棵树里的文本。 */
function collectText(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const child of node) collectText(child, out)
  else if (node !== null && typeof node === 'object') for (const child of node.children ?? []) collectText(child, out)
  return out
}

const loaderRegistrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => loaderRegistrations.push(registration) } }
await import(new URL('../lib/client.js', import.meta.url).href)

check('客户端 bundle 走 window.__ModuleLoader__.load 注册', loaderRegistrations.length === 1 && loaderRegistrations[0].id === 'dsh-workbuddy2api-connect', loaderRegistrations.map((entry) => entry.id).join(', '))

const reactStub = createReactStub()
const clientModule = loaderRegistrations[0].factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`客户端 bundle 要求了未声明的依赖：${specifier}`)
})
check('导出 name / apply / inject', typeof clientModule.apply === 'function' && clientModule.inject.includes('slots'), `${clientModule.name} inject=[${clientModule.inject}]`)

const slots = {
  registered: [],
  inject(name, callback) {
    check('挂到 plugins.bundle.config 插槽', name === 'plugins.bundle.config', name)
    callback()
  },
  register(options, Component) {
    this.registered.push({ options, Component })
    return () => {}
  },
}
clientModule.apply({ slots })
check(
  '注册键 = 包名（插件页按包名分发）',
  slots.registered.length === 1 && slots.registered[0].options.key === 'dsh-workbuddy2api-connect',
  JSON.stringify(slots.registered[0]?.options),
)

const cardStatus = {
  ok: true,
  configFile: 'C:/Users/x/.dsh/.workbuddy2api-connect.json',
  refreshMinutes: 30,
  updatedAt: '2026-10-15T03:00:00.000Z',
  routes: [
    {
      id: 'workbuddy2apicn',
      displayName: 'work2api-CN',
      baseURL: 'http://192.168.1.201:7863/v1',
      apiKeyEnv: 'WORKBUDDY2APICN_API_KEY',
      hasKey: true,
      reasoning: null,
      models: 20,
      fetchedAt: Date.now() - 60_000,
      source: 'live',
      error: null,
      contextMin: 192_000,
      contextMax: 1_000_000,
      efforts: ['low', 'high', 'max'],
      offCount: 3,
    },
  ],
}

const hostCalls = []
globalThis.fetch = async (url, options) => {
  hostCalls.push({ url: String(url), body: options?.body === undefined ? undefined : JSON.parse(options.body) })
  return { ok: true, status: 200, json: async () => cardStatus }
}

const Card = slots.registered[0].Component
/** 一次渲染（先归零 hook 游标）。 */
const render = (props) => {
  reactStub.__begin()
  return Card(props)
}
check('summary 视图返回一句话', typeof render({ view: 'summary' }) === 'string', render({ view: 'summary' }))

let tree = render({ view: 'page' })
await new Promise((resolve) => setTimeout(resolve, 30))
tree = render({ view: 'page' })

/** 收集所有 <span> 文本（字段标签就是 span；提示语是 div，不会混进来）。 */
const collectSpans = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectSpans(child, out)
    return out
  }
  if (node.type === 'span') out.push(...collectText(node))
  for (const child of node.children ?? []) collectSpans(child, out)
  return out
}

/** 收集一棵树里的全部 <input>（每次调用返回新数组）。 */
const collectInputs = (node, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectInputs(child, out)
    return out
  }
  if (node.type === 'input') out.push(node)
  for (const child of node.children ?? []) collectInputs(child, out)
  return out
}

const inputs = collectInputs(tree)
const textInputs = inputs.filter((input) => input.props.type !== 'checkbox')
const fieldLabels = collectSpans(tree).join(' | ')
check(
  '卡片只渲染三个字段输入项（分组名称 / URL / Key）',
  textInputs.length === 3 && inputs.filter((input) => input.props.type === 'password').length === 1,
  `字段输入 ${textInputs.length} 个（含 1 个「清除 Key」复选框，共 ${inputs.length} 个 input）`,
)
check('字段标签就是这三样', fieldLabels.includes('分组名称') && fieldLabels.includes('URL（OpenAI 兼容基地址）') && /(^|\| )Key/u.test(fieldLabels), fieldLabels)
check('界面不再展示路由 id 与凭据名', !fieldLabels.includes('路由 id') && !fieldLabels.includes('凭据名'), fieldLabels)

const valueOf = (props) => textInputs.find((input) => input.props.value === props)?.props.value
check('URL 输入框带上了宿主返回的地址', valueOf('http://192.168.1.201:7863/v1') === 'http://192.168.1.201:7863/v1')
check(
  'Key 输入框留空、并标明已保存（不会被回显）',
  inputs.some((input) => input.props.type === 'password' && input.props.value === '' && /留空/u.test(input.props.placeholder ?? '')) && fieldLabels.includes('Key（已保存，留空不改）'),
)
check('路由状态显示模型数与上下文', /20 个模型/u.test(collectText(tree).join(' | ')) && /上下文 192K–1000K/u.test(collectText(tree).join(' | ')), collectText(tree).join(' | ').slice(0, 200))

const saveButton = findNode(tree, (node) => node.type === 'button' && collectText(node).join('') === '保存并生效')
check('找到「保存并生效」按钮', saveButton !== undefined)
saveButton?.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 30))
const saveCall = hostCalls.find((call) => call.url.endsWith('/save'))
check('保存把路由发给了宿主接口', saveCall !== undefined && saveCall.body.routes.length === 1, JSON.stringify(saveCall?.body))
check(
  '保存体回传既有路由的 id（改名不换 provider）且不带凭据名',
  saveCall?.body?.routes?.[0]?.id === 'workbuddy2apicn' && saveCall?.body?.routes?.[0]?.apiKeyEnv === undefined,
  JSON.stringify(saveCall?.body?.routes?.[0]),
)
check('保存成功后卡片给出提示', /已保存并生效/u.test(collectText(render({ view: 'page' })).join(' | ')))

const addButton = findNode(tree, (node) => node.type === 'button' && collectText(node).join('') === '＋ 添加路由')
addButton?.props.onClick()
tree = render({ view: 'page' })
const rowsAfterAdd = collectInputs(tree)
const emptyNames = rowsAfterAdd.filter((input) => input.props.placeholder === '例如 work2api-CN' && input.props.value === '')
const emptyUrls = rowsAfterAdd.filter((input) => input.props.placeholder === 'http://127.0.0.1:7863/v1' && input.props.value === '')
check('「添加路由」新增一行（id 留空待派生）', emptyNames.length === 1, `空的分组名称输入框 ${emptyNames.length} 个`)
check('新行的分组名称与 URL 都待填', emptyNames.length === 1 && emptyUrls.length === 1)

// ── 显示开关：命令与思考「完全展开」（写 ui-chat.transcriptView） ──

console.log('\n[5b] 客户端卡片：命令与思考展开开关')

/**
 * 用一个全新的 React 桩重新物化客户端 bundle —— 等价于「重新挂载一次卡片」。
 * 复用同一个桩会让 hook 槽位跨场景残留（真实挂载不会），所以每个场景各挂一次。
 *
 * @param ctx - 假的客户端上下文；`get('configForms')` 决定设置服务是否可用。
 */
function mountFresh(ctx = { get: () => undefined }) {
  const stub = createReactStub()
  const clientModule = loaderRegistrations[0].factory((specifier) => {
    if (specifier === 'react') return stub
    throw new Error(`客户端 bundle 要求了未声明的依赖：${specifier}`)
  })
  const slots = {
    registered: [],
    inject: (name, callback) => callback(),
    register(options, Component) {
      this.registered.push({ options, Component })
      return () => {}
    },
  }
  // 真实宿主上下文本就带 `get`（服务查找）与 `slots`，这里照同样形状造一个。
  clientModule.apply({ ...ctx, slots })
  const entry = slots.registered[0]
  return {
    options: entry.options,
    /** 一次渲染（先归零 hook 游标）。 */
    render: (props) => {
      stub.__begin()
      return entry.Component(props)
    },
  }
}

/** 假的 configForms：够用的 getSnapshot / subscribe / set，并记录写入。 */
function createFakeConfigForms(initialMode) {
  let value = { transcriptView: initialMode }
  const listeners = new Set()
  const writes = []
  const form = {
    writes,
    getSnapshot: () => ({ value }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: async (field, next) => {
      writes.push([field, next])
      value = { ...value, [field]: next }
      for (const listener of [...listeners]) listener()
      return true
    },
  }
  return {
    form,
    writes,
    get: (namespace) => (namespace === 'ui-chat' ? form : undefined),
    externalChange: (mode) => {
      value = { ...value, transcriptView: mode }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 在树里找出「命令与思考」那个开关的 checkbox。 */
function findTranscriptSwitch(node) {
  const label = findNode(node, (candidate) => candidate.type === 'label' && collectText(candidate).join('').includes('命令与思考：完全展开'))
  if (label === undefined) return undefined
  return findNode(label, (candidate) => candidate.type === 'input' && candidate.props.type === 'checkbox')
}

{
  const forms = createFakeConfigForms('standard')
  const mount = mountFresh({ get: (service) => (service === 'configForms' ? forms : undefined) })
  check('插槽 inject 把 configForms 交给卡片', mount.options.inject().configForms === forms)
  const view = mount.render({ view: 'page', configForms: forms })
  const toggle = findTranscriptSwitch(view)
  check('卡片渲染出「命令与思考：完全展开」开关', toggle !== undefined)
  check('默认（standard）时开关是关闭状态', toggle?.props.checked === false, `checked=${toggle?.props.checked}`)
  check('开关旁标出当前档位', /当前：标准（折叠）/u.test(collectText(view).join(' | ')), collectText(view).join(' | ').match(/当前：[^|]+/u)?.[0])

  toggle?.props.onChange({ target: { checked: true } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('打开开关写入 transcriptView=verbose', forms.writes.some(([field, value]) => field === 'transcriptView' && value === 'verbose'), JSON.stringify(forms.writes))
  const afterOn = mount.render({ view: 'page', configForms: forms })
  check('写入后开关保持开启（走同一份设置快照）', findTranscriptSwitch(afterOn)?.props.checked === true)
  check('当前档位显示为完全展开', /当前：完全展开/u.test(collectText(afterOn).join(' | ')))

  findTranscriptSwitch(afterOn)?.props.onChange({ target: { checked: false } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('关闭开关写回 transcriptView=standard', forms.writes.some(([field, value]) => field === 'transcriptView' && value === 'standard'), JSON.stringify(forms.writes))
}

{
  // 从 DSH 自己的设置页改成 verbose，卡片上的开关应当跟着变（订阅生效）
  const forms = createFakeConfigForms('standard')
  const mount = mountFresh({ get: () => forms })
  mount.render({ view: 'page', configForms: forms })
  forms.externalChange('verbose')
  const synced = mount.render({ view: 'page', configForms: forms })
  check('DSH 设置页改了档位，卡片开关跟着变（订阅同步）', findTranscriptSwitch(synced)?.props.checked === true)
}

{
  // 没有设置服务的宿主：开关不可用，但卡片照常渲染、不抛
  const mount = mountFresh({ get: () => undefined })
  check('无 configForms 时 inject 给出 undefined', mount.options.inject().configForms === undefined)
  const view = mount.render({ view: 'page' })
  check('无 configForms 时不抛异常且给出说明', /没有设置服务/u.test(collectText(view).join(' | ')), collectText(view).join(' | ').match(/本宿主[^|]+/u)?.[0])
  check('无 configForms 时开关禁用', findTranscriptSwitch(view)?.props.disabled === true)
}

console.log('\n[5c] 客户端卡片：模型选择（勾选要启用的模型）')

/** 带模型清单的宿主状态（三条模型，覆盖有/无思考、图片、倍率）。 */
const selectionStatus = {
  ok: true,
  configFile: 'C:/Users/x/.dsh/.workbuddy2api-connect.json',
  refreshMinutes: 30,
  updatedAt: '2026-10-19T13:00:00.000Z',
  routes: [
    {
      id: 'workbuddy2apicn',
      displayName: 'work2api-CN',
      baseURL: 'http://192.168.1.201:7863/v1',
      apiKeyEnv: 'WORKBUDDY2APICN_API_KEY',
      hasKey: true,
      reasoning: null,
      models: 3,
      enabled: 3,
      exclude: [],
      fetchedAt: Date.now() - 60_000,
      source: 'live',
      error: null,
      contextMin: 128_000,
      contextMax: 1_000_000,
      efforts: ['low', 'high', 'max'],
      offCount: 1,
      catalog: [
        { id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxTokens: 32_768, reasoning: true, efforts: ['low', 'high', 'max'], off: true, images: false, rate: null },
        { id: 'cn:glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 128_000, maxTokens: 16_384, reasoning: false, efforts: [], off: false, images: true, rate: null },
        { id: 'cn:kimi-k3', name: 'Kimi K3', contextWindow: 256_000, maxTokens: 8_192, reasoning: true, efforts: ['high'], off: false, images: false, rate: 'x0.79' },
      ],
    },
  ],
}

const realFetch = globalThis.fetch
const selectionCalls = []
globalThis.fetch = async (url, options) => {
  selectionCalls.push({ url: String(url), body: options?.body === undefined ? undefined : JSON.parse(options.body) })
  return { ok: true, status: 200, json: async () => selectionStatus }
}

/** 按文本找按钮。 */
function findButton(node, text) {
  return findNode(node, (candidate) => candidate.type === 'button' && collectText(candidate).join('').includes(text))
}

/** 收集「模型行」（label 里含模型 id 前缀的那些）。 */
function collectModelRows(node, token = 'cn:', out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectModelRows(child, token, out)
    return out
  }
  if (node.type === 'label' && collectText(node).join(' ').includes(token)) out.push(node)
  for (const child of node.children ?? []) collectModelRows(child, token, out)
  return out
}

/** 模型行 → 它的 checkbox。 */
const checkboxOf = (label) => findNode(label, (candidate) => candidate.type === 'input' && candidate.props.type === 'checkbox')

{
  const mount = mountFresh({ get: () => undefined })
  mount.render({ view: 'page' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  let view = mount.render({ view: 'page' })

  check('默认收起，但标题给出「启用 N / 共 M」', findButton(view, '模型选择（启用 3 / 共 3）') !== undefined,
    collectText(view).join(' | ').match(/模型选择[^|]*/u)?.[0])

  findButton(view, '模型选择（启用')?.props.onClick()
  view = mount.render({ view: 'page' })
  let rows = collectModelRows(view)
  check('展开后列出全部模型', rows.length === 3, `行数 ${rows.length}`)
  check('默认全部勾选（exclude 为空）', rows.every((label) => checkboxOf(label)?.props.checked === true))
  const facts = collectText(view).join(' | ')
  check('每行标出上下文/思考/图片/倍率', /1000K · 思考 low\/high\/max · 可关/u.test(facts) && /图片/u.test(facts) && /x0\.79/u.test(facts), facts.match(/cn:[^|]+\|[^|]*/u)?.[0])

  // 取消勾选一个模型 → 计入 exclude，标题数字跟着变
  const glmRow = rows.find((label) => collectText(label).join(' ').includes('cn:glm-5.3-flash'))
  checkboxOf(glmRow)?.props.onChange({ target: { checked: false } })
  view = mount.render({ view: 'page' })
  check('取消勾选后该模型变为未启用', checkboxOf(collectModelRows(view).find((label) => collectText(label).join(' ').includes('cn:glm-5.3-flash')))?.props.checked === false)
  check('标题计数变为「启用 2 / 共 3」', findButton(view, '模型选择（启用 2 / 共 3）') !== undefined)

  // 保存 → 请求体里带上 exclude
  findButton(view, '保存并生效')?.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const saved = selectionCalls.filter((call) => call.url.includes('/save')).at(-1)
  check('保存把未启用的模型作为 exclude 提交', JSON.stringify(saved?.body?.routes?.[0]?.exclude) === '["cn:glm-5.3-flash"]',
    JSON.stringify(saved?.body?.routes?.[0]))

  // 全不选 / 全选
  view = mount.render({ view: 'page' })
  findButton(view, '模型选择（启用')?.props.onClick()
  view = mount.render({ view: 'page' })
  findButton(view, '全不选')?.props.onClick()
  view = mount.render({ view: 'page' })
  check('「全不选」后一个都不启用并给出警告', findButton(view, '模型选择（启用 0 / 共 3）') !== undefined && /一个模型都没启用/u.test(collectText(view).join(' | ')))
  findButton(view, '全选')?.props.onClick()
  view = mount.render({ view: 'page' })
  check('「全选」后恢复全部启用', findButton(view, '模型选择（启用 3 / 共 3）') !== undefined)

  // 关键字过滤（此时模型选择区仍是展开状态：保存会把展开状态重置，所以这里不重复点击）
  view = mount.render({ view: 'page' })
  const filterInput = findNode(view, (candidate) => candidate.type === 'input' && typeof candidate.props.placeholder === 'string' && candidate.props.placeholder.includes('输入关键字过滤'))
  check('模型选择里有搜索框', filterInput !== undefined)
  filterInput?.props.onChange({ target: { value: 'glm' } })
  view = mount.render({ view: 'page' })
  check('搜索只留下匹配的模型', collectModelRows(view).length === 1, `行数 ${collectModelRows(view).length}`)
}

{
  // 没有模型表时给指引，而不是空白
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => cardStatus })
  const mount = mountFresh({ get: () => undefined })
  mount.render({ view: 'page' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const view = mount.render({ view: 'page' })
  check('没有模型表时提示去点「拉取模型」', /点「拉取模型」/u.test(collectText(view).join(' | ')), collectText(view).join(' | ').match(/填好 URL[^|]*/u)?.[0])
  check('没有模型表时不显示全选/全不选', findButton(view, '全不选') === undefined)
}

globalThis.fetch = realFetch

console.log('\n[5d] 客户端卡片：点模型选择就地拉取（含错误提示）')

const noRouteStatus = {
  ok: true,
  configFile: 'C:/Users/x/.dsh/.workbuddy2api-connect.json',
  refreshMinutes: 30,
  updatedAt: '2026-10-19T13:30:00.000Z',
  routes: [],
}

let probeMode = 'ok'
const probeCalls = []
const realFetchAgain = globalThis.fetch
globalThis.fetch = async (url, options) => {
  const target = String(url)
  if (!target.includes('/probe')) return { ok: true, status: 200, json: async () => noRouteStatus }
  const body = JSON.parse(options.body)
  probeCalls.push(body)
  if (typeof body.baseURL !== 'string' || body.baseURL.trim().length === 0) {
    return { ok: false, status: 400, json: async () => ({ ok: false, error: '请先填 URL（网关的 OpenAI 兼容基地址）' }) }
  }
  if (probeMode === 'fail') {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, url: `${body.baseURL}/models`, error: 'HTTP 401 Unauthorized——网关拒绝了这把 Key（不对、过期或没有权限）：{"error":{"code":"invalid_api_key"}}' }),
    }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      url: `${body.baseURL}/models`,
      models: 2,
      catalog: [
        { id: 'gw:alpha', name: 'Alpha', contextWindow: 256_000, maxTokens: 8_192, reasoning: true, efforts: ['high'], off: false, images: false, rate: null },
        { id: 'gw:beta', name: 'Beta', contextWindow: 32_000, maxTokens: 1_024, reasoning: false, efforts: [], off: false, images: false, rate: null },
      ],
    }),
  }
}

{
  const mount = mountFresh({ get: () => undefined })
  mount.render({ view: 'page' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  let view = mount.render({ view: 'page' })

  // 新建一条空路由（模拟「刚加了一行」）
  findButton(view, '添加路由')?.props.onClick()
  view = mount.render({ view: 'page' })
  check('新路由显示「拉取模型」按钮（而不是空白）',
    findButton(view, '拉取模型（按当前 URL / Key 去网关取）') !== undefined,
    collectText(view).join(' | ').match(/拉取模型[^|]*/u)?.[0])

  // 没填 URL 就点 → 宿主拒绝，界面把原因显示出来
  findButton(view, '拉取模型')?.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  view = mount.render({ view: 'page' })
  check('没填 URL 点拉取 → 卡片里显示失败原因',
    /拉取模型失败：请先填 URL/u.test(collectText(view).join(' | ')),
    collectText(view).join(' | ').match(/拉取模型失败[^|]*/u)?.[0])

  // 填 URL 后再点 → 拉到模型清单
  const urlInput = findNode(view, (candidate) => candidate.type === 'input' && candidate.props.placeholder === 'http://127.0.0.1:7863/v1')
  check('找得到 URL 输入框', urlInput !== undefined)
  urlInput?.props.onChange({ target: { value: 'http://gw.test/v1' } })
  view = mount.render({ view: 'page' })
  check('改 URL 后旧的失败提示被清掉', !/拉取模型失败/u.test(collectText(view).join(' | ')))

  findButton(view, '拉取模型')?.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  view = mount.render({ view: 'page' })
  check('点拉取后按当前 URL 请求宿主', probeCalls.at(-1)?.baseURL === 'http://gw.test/v1', JSON.stringify(probeCalls.at(-1)))
  check('拉到的模型立刻列出来', collectModelRows(view, 'gw:').length === 2, `行数 ${collectModelRows(view, 'gw:').length}`)
  check('标题变成「模型选择（启用 2 / 共 2）」', findButton(view, '模型选择（启用 2 / 共 2）') !== undefined)
  check('标明这是现拉的、还没保存', /现拉，尚未保存/u.test(collectText(view).join(' | ')))

  // 网关报错（密钥不对）→ 错误原文显示
  probeMode = 'fail'
  findButton(view, '重新拉取')?.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  view = mount.render({ view: 'page' })
  const errorText = collectText(view).join(' | ')
  check('网关报 401 时把原因显示在卡片里',
    /拉取模型失败：HTTP 401/u.test(errorText) && /invalid_api_key/u.test(errorText),
    errorText.match(/拉取模型失败[^|]*/u)?.[0])
  check('失败时不残留旧清单', collectModelRows(view, 'gw:').length === 0, `行数 ${collectModelRows(view, 'gw:').length}`)

  // 再改 URL → 回到「拉取模型」
  probeMode = 'ok'
  findNode(view, (candidate) => candidate.type === 'input' && candidate.props.placeholder === 'http://127.0.0.1:7863/v1')
    ?.props.onChange({ target: { value: 'http://gw2.test/v1' } })
  view = mount.render({ view: 'page' })
  check('换 URL 后回到「拉取模型」入口', findButton(view, '拉取模型（按当前 URL / Key 去网关取）') !== undefined)
}

globalThis.fetch = realFetchAgain

// ────────────────────────── 收尾 ──────────────────────────
console.log('\n— 插件日志 —')
for (const [level, message] of logs) if (level === 'info' || level === 'warn' || level === 'error') console.log(`  [${level}] ${message}`)

// 先拆干净（释放适配器注册 + 清掉自调度定时器），再退出：否则 Windows 上
// libuv 会在仍有未关闭句柄时抛 async.c 断言。
for (const disposer of effects) {
  try {
    disposer()
  } catch {
    // 释放失败不影响核对结论
  }
}
rmSync(work, { recursive: true, force: true })
await new Promise((resolve) => setTimeout(resolve, 100))

console.log(`\n在线核对完成：${checks - failures}/${checks} 通过`)
process.exitCode = failures === 0 ? 0 : 1
