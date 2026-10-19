/**
 * dsh-workbuddy2api-connect —— 把 WorkBuddy2API 网关的模型目录同步进 DSH，
 * 并提供一个可视界面来增删/编辑网关路由（分组名称 / URL / Key）。
 *
 * 网关（workbuddy2api，或任意 OpenAI 兼容反代）在 `GET {baseURL}/models` 上已经
 * 透出了 DSH 需要的全部模型事实：模型名、思考档位、最大上下文、最大输出、图像
 * 能力、积分倍率。而 DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai` 只能靠人在
 * `cordis.patch.yml` 里手写 `providers.<route>.models`——手写路由的每个模型都得
 * 自己补 `reasoningEfforts`，否则模型选择器里根本不会出现「推理等级」；改一次
 * 模型表就要重启一次 DSH。
 *
 * 本插件把这条链子接上：启动时（以及之后按周期）拉一次网关模型表，映射成 pi-ai
 * 的 model descriptor，注册成 DSH 的 provider 路由；模型表变了下一个刷新周期就
 * 跟上。界面（浏览器侧 `lib/client.js`，挂在「插件」页的本插件卡片上）让用户直接
 * 增删路由、改分组名 / URL / Key，保存即热重注册，**不需要重启 DSH**。
 *
 * 字段映射（网关 → pi-ai / DSH）：
 *
 * | 网关 | 用途 |
 * |---|---|
 * | `id` | 模型 id（含 `cn:` / `global:` 域前缀，原样保留） |
 * | `name` | 选择器显示名（可选拼上积分倍率） |
 * | `reasoning_supported_efforts` | 思考档位（选择器的「推理等级」） |
 * | `can_disable_thinking` | 是否提供「关闭思考」（仅 deepseek 系真正生效，见下） |
 * | `supports_reasoning` | 是否推理模型（false → 选择器不出现档位控件） |
 * | `context_length` | **最大上下文**（`contextWindow`） |
 * | `max_output_tokens` | 最大输出（`maxTokens` / `defaultMaxTokens`） |
 * | `supports_images` | 输入模态（是否声明 `image`） |
 * | `credits` | 积分倍率，仅显示 |
 *
 * 关于「关闭思考」为什么只在 deepseek 系出现：网关的 `internal/upstream/thinking.go`
 * 只对 `deepseek*` 模型处理 `thinking.type`，其它模型（glm / kimi / gpt / gemini）
 * 会把 `thinking` 字段原样转给上游，实测上游忽略它——也就是说对这些模型，链路上
 * **没有**任何能真正关掉思考的手段（`reasoning_effort: off` 会被网关按 supportedEfforts
 * 降级回最低档，依然思考）。所以插件只对 deepseek 系模型提供 `off`。
 *
 * @module dsh-workbuddy2api-connect
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import Schema from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 稳定 Cordis 插件名。 */
export const name = 'llm-workbuddy2api'

/** 模型登记处：没有它无法注册路由。 */
export const inject = ['llm']

/** 界面与宿主接口的路径前缀。 */
export const WEB_BASE = '/workbuddy2api-connect'

// ────────────────────────────── 常量 ──────────────────────────────

/** pi-ai 的思考档位全集（顺序即选择器里的顺序）。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 网关 effortRank 认的档位（`off` 另有语义，不作为可下发档位）。 */
const WIRE_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 网关没给容量时的回退值，与 pi-ai 自身默认一致。 */
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768

/** 一次流读取的在途上限，沿用 dsh-llm-pi-ai 的默认。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * 路由默认思考档（未显式配置时）。网关侧实测：不声明档位的请求会由 thinking.go
 * 补上 `enabled` + 该模型默认档，但给宿主一个明确的默认档能让「档位」这件事在
 * 选择器里也可见、可选；`high` 与网关自己的默认档一致。
 */
const DEFAULT_ROUTE_EFFORT = 'high'

/** 图像请求预算，与 dsh-llm-pi-ai 默认一致。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/** 订阅额度（积分）折不出单价，报价一律 0，避免客户端做假账。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 路由 id 的合法形态：它同时是 provider 名，不能有空格/斜杠。 */
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 凭据引用名的合法形态（POSIX 标识符，与凭据库的校验一致）。 */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 单次界面请求体上限。 */
const MAX_BODY_BYTES = 256 * 1024

/** 一条路由最多记录多少个「被排除」的模型 id（界面全不选时会等于模型总数）。 */
const MAX_EXCLUDED_MODELS = 2000

/**
 * 惰性 auth 平面：本插件的鉴权走每请求的 `resolveApiKey`（网关 Bearer），
 * pi-ai 自己的凭据生命周期与 ambient 发现都不该凭空造出一个凭据来。
 */
const INERT_AUTH = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-workbuddy2api-connect: the workbuddy2api routes have no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

// ────────────────────────────── 配置 ──────────────────────────────

const EffortSchema = Schema.union([
  Schema.const('off'),
  Schema.const('minimal'),
  Schema.const('low'),
  Schema.const('medium'),
  Schema.const('high'),
  Schema.const('xhigh'),
  Schema.const('max'),
])

/** 一条网关路由 = 一个 provider 分组。 */
const RouteSchema = Schema.object({
  id: Schema.string().required().description('DSH provider 路由名（选择器分组键；会话与默认模型按它引用）'),
  displayName: Schema.string().description('分组的显示名，缺省用路由名'),
  baseURL: Schema.string().required().description('OpenAI 兼容基地址，如 http://127.0.0.1:7863/v1'),
  apiKeyEnv: Schema.string().description('凭据引用名（DSH 凭据库 / 环境变量），每请求解析一次'),
  apiKey: Schema.string().description('内联密钥；apiKeyEnv 可解析时以它为准'),
  headers: Schema.dict(Schema.string()).default({}).description('附加请求头（部署标识等）'),
  exclude: Schema.array(Schema.string()).default([]).description('要排除的模型 id（精确匹配）'),
  defaultContextWindow: Schema.number().default(DEFAULT_CONTEXT_WINDOW).description('网关未声明上下文时的回退值'),
  defaultMaxTokens: Schema.number().default(DEFAULT_MAX_TOKENS).description('网关未声明输出上限时的回退值'),
  reasoning: EffortSchema.description('该路由的默认思考档；模型不支持时自动退回「无默认」'),
})

/** 插件配置。 */
export const Config = Schema.object({
  routes: Schema.array(RouteSchema).default([]).description('初始路由（仅当配置文件不存在时作为种子写入）'),
  refreshMinutes: Schema.number().default(30).description('模型表刷新周期（分钟）'),
  timeoutMs: Schema.number().default(20_000).description('单次模型表请求总时长上限'),
  showRate: Schema.boolean().default(true).description('模型名后附带积分倍率（仅显示，不影响路由）'),
  maxTokensCap: Schema.number().default(0).description('输出上限钳制（0 = 不钳制）'),
  configFile: Schema.string().description('路由配置文件路径，缺省 $DSH_HOME/.workbuddy2api-connect.json'),
})

// ─────────────────────── 纯映射函数（可单测） ───────────────────────

/** DSH 的 harness 家目录。 */
function dshHome() {
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 取字符串字段的第一个非空值。 */
function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 取正整数字段的第一个可用值。 */
function firstPositiveInt(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

/** 取布尔字段的第一个可用值。 */
function firstBoolean(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

/** 字符串数组字段（兼容 snake_case / camelCase / 单字符串形态）。 */
function stringArray(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
    if (typeof value === 'string' && value.length > 0) return value.split(/[,/\s]+/)
  }
  return []
}

/** 网关 id 的「裸模型名」：去掉 `cn:` / `global:` 这类域前缀。 */
export function bareModelId(id) {
  const at = id.indexOf(':')
  return at === -1 ? id : id.slice(at + 1)
}

/**
 * 是否 deepseek 系模型（网关 `thinking.go` 的判定口径：裸名前缀 `deepseek`）。
 * 只有这一族在链路上真正支持「关闭思考」，见文件头注释。
 */
export function isDeepSeekFamily(id) {
  return bareModelId(id).toLowerCase().startsWith('deepseek')
}

/** 一条原始条目 → 归一化字段。 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = firstString(raw, ['id', 'model'])
  if (id === undefined) return undefined
  return {
    id,
    name: firstString(raw, ['name', 'display_name', 'displayName', 'title']) ?? id,
    contextWindow: firstPositiveInt(raw, ['context_length', 'contextLength', 'context_window', 'contextWindow', 'max_allowed_size']),
    maxTokens: firstPositiveInt(raw, ['max_output_tokens', 'maxOutputTokens', 'max_tokens', 'maxTokens']),
    supportsReasoning: firstBoolean(raw, ['supports_reasoning', 'supportsReasoning']),
    efforts: stringArray(raw, ['reasoning_supported_efforts', 'reasoningSupportedEfforts', 'supported_efforts']),
    canDisableThinking: firstBoolean(raw, ['can_disable_thinking', 'canDisableThinking']) === true,
    supportsImages: firstBoolean(raw, ['supports_images', 'supportsImages']) === true,
    credits: firstString(raw, ['credits', 'rate']),
    raw,
  }
}

/** 从任意形态的模型表响应里取出条目数组。 */
export function parseCatalog(payload) {
  const container = Array.isArray(payload) ? payload : payload?.data ?? payload?.models ?? payload?.result
  if (!Array.isArray(container)) return []
  const out = []
  for (const item of container) {
    const entry = normalizeEntry(item)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/** 从 `credits` 这类自由文本里抠出倍率，规范成 `x0.79`。 */
export function rateOf(entry) {
  if (entry.credits === undefined) return undefined
  const match = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(entry.credits)
  return match === null ? undefined : `x${match[1]}`
}

/**
 * 思考能力 → pi-ai 的 `reasoning` + `thinkingLevelMap`。
 *
 * 规则（依据见 README「思考档位怎么来的」）：
 * - 上游声明了档位列表 → 按声明给；未声明的档位显式写 `null`（不支持）。这与
 *   dsh-llm-pi-ai 自己的 `resolveModelReasoning` 同口径：pi-ai 对缺键的默认是
 *   不对称的（base 五档缺键当「支持」、`xhigh`/`max` 缺键当「不支持」），逐个
 *   写死才不会让用户看到一个假档位。
 * - 没有声明列表（或声明为假）→ `reasoning: false`：选择器不出现档位控件，
 *   请求不带 `reasoning_effort`，由网关/上游用自己的默认档。
 * - `off` 只在「声明了 can_disable_thinking」且「deepseek 系」时提供；下发走
 *   `thinking: {type: 'disabled'}`（pi-ai 的 deepseek 分支），网关照抄、上游照关。
 *
 * **不变式（为什么要 defaultLevel 参与 off 的判断）**：pi-ai 的 deepseek 分支把
 * 「没有档位」翻译成 `thinking: {type: 'disabled'}`，而宿主只在确实有档位时才发
 * `reasoningEffort`（`dsh-agent-loop`）。也就是说：一个 deepseek 模型如果既没被
 * 选中档位、又没被通告默认档，请求就会走成「关思考」——用户没做任何选择却被静默
 * 关掉思考。为此：只有该模型**同时**支持路由默认档时，才提供 `off`。
 *
 * @param entry - 归一化后的模型条目。
 * @param options - `defaultLevel` 是该路由的默认档。
 */
export function reasoningFields(entry, options = {}) {
  const declared = entry.efforts
    .map((item) => item.trim().toLowerCase())
    .filter((item) => WIRE_EFFORTS.has(item))
  if (entry.supportsReasoning === false || declared.length === 0) return { reasoning: false }
  const offered = new Set(declared)
  const defaultLevel = options.defaultLevel
  const defaultAdvertisable = defaultLevel === undefined || offered.has(defaultLevel)
  const map = {}
  for (const level of THINKING_LEVELS) {
    if (level === 'off') {
      map.off = entry.canDisableThinking && isDeepSeekFamily(entry.id) && defaultAdvertisable ? 'off' : null
    } else {
      map[level] = offered.has(level) ? level : null
    }
  }
  return { reasoning: true, thinkingLevelMap: map }
}

/** 模型显示名：原名 + 可选倍率后缀（只进显示层，路由仍用 `id`）。 */
export function displayNameOf(entry, showRate) {
  if (!showRate) return entry.name
  const rate = rateOf(entry)
  return rate === undefined ? entry.name : `${entry.name} · ${rate}`
}

/**
 * 一条网关条目 → 一个 pi-ai model descriptor。
 *
 * `compat` 两项都必要：
 * - `maxTokensField: 'max_tokens'`：网关两种写法都吃，直发主字段少一层歧义；
 * - `thinkingFormat: 'deepseek'` 仅给 deepseek 系：这是让「关闭思考」变成
 *   `thinking.type=disabled`（而不是一个会被降级回最低档的 `reasoning_effort`）
 *   的唯一途径。
 */
export function toPiModel(entry, options) {
  const { provider, baseUrl, defaultContextWindow, defaultMaxTokens, maxTokensCap, showRate, defaultLevel } = options
  const declaredMax = entry.maxTokens ?? defaultMaxTokens
  const compat = { maxTokensField: 'max_tokens' }
  if (isDeepSeekFamily(entry.id)) compat.thinkingFormat = 'deepseek'
  return {
    id: entry.id,
    name: displayNameOf(entry, showRate),
    api: 'openai-completions',
    provider,
    baseUrl,
    input: entry.supportsImages ? ['text', 'image'] : ['text'],
    ...reasoningFields(entry, { defaultLevel }),
    cost: NO_COST,
    contextWindow: entry.contextWindow ?? defaultContextWindow,
    maxTokens: maxTokensCap > 0 ? Math.min(declaredMax, maxTokensCap) : declaredMax,
    compat,
  }
}

/** 把基地址拼成模型表 URL（带不带末尾 `/v1` 都吃）。 */
export function modelsUrl(baseURL) {
  const trimmed = baseURL.replace(/\/+$/, '')
  return trimmed.endsWith('/models') ? trimmed : `${trimmed}/models`
}

/** 路由 id → 凭据引用名（界面保存的密钥存在凭据库的这个名字下）。 */
export function credentialRefFor(id) {
  return `WB2API_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * 分组名称 → 路由 id（provider 名）。
 *
 * 界面只让用户填分组名称，id 由这里派生：取名称里可用的 ASCII 片段、折叠分隔符，
 * 中文等非 ASCII 名称退化为 `wb2api`，再按需要加序号去重。
 *
 * **只在新建路由时派生**：既有路由的 id 由界面回传（用户看不见但一直带着），改名不会
 * 换掉 provider 名——否则改个显示名就会让既有会话与 `agent-default-model` 指空。
 */
export function deriveRouteId(displayName, taken) {
  const folded = String(displayName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48)
  const base = /^[a-z0-9]/.test(folded) ? folded : 'wb2api'
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('派生路由 id 失败（同名路由过多）')
}

// ────────────────────────── 路由配置存储 ──────────────────────────

/**
 * 非机密字段存本插件自己的 JSON 文件；**密钥只进 DSH 凭据库**（`ctx.credentials`
 * 的 refs），所以这个文件里永远不会有明文密钥。
 *
 * cordis 配置里的 `routes` 只在文件不存在时作为种子写入一次；此后界面（或手工改
 * 文件）是唯一事实来源，避免「改了 cordis 没反应」这种两处配置打架。
 */
function createRouteStore(ctx, config) {
  const file = config.configFile !== undefined && config.configFile.length > 0
    ? config.configFile
    : join(dshHome(), '.workbuddy2api-connect.json')

  const read = () => {
    try {
      if (!existsSync(file)) return undefined
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.routes)) return undefined
      return parsed.routes
    } catch (error) {
      ctx.logger.warn(`dsh-workbuddy2api-connect: 路由配置文件读不了（${file}）：${errorText(error)}；改用 cordis 配置里的种子路由`)
      return undefined
    }
  }

  const write = (routes) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), routes }, undefined, 2), 'utf8')
    renameSync(tmp, file)
  }

  /** 读配置：文件优先，其次 cordis 种子（并落盘，让界面看到的就是实际生效的）。 */
  const load = () => {
    const fromFile = read()
    if (fromFile !== undefined) return fromFile
    const seed = (config.routes ?? []).map((route) => ({ ...route }))
    if (seed.length > 0) {
      try {
        write(seed)
      } catch (error) {
        ctx.logger.warn(`dsh-workbuddy2api-connect: 路由配置文件写不进去（${file}）：${errorText(error)}`)
      }
    }
    return seed
  }

  return { file, load, write }
}

/** 兜底拿一个可读的错误文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 校验界面送来的一条路由。
 *
 * 界面只填「分组名称 / URL / Key」三样，所以：
 * - `id` 缺省时按分组名称派生（`deriveRouteId`）；带 id 说明是既有路由，原样沿用。
 * - 凭据名缺省时沿用该 id 原来的凭据名，全新路由才派生 `WB2API_KEY_<id>`——否则界面
 *   只改个分组名，原本指向 `WORKBUDDY2API_API_KEY` 的路由会突然去查派生名，密钥凭空失效。
 *
 * @param raw - 界面送来的原始路由。
 * @param index - 在数组里的位置，只用于报错定位。
 * @param options.known - 当前已生效的路由（按 id），用于继承凭据名。
 * @param options.taken - 本批次已占用的路由 id，用于派生去重。
 * @returns 归一化后的路由，或 `{ error }`。
 */
function validateRoute(raw, index, options = {}) {
  const known = options.known ?? new Map()
  const taken = options.taken ?? new Set()
  const label = `第 ${index + 1} 条路由`
  if (raw === null || typeof raw !== 'object') return { error: `${label}不是对象` }

  const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''
  const rawName = typeof raw.displayName === 'string' ? raw.displayName.trim() : ''
  if (rawId.length === 0 && rawName.length === 0) return { error: `${label}缺少分组名称` }
  if (rawId.length > 0 && !ROUTE_ID.test(rawId)) return { error: `${label}的路由 id "${rawId}" 不合法` }
  const id = rawId.length > 0 ? rawId : deriveRouteId(rawName, taken)

  const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL.trim() : ''
  if (baseURL.length === 0) return { error: `${label}（${rawName || id}）缺少 URL` }
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    return { error: `${label}（${rawName || id}）的 URL 解析失败：${baseURL}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `${label}（${rawName || id}）的 URL 只支持 http/https，收到 ${parsed.protocol}` }
  }
  const displayName = rawName.length > 0 ? rawName : id
  if (displayName.length > 64) return { error: `${label}（${id}）的分组名称过长（≤64 字符）` }
  const apiKeyEnvRaw = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : ''
  const inherited = known.get(id)?.apiKeyEnv
  const apiKeyEnv = apiKeyEnvRaw.length > 0
    ? apiKeyEnvRaw
    : typeof inherited === 'string' && inherited.length > 0
      ? inherited
      : credentialRefFor(id)
  if (!CREDENTIAL_REF.test(apiKeyEnv)) return { error: `${label}（${id}）的凭据名 "${apiKeyEnv}" 不合法（POSIX 标识符）` }
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : undefined
  if (apiKey !== undefined && apiKey.length > 0) {
    if (apiKey.length > 4096) return { error: `${label}（${id}）的密钥过长` }
    if (/[\r\n\u0000]/.test(apiKey)) return { error: `${label}（${id}）的密钥含换行或控制字符` }
  }
  const headers = {}
  if (raw.headers !== undefined && raw.headers !== null && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === 'string' && key.length > 0 && key.length <= 128 && !/[\r\n\u0000]/.test(key) && !/[\r\n\u0000]/.test(value)) headers[key] = value
    }
  }
  const exclude = Array.isArray(raw.exclude)
    ? [...new Set(raw.exclude.filter((item) => (
        typeof item === 'string' && item.length > 0 && item.length <= 200 && !/[\r\n\u0000]/.test(item)
      )))].slice(0, MAX_EXCLUDED_MODELS)
    : []
  const defaultContextWindow = Number.isInteger(raw.defaultContextWindow) && raw.defaultContextWindow > 0 ? raw.defaultContextWindow : DEFAULT_CONTEXT_WINDOW
  const defaultMaxTokens = Number.isInteger(raw.defaultMaxTokens) && raw.defaultMaxTokens > 0 ? raw.defaultMaxTokens : DEFAULT_MAX_TOKENS
  return {
    route: {
      id,
      displayName,
      baseURL: baseURL.replace(/\/+$/, ''),
      apiKeyEnv,
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(exclude.length === 0 ? {} : { exclude }),
      defaultContextWindow,
      defaultMaxTokens,
      ...(typeof raw.reasoning === 'string' && raw.reasoning.length > 0 ? { reasoning: raw.reasoning } : {}),
    },
    clearKey: raw.clearKey === true,
  }
}

// ────────────────────────── 模型表取数 ──────────────────────────

/** 拉一次模型表。 */
async function fetchCatalog(route, apiKey, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const headers = { accept: 'application/json', ...route.headers }
  if (apiKey !== undefined && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(modelsUrl(route.baseURL), { headers, signal: timeout })
  const text = await response.text()
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? '——网关拒绝了这把 Key（不对、过期或没有权限）'
      : response.status === 404
        ? '——这个地址下没有 /models，确认 URL 是否指到网关的 /v1 根'
        : ''
    throw new Error(`HTTP ${response.status} ${response.statusText}${hint}：${text.slice(0, 200)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`模型表不是合法 JSON：${text.slice(0, 200)}`)
  }
  return parseCatalog(payload)
}

/**
 * 一条模型的界面视图（界面勾选用）。`/status` 与 `/probe` 共用同一份映射，
 * 保证「已保存路由的清单」和「现拉一次的清单」长得一模一样。
 */
export function catalogView(entry, defaultLevel) {
  const fields = reasoningFields(entry, { defaultLevel })
  const reasoning = fields.reasoning === true
  return {
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow ?? null,
    maxTokens: entry.maxTokens ?? null,
    reasoning,
    efforts: reasoning
      ? entry.efforts.map((level) => level.trim().toLowerCase()).filter((level) => WIRE_EFFORTS.has(level))
      : [],
    off: reasoning && fields.thinkingLevelMap?.off === 'off',
    images: entry.supportsImages === true,
    rate: rateOf(entry) ?? null,
  }
}

/**
 * 拉模型表失败时说人话。
 *
 * 界面里「点了模型选择就去拉」是用户主动动作，报错必须能指向具体原因：主机名、端口、
 * 超时、TLS、401/403 各自给不同的句子，而不是一句 `fetch failed`。
 *
 * @param error - 抛上来的错误（可能是 fetch 的网络错误，也可能是我们自己的 HTTP 文本）。
 * @param url - 当时请求的地址。
 * @returns 面向用户的错误文本。
 */
export function probeErrorText(error, url) {
  const name = typeof error?.name === 'string' ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return `连不上 ${url}：超时（网关没有响应）`
  // Node 的 fetch 在双栈下会抛 AggregateError（v4/v6 各一条），错误码埋在 errors[] 里。
  const candidates = [
    error?.cause?.code,
    error?.code,
    ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.map((item) => item?.code) : []),
    ...(Array.isArray(error?.errors) ? error.errors.map((item) => item?.code) : []),
  ]
  const code = candidates.find((value) => typeof value === 'string')
  if (typeof code !== 'string') {
    // 没有 errno 的情况（例如 Fetch 规范的禁用端口、undici 内部错误）：把底层说法带出来。
    const detail = typeof error?.cause?.message === 'string'
      ? error.cause.message
      : (typeof error?.message === 'string' ? error.message : '')
    if (/bad port/i.test(detail)) return `连不上 ${url}：这个端口被 Fetch 规范列为禁用端口（bad port）——换一个端口`
    if (detail.length > 0 && detail !== 'fetch failed') return `连不上 ${url}：${detail}`
    return errorText(error)
  }
  if (typeof code === 'string') {
    if (code === 'ECONNREFUSED') return `连不上 ${url}：端口没有在监听（ECONNREFUSED）——检查地址与端口`
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `解析不了 ${url} 的主机名（${code}）——检查域名或网络`
    if (code === 'ECONNRESET' || code === 'EPIPE') return `连接被中途断开（${code}）：${url}`
    if (code === 'ETIMEDOUT') return `连不上 ${url}：连接超时（ETIMEDOUT）`
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `路由不可达（${code}）：${url}`
    if (code === 'CERT_HAS_EXPIRED') return `${url} 的 TLS 证书已过期`
    if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return `${url} 用的是自签证书，Node 不信任它`
    if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) return `TLS 握手失败（${code}）：${url}`
  }
  return errorText(error)
}

/** 模型表磁盘缓存路径（与路由配置同目录）。 */function cachePathFor(configFile) {
  return `${configFile}.models.json`
}

function readCache(file) {
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed?.version === 1 && parsed.routes !== null && typeof parsed.routes === 'object' ? parsed.routes : {}
  } catch {
    return {}
  }
}

function writeCache(file, states) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const routes = {}
    for (const state of states) {
      if (state.models.length === 0) continue
      routes[state.route.id] = { fetchedAt: state.fetchedAt, models: state.models.map((entry) => entry.raw) }
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), routes }, undefined, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // 缓存写不进去不影响同步主流程
  }
}

// ────────────────────────── 运行期 ──────────────────────────

/**
 * 路由运行期：持有当前路由表、每条路由的模型表状态、pi-ai 适配器与它在 LLM
 * 登记处的注册句柄。界面保存后整体换一套（`applyRoutes`），正在跑的请求继续用
 * 旧快照——`PiAiAdapter` 的快照语义保证「一个请求绝不会在另一份配置下结束」。
 */
function createRuntime(ctx, settings) {
  const { refreshMs, timeoutMs, showRate, maxTokensCap, cacheFile } = settings
  const cached = readCache(cacheFile)

  let states = []
  let profiles = new Map()
  let registration
  let disposed = false

  /** 解析一条路由的密钥：凭据库（apiKeyEnv）→ 环境变量 → 内联 apiKey。 */
  const keyFor = async (route) => {
    const inline = typeof route.apiKey === 'string' && route.apiKey.length > 0 ? route.apiKey : undefined
    const ref = route.apiKeyEnv
    if (typeof ref !== 'string' || ref.length === 0) return inline
    const credentials = ctx.get('credentials')
    const hit = credentials === undefined ? undefined : (await credentials.resolve(ref))?.value
    const fromEnv = process.env[ref]
    const value = hit ?? (typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined) ?? inline
    if (value !== undefined) return value
    throw new LlmError(
      `dsh-workbuddy2api-connect: 路由 "${route.id}" 的凭据 ${ref} 解析为空——请在插件界面填入 Key，或把它导出为环境变量`,
      'MISSING_CREDENTIAL',
    )
  }

  /** 一条路由当前的 pi-ai 模型列表。 */
  const piModels = (state) => {
    const exclude = new Set(state.route.exclude ?? [])
    return state.models
      .filter((entry) => !exclude.has(entry.id))
      .map((entry) => toPiModel(entry, {
        provider: state.route.id,
        baseUrl: state.route.baseURL,
        defaultContextWindow: state.route.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        defaultMaxTokens: state.route.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        maxTokensCap,
        showRate,
        defaultLevel: state.route.reasoning ?? DEFAULT_ROUTE_EFFORT,
      }))
  }

  /** 一个路由的 pi-ai provider；`getModels` 读活状态，刷新后不必重建。 */
  const buildPiProvider = (state) => {
    const base = createProvider({
      id: state.route.id,
      name: state.route.displayName ?? state.route.id,
      auth: {
        apiKey: {
          name: `${state.route.displayName ?? state.route.id} bearer token`,
          async resolve({ credential }) {
            const key = credential?.key
            return typeof key === 'string' && key.length > 0 ? { auth: { apiKey: key }, source: 'workbuddy2api' } : undefined
          },
        },
      },
      models: [],
      api: openAICompletionsApi(),
    })
    return { ...base, getModels: () => piModels(state) }
  }

  /** 整套 profiles 快照；换配置时整体替换（不原地改）。 */
  const buildProfiles = () => {
    const next = new Map()
    for (const state of states) {
      const configuredMaxTokens = new Map()
      for (const model of piModels(state)) configuredMaxTokens.set(model.id, model.maxTokens)
      next.set(state.route.id, {
        provider: state.route.id,
        displayName: state.route.displayName ?? state.route.id,
        reasoning: state.route.reasoning ?? DEFAULT_ROUTE_EFFORT,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, `dsh-workbuddy2api-connect ${state.route.id} retryPolicy`),
        configuredMaxTokens,
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: buildPiProvider(state),
      })
    }
    return next
  }

  const adapter = () => new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async (provider) => {
      const state = states.find((item) => item.route.id === provider)
      return state === undefined ? undefined : await keyFor(state.route)
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })

  /** 停掉全部自调度定时器。 */
  const stopTimers = () => {
    for (const state of states) {
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** 拉一次某条路由的模型表。 */
  const refreshRoute = async (state) => {
    try {
      const apiKey = await keyFor(state.route)
      const entries = await fetchCatalog(state.route, apiKey, timeoutMs)
      if (entries.length === 0) throw new Error('模型表为空（网关可能没有可用账号：`/healthz` 此时返回 503）')
      const changed = state.models.map((entry) => entry.id).join('\n') !== entries.map((entry) => entry.id).join('\n')
      state.models = entries
      state.fetchedAt = Date.now()
      state.source = 'live'
      state.failures = 0
      state.lastError = undefined
      return { ok: true, changed }
    } catch (error) {
      state.failures += 1
      state.lastError = errorText(error)
      return { ok: false, changed: false }
    }
  }

  /** 一条路由的模型表画像，用于日志与界面。 */
  const describe = (state) => {
    if (state.models.length === 0) return '0 个模型'
    const defaultLevel = state.route.reasoning ?? DEFAULT_ROUTE_EFFORT
    const contexts = state.models.map((entry) => entry.contextWindow).filter((value) => typeof value === 'number')
    const span = contexts.length === 0 ? '' : `，上下文 ${Math.round(Math.min(...contexts) / 1000)}K–${Math.round(Math.max(...contexts) / 1000)}K`
    const levels = new Set()
    let offCount = 0
    for (const entry of state.models) {
      const fields = reasoningFields(entry, { defaultLevel })
      if (fields.reasoning !== true) continue
      for (const level of entry.efforts) {
        const trimmed = level.trim().toLowerCase()
        if (WIRE_EFFORTS.has(trimmed)) levels.add(trimmed)
      }
      if (fields.thinkingLevelMap?.off === 'off') offCount += 1
    }
    const thinking = levels.size === 0 ? '' : `，思考档 ${[...levels].join('/')}`
    const off = offCount === 0 ? '' : `，可关思考 ${offCount} 个`
    return `${state.models.length} 个模型${span}${thinking}${off}`
  }

  /** 刷新全部路由；有变化就重建快照并通知宿主。 */
  const refreshAll = async (reason) => {
    const results = await Promise.all(states.map(refreshRoute))
    if (results.some((result) => result.ok && result.changed)) {
      profiles = buildProfiles()
      ctx.emit('llm/adapters-updated')
    }
    if (results.some((result) => result.ok)) writeCache(cacheFile, states)
    for (const state of states) {
      if (state.failures === 0) {
        ctx.logger.info(`dsh-workbuddy2api-connect[${reason}]: 路由 ${state.route.id} → ${describe(state)}（来源 ${state.source}）`)
      } else {
        ctx.logger.warn(
          `dsh-workbuddy2api-connect[${reason}]: 路由 ${state.route.id} 模型表拉取失败（第 ${state.failures} 次）：${state.lastError}` +
          (state.models.length === 0 ? '；当前无模型可用' : `；继续沿用 ${state.models.length} 个模型的旧表`),
        )
      }
    }
    return results
  }

  /** 带退避的自调度：成功按周期跑，失败 10s→20s→40s→…（封顶周期）。 */
  const schedule = (state) => {
    if (disposed || state.timer !== undefined) return
    const delay = state.failures === 0 ? refreshMs : Math.min(refreshMs, 10_000 * 2 ** Math.min(state.failures - 1, 4))
    state.timer = setTimeout(() => {
      state.timer = undefined
      void refreshRoute(state)
        .then(() => {
          profiles = buildProfiles()
          ctx.emit('llm/adapters-updated')
          writeCache(cacheFile, states)
        })
        .catch((error) => ctx.logger.error(`dsh-workbuddy2api-connect: 路由 ${state.route.id} 刷新异常`, error))
        .finally(() => schedule(state))
    }, delay)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  /** 换一套路由：重建状态、重注册 provider、重排定时器。 */
  const applyRoutes = (routes, reason) => {
    stopTimers()
    const previous = new Map(states.map((state) => [state.route.id, state]))
    states = routes.map((route) => {
      const kept = previous.get(route.id)
      const entries = kept !== undefined && kept.models.length > 0 ? kept.models : parseCatalog(cached[route.id]?.models ?? [])
      return {
        route,
        models: entries,
        fetchedAt: kept?.fetchedAt ?? (typeof cached[route.id]?.fetchedAt === 'number' ? cached[route.id].fetchedAt : 0),
        source: entries.length === 0 ? 'none' : kept?.source ?? 'cache',
        failures: 0,
        lastError: undefined,
        timer: undefined,
      }
    })
    profiles = buildProfiles()
    if (registration !== undefined) {
      try {
        registration()
      } catch (error) {
        ctx.logger.warn(`dsh-workbuddy2api-connect: 释放旧路由注册失败：${errorText(error)}`)
      }
      registration = undefined
    }
    if (states.length > 0) {
      try {
        registration = ctx.llm.registerAdapter(states.map((state) => state.route.id), adapter())
      } catch (error) {
        ctx.logger.error(`dsh-workbuddy2api-connect: 路由注册失败（模型分组不会出现）：${errorText(error)}`)
      }
    }
    ctx.emit('llm/adapters-updated')
    ctx.logger.info(
      `dsh-workbuddy2api-connect[${reason}]: 生效 ${states.length} 条路由 ` +
      `[${states.map((state) => `${state.route.id}:${state.models.length}`).join(' ') || '空'}]`,
    )
    return refreshAll(reason)
  }

  /** 界面用的状态快照（绝不含密钥）。 */
  const snapshot = async () => {
    const credentials = ctx.get('credentials')
    const routes = []
    for (const state of states) {
      const ref = state.route.apiKeyEnv
      let hasKey = typeof state.route.apiKey === 'string' && state.route.apiKey.length > 0
      if (!hasKey && typeof ref === 'string' && ref.length > 0) {
        const hit = credentials === undefined ? undefined : (await credentials.resolve(ref))?.value
        hasKey = (hit ?? process.env[ref]) !== undefined
      }
      const defaultLevel = state.route.reasoning ?? DEFAULT_ROUTE_EFFORT
      // 界面要能勾选「用哪些模型」，所以除汇总外把每条模型的要点也带上（不含 raw）。
      const catalog = state.models.map((entry) => catalogView(entry, defaultLevel))
      const exclude = state.route.exclude ?? []
      const excluded = new Set(exclude)
      const contexts = catalog.map((item) => item.contextWindow).filter((value) => typeof value === 'number')
      const efforts = new Set()
      for (const item of catalog) for (const level of item.efforts) efforts.add(level)
      const offCount = catalog.filter((item) => item.off).length
      routes.push({
        id: state.route.id,
        displayName: state.route.displayName ?? state.route.id,
        baseURL: state.route.baseURL,
        apiKeyEnv: ref ?? credentialRefFor(state.route.id),
        hasKey,
        reasoning: state.route.reasoning ?? null,
        models: state.models.length,
        enabled: catalog.filter((item) => !excluded.has(item.id)).length,
        exclude: [...exclude],
        catalog,
        fetchedAt: state.fetchedAt,
        source: state.source,
        error: state.lastError ?? null,
        contextMin: contexts.length === 0 ? null : Math.min(...contexts),
        contextMax: contexts.length === 0 ? null : Math.max(...contexts),
        efforts: [...efforts],
        offCount,
      })
    }
    return { ok: true, routes }
  }

  return {
    applyRoutes,
    refreshAll,
    snapshot,
    schedule,
    states: () => states,
    dispose: () => {
      disposed = true
      stopTimers()
      if (registration !== undefined) {
        try {
          registration()
        } catch {
          // 释放失败不影响退出
        }
        registration = undefined
      }
    },
  }
}

// ────────────────────────── 界面接口（同源 HTTP） ──────────────────────────

/** 环回主机名白名单（与宿主其它本地接口同口径）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 去掉 Host 的端口，IPv6 括号感知。 */
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/**
 * 只有环回请求能进：Host 必须是环回地址（挡 DNS rebinding），浏览器带来的
 * Origin 也必须是环回（同源 fetch 不带 Origin，直接放行）。
 */
function loopbackRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host.trim() === '' || !LOOPBACK_HOSTS.has(hostnameOfHost(host))) return false
  const origin = req.headers.origin
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** 读一个受限长度的 JSON 请求体。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 挂上界面用的同源接口。
 *
 * - `GET  {base}/status`  当前路由表 + 每条路由的模型表状态（绝不含密钥）
 * - `POST {base}/save`    保存路由（密钥写进凭据库），随后热重注册并重拉模型表
 * - `POST {base}/refresh` 立刻重拉全部模型表
 * - `POST {base}/probe`   按界面当前的 URL/Key 现拉一次模型表（不落盘、不注册），
 *                         拉不到就把原因原样返回给界面显示
 */
function registerWebRoutes(ctx, deps) {
  const { runtime, store, settings } = deps

  const status = async (res) => {
    sendJson(res, 200, {
      ...(await runtime.snapshot()),
      configFile: store.file,
      refreshMinutes: settings.refreshMinutesRaw,
      updatedAt: new Date().toISOString(),
    })
  }

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${WEB_BASE}/status`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        if (!loopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'request-not-trusted' })
        try {
          await status(res)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${WEB_BASE}/refresh`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        if (!loopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'request-not-trusted' })
        try {
          await runtime.refreshAll('ui-refresh')
          await status(res)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    }))
    // 「点了模型选择就去拉」：不落盘、不注册，只按界面当前的 URL/Key 现拉一次模型表。
    // 失败一律把原因说清楚（主机名/端口/超时/TLS/401/404），界面直接显示这句话。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${WEB_BASE}/probe`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        if (!loopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'request-not-trusted' })

        // 只读一次请求体（流读过就没了）。
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: errorText(error) })
        }

        let target
        try {
          const raw = typeof body?.baseURL === 'string' ? body.baseURL.trim() : ''
          if (raw.length === 0) throw new Error('请先填 URL（网关的 OpenAI 兼容基地址）')
          let parsed
          try {
            parsed = new URL(raw)
          } catch {
            throw new Error(`URL 不合法：${raw}`)
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`URL 只支持 http/https，收到 ${parsed.protocol}`)
          }
          const id = typeof body?.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined
          const state = id === undefined ? undefined : runtime.states().find((item) => item.route.id === id)
          target = {
            baseURL: raw,
            route: { baseURL: raw, headers: state?.route.headers ?? {} },
            defaultLevel: state?.route.reasoning ?? DEFAULT_ROUTE_EFFORT,
            // 已保存的路由用自己的凭据名；新路由按 id 派生（万一它已经存过 Key）
            ref: state?.route.apiKeyEnv ?? (id === undefined || !ROUTE_ID.test(id) ? undefined : credentialRefFor(id)),
          }
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: errorText(error) })
        }

        // 密钥：界面刚填的优先；没填就按凭据名去凭据库 / 环境变量捞已保存的那把。
        let apiKey
        if (typeof body?.apiKey === 'string' && body.apiKey.trim().length > 0) {
          apiKey = body.apiKey.trim()
        } else if (typeof target.ref === 'string' && target.ref.length > 0) {
          const credentials = ctx.get('credentials')
          const stored = credentials === undefined ? undefined : (await credentials.resolve(target.ref))?.value
          const fromEnv = process.env[target.ref]
          apiKey = stored ?? (typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined)
        }

        const url = modelsUrl(target.baseURL)
        try {
          const entries = await fetchCatalog(target.route, apiKey, settings.timeoutMs)
          if (entries.length === 0) {
            return sendJson(res, 200, { ok: false, url, error: `${url} 通了，但没有解析出任何模型（返回里没有 data/models 数组）` })
          }
          sendJson(res, 200, {
            ok: true,
            url,
            models: entries.length,
            catalog: entries.map((entry) => catalogView(entry, target.defaultLevel)),
          })
        } catch (error) {
          // 200 + ok:false：这是「网关那边的问题」，不是接口调用失败，界面据此原文显示。
          sendJson(res, 200, { ok: false, url, error: probeErrorText(error, url) })
        }
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${WEB_BASE}/save`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        if (!loopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'request-not-trusted' })
        try {
          const body = await readJsonBody(req)
          if (!Array.isArray(body?.routes)) throw new Error('请求体缺少 routes 数组')
          if (body.routes.length > 32) throw new Error('路由条数上限 32')
          const routes = []
          const keyWrites = []
          const seen = new Set()
          const names = new Set()
          const known = new Map(runtime.states().map((state) => [state.route.id, state.route]))
          for (const [index, raw] of body.routes.entries()) {
            const checked = validateRoute(raw, index, { known, taken: seen })
            if (checked.error !== undefined) throw new Error(checked.error)
            const { route, clearKey } = checked
            if (seen.has(route.id)) throw new Error(`路由 id 重复：${route.id}`)
            seen.add(route.id)
            if (names.has(route.displayName)) {
              throw new Error(`分组名称重复：${route.displayName}——分组名称是界面上的唯一标识，请改用不同的名字`)
            }
            names.add(route.displayName)
            if (typeof route.apiKey === 'string' && route.apiKey.length > 0) keyWrites.push({ ref: route.apiKeyEnv, value: route.apiKey, action: 'set' })
            else if (clearKey) keyWrites.push({ ref: route.apiKeyEnv, value: undefined, action: 'unset' })
            // 密钥不落进配置文件：只留凭据引用
            const { apiKey: _drop, ...persisted } = route
            routes.push(persisted)
          }
          if (keyWrites.length > 0) {
            const credentials = ctx.get('credentials')
            if (credentials === undefined) {
              throw new Error('本宿主没有凭据服务，界面无法保存 Key；请改用 apiKeyEnv 指向环境变量')
            }
            for (const write of keyWrites) {
              if (write.action === 'set') await credentials.set(write.ref, write.value)
              else await credentials.unset(write.ref)
            }
          }
          store.write(routes)
          await runtime.applyRoutes(routes, 'ui-save')
          await status(res)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: errorText(error) })
        }
      },
    }))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-workbuddy2api-connect: UI routes')
}

// ────────────────────────── 插件主体 ──────────────────────────

export function apply(ctx, config) {
  const refreshMs = Math.max(60_000, Math.floor((config.refreshMinutes ?? 30) * 60_000))
  const timeoutMs = Math.max(1_000, Math.floor(config.timeoutMs ?? 20_000))
  const showRate = config.showRate !== false
  const maxTokensCap = Math.max(0, Math.floor(config.maxTokensCap ?? 0))
  const store = createRouteStore(ctx, config)
  const settings = {
    refreshMs,
    timeoutMs,
    showRate,
    maxTokensCap,
    cacheFile: cachePathFor(store.file),
    refreshMinutesRaw: config.refreshMinutes ?? 30,
  }

  const runtime = createRuntime(ctx, settings)
  ctx.effect(() => () => runtime.dispose())

  const routes = store.load().filter((route) => ROUTE_ID.test(route?.id ?? '') && typeof route?.baseURL === 'string')
  if (routes.length === 0) {
    ctx.logger.warn('dsh-workbuddy2api-connect: 没有配置任何网关路由；到「插件」页的本插件卡片里添加一条即可')
  }
  void runtime.applyRoutes(routes, 'startup')
    .catch((error) => ctx.logger.error('dsh-workbuddy2api-connect: 启动同步失败', error))
    .finally(() => {
      for (const state of runtime.states()) runtime.schedule(state)
    })

  // webServer 在无界面（headless）profile 里不存在——界面接口随之缺席，同步照常。
  ctx.inject(['webServer'], (scope) => {
    registerWebRoutes(scope, { runtime, store, settings })
  })

  ctx.logger.info(
    `dsh-workbuddy2api-connect: 已接管 ${routes.length} 条网关路由 ` +
    `[${routes.map((route) => route.id).join(' ') || '空'}]，刷新周期 ${Math.round(refreshMs / 60_000)} 分钟；` +
    `配置文件 ${store.file}`,
  )
}
