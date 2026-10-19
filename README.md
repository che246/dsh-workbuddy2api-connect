# dsh-workbuddy2api-connect

把 **WorkBuddy2API 网关**的模型目录自动同步进 **DeepSeek Harness**：模型名、思考档位、
最大上下文、最大输出、图像能力，全部来自网关的 `/v1/models`；**并带一个界面**，可以直接
增删路由、改分组名称 / URL / Key，保存即热重注册——不用手写配置，不用重启 DSH。

```
WorkBuddy2API 网关  GET /v1/models
        │  id / name / reasoning_supported_efforts / context_length / max_output_tokens / supports_images
        ▼
dsh-workbuddy2api-connect   （本插件：拉表 → 映射 → 注册 provider；界面负责增删路由）
        ▼
DSH  @deepseek-ai/dsh-llm-pi-ai  →  模型选择器里的一个分组（模型 + 推理等级 + 上下文窗口）
```

## 界面

装好并重启 DSH 后，打开左侧栏 **「插件」** → 本插件那一行的配置区（DSH 0.2.0 的
`plugins.bundle.config` 位，按包名 `dsh-workbuddy2api-connect` 分发）。

每一条路由就是一张卡，**三个输入** + 一个状态行：

| 字段 | 说明 |
|---|---|
| **分组名称** | 模型选择器里显示的分组名（如 `work2api-CN`） |
| **URL** | 网关的 OpenAI 兼容基地址（如 `http://192.168.1.201:7863/v1`） |
| **Key** | 网关的 API Key。**只写不回显**：已保存时输入框留空、标签提示「已保存，留空不改」，要换就填新的，要删就勾「清除已保存的 Key」 |

界面上不需要（也没有）路由 id 与凭据名，两者都由**分组名称自动派生**：

| 派生 | 规则 | 例子 |
|---|---|---|
| 路由 id（= provider 名） | 分组名称折小写、非 `a-z0-9._-` 的字符折成 `-`、去首尾符号、截断 48 字符；中文等非 ASCII 名称退化为 `wb2api`；重名自动加序号 | `work2api-CN` → `work2api-cn`；`我的网关` → `wb2api`；已有 `my-gw` 时 `My GW` → `my-gw-2` |
| 凭据名 | `WB2API_KEY_<路由id 大写、非字母数字折成 _>` | `my-gateway` → `WB2API_KEY_MY_GATEWAY` |

> **路由 id 只在新建时派生，之后改名不变**：界面会把它随保存请求回传（用户看不见），
> 所以改分组名称只是换个显示名，既有会话与 `agent-default-model` 里记的 `{provider, model}`
> 不会指空。想真正换 provider 名，直接编辑配置文件。

底部三个按钮：**保存并生效**（写入 + 热重注册 + 重拉模型表，全程不重启）、
**立即刷新模型表**、**重新读取**。每条路由的状态行显示 `20 个模型 · 上下文 192K–1000K ·
思考档 low/high/max · 可关思考 3 个 · 30 分钟前`；拉取失败时**原样显示网关的错误**
（例如密钥不对会看到 `HTTP 401 invalid_api_key`），而不是给一张空表。

密钥去向：**DSH 凭据库**（`ctx.credentials` 的 refs，即 `~/.dsh/.credentials.yaml`），
插件自己的配置文件里**只有凭据名、没有明文密钥**。

### 显示开关：命令与思考「完全展开」

卡片顶部还有一个 DSH 显示开关（**默认关闭**）：

| 开关 | 写入的值 | 效果 |
|---|---|---|
| 关（默认） | `ui-chat.transcriptView = standard` | 折叠已完成轮次、步骤分组——DSH 桌面版默认 |
| 开 | `ui-chat.transcriptView = verbose` | **轮次不折叠、步骤不分组**，命令与思考全部摊开 |

改的是 DSH 自己那个值（**设置 → 通用 → 工作详情**，同一个 `ui-chat` 设置分节），走
`ctx.configForms.get('ui-chat').set(...)`——宿主设置持久化 + **立即生效，不需要重启**；两边
随时同步（卡片订阅了设置变化，在 DSH 设置页改这里也跟着变）。开关旁会标出当前档位
（`compact` 精简 / `standard` 标准 / `detailed` 详细 / `verbose` 完全展开），四个档位都能被如实
显示出来。宿主没有设置服务（headless）时开关禁用并说明原因，不影响网关同步。

### 配置的优先级

| 来源 | 何时生效 |
|---|---|
| 界面保存的 `$DSH_HOME/.workbuddy2api-connect.json` | **优先**。存在即以此为准 |
| `cordis.patch.yml` 里本插件的 `config.routes` | 仅当上面的文件**不存在**时作为种子写入一次 |

也就是说：首次启动把 cordis 里的路由种进配置文件，之后界面（或手工改那个 JSON）是唯一
事实来源——不会出现「改了两处配置互相打架」。

## 它解决什么问题

DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai` 支持手写网关路由，但在 `cordis.patch.yml` 里手写
路由时：

1. 只能写 `id` / `name` / `contextWindow` / `maxTokens` 这几个字段，**写不进思考档位**——
   想给某个模型加一行「推理等级」，得自己补 `reasoningEfforts`；
2. DSH 的设置界面**故意不提供档位控件**（`dsh-client-ui-settings-models` 的源码注释明确
   指向 `cordis.patch.yml`），也就是说档位只能手工维护；
3. 网关新增/下架模型，得改配置 + **重启 DSH** 才生效。

本插件把这条链子自动化：**从网关读事实，自己装配 provider**，并给一个界面来增删路由。

## 安装

两种方式都行：**从 Release 附件装**（推荐，不用 clone 源码），或**从源码打包装**。

### 桌面版

桌面版的 `desktop` profile 由 App 独占管理（独立 CLI 的 `--dump-config` 之类会被拒绝），
但装包这条路是通的。

**推荐：手工改两处配置再 `install`**——`dsh plugin add` 会重写 `dsh.profile.bundles`，实测会把
其它第三方 bundle 从列表里挤掉（本机丢过 `dsh-workbuddy-connect` 与
`@eghrhegpe/dsh-connect-qoder`）；而 `install` 只装依赖、**不动配置**。

```powershell
# 1) 从 Release 取附件（或自己 npm pack 出来的那个）放进本地插件目录
copy dsh-workbuddy2api-connect-0.3.1.tgz "$env:USERPROFILE\.dsh\local-plugins\"
```

2) 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 两处：

- `dependencies` 里加一行
  `"dsh-workbuddy2api-connect": "file:C:/Users/<你>/.dsh/local-plugins/dsh-workbuddy2api-connect-0.3.1.tgz"`
- `dsh.profile.bundles` 数组里追加 `"dsh-workbuddy2api-connect"`

```powershell
# 3) 装依赖（DSH 自带的 CLI 只是 pnpm install）
cd "$env:USERPROFILE\.dsh\profiles\desktop"
$dsh = "D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"   # 换成你的安装目录
& $dsh plugin --profile desktop install
```

> 也可以一条命令 `& $dsh plugin --profile desktop add "<附件路径>"`（自动写依赖与 bundles），
> 但装完**务必核对 `dsh.profile.bundles`**，少了别的插件就补回去。

### Web / TUI

```sh
dsh plugin --profile web add https://github.com/che246/DeepSeek-Harness-workbuddy2api-panel/releases/download/v0.3.1/dsh-workbuddy2api-connect-0.3.1.tgz
```

### 从源码

```sh
npm pack                        # → dsh-workbuddy2api-connect-0.3.1.tgz
```

再按上面「桌面版」或「Web / TUI」的方式装上那个 tgz。

### 装完

**重启一次 DSH**：profile 的 patch 层与客户端 bundle 都只在启动时装配。重启后模型选择器里
出现本插件声明的分组（默认 `work2api-AI` / `work2api-CN`），「插件」页里出现配置卡片。

> ⚠️ 装/升级需要重启一次（插件在 boot 时注册 provider 路由与浏览器卡片）；此后改路由、
> 模型表变化都不再需要重启——这正是本插件的意义。
>
> ⚠️ `dsh plugin add` 会重写 profile 的 `dsh.profile.bundles`：本机两次升级各丢过别的插件
> （`dsh-workbuddy-connect`、`@eghrhegpe/dsh-connect-qoder`），而 `install` 从不动配置。
> 这也是上面推荐手工改配置的原因；用 `add` 的话装完请核对那个列表。

## 兼容性与升级排查（DSH 更新后「不适配」）

DSH 更新后插件消失，实测两种成因，**都不在插件代码里**：

1. **profile 的 `dsh.profile.bundles` 被重置**。更新会重写
   `~/.dsh/profiles/<profile>/package.json`，bundles 里只剩官方条目，插件的
   `cordis.patch.yml` 于是根本不生效——看着像「不适配」，其实只是没被加载。
   把 `"dsh-workbuddy2api-connect"` 加回 `dsh.profile.bundles` 就恢复。
2. **manifest 的 peer 版本判定**。DSH 用 `evaluatePluginCompatibility` 比对
   `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer，而 DSH 版本是预发布序列
   （`0.2.0-rc.2` → `0.2.1-rc.2` → …）。npm semver 对预发布有额外规则：只有 range 里
   出现**同一个 X.Y.Z 的预发布比较符**，该版本才算满足。所以 `0.2.0-rc.2`、甚至
   `>=0.2.0-0 <0.3.0` 这种看似宽松的写法都判定不了 `0.2.1-rc.2`。**本插件因此不再声明
   任何 `@deepseek-ai/dsh-*` peer**——官方自带的插件也都不声明。

自检工具：

```sh
node tools/check-compat.mjs      # 用 DSH 自己的判定逻辑比对当前运行时；退出码 1 = 不兼容
node tools/dump-profile.mjs      # 看 profile 实际合成出的 bundle 层与插件条目
```

实测通过：`dsh 0.2.0-rc.2`（pi-ai 0.87.1）与 `dsh 0.2.1-rc.2`（pi-ai 1.1.0），各 100 项在线核对。

升级后安装还有一个坑：在「`resources/app/` 补丁版」这类部署里，升级后
`dsh plugin --profile desktop install` 可能报
`Cannot find module ...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`
（CLI 仍按 asar 布局找入口）。这时不必修 CLI：把依赖与 bundle 条目写进 profile 的
`package.json`，再把 tgz 解压到 `~/.dsh/profiles/<profile>/node_modules/<包名>/`，
DSH 一样能解析（本机这次就是这么恢复的）。

## 配置（cordis 层）

插件自带一个 bundle 级 `cordis.patch.yml`，装完即用；要改就在 **profile 层**
（`~/.dsh/profiles/<profile>/cordis.patch.yml`）覆盖同名 `id` 的条目：

```yaml
- id: llm-workbuddy2api
  name: dsh-workbuddy2api-connect
  config:
    refreshMinutes: 30          # 模型表刷新周期（分钟）
    timeoutMs: 20000            # 单次模型表请求上限
    showRate: true              # 模型名后附带积分倍率（仅显示）
    maxTokensCap: 0             # 输出上限钳制（0 = 不钳制）
    configFile:                 # 路由配置文件，缺省 $DSH_HOME/.workbuddy2api-connect.json
    routes:                     # 仅当配置文件不存在时作为种子
      - id: workbuddy2api       # provider 名 = 选择器分组键（会话按它引用）
        displayName: work2api-AI
        baseURL: http://192.168.1.201:7864/v1
        apiKeyEnv: WORKBUDDY2API_API_KEY      # DSH 凭据库引用 → 环境变量 → apiKey
      - id: workbuddy2apicn
        displayName: work2api-CN
        baseURL: http://192.168.1.201:7863/v1
        apiKeyEnv: WORKBUDDY2APICN_API_KEY
        headers: {}             # 可选：附加请求头
        exclude: []             # 可选：要排除的模型 id
        defaultContextWindow: 262144
        defaultMaxTokens: 32768
        reasoning: high         # 可选：该路由的默认思考档
```

密钥的解析顺序：**DSH 凭据库（`apiKeyEnv` 引用）→ 环境变量 → 内联 `apiKey`**；三者都没有
时该路由的请求以 `MISSING_CREDENTIAL` 明确失败，而不是默默发一个匿名请求。

> 路由 id 与原手写路由保持同名是有意为之：`@deepseek-ai/dsh-agent-default-model` 与会话
> 状态里记的都是 `{provider, model}`，沿用同名才能让既有会话与默认模型配置继续可用。

## 字段映射

| 网关字段 | 落到 DSH 的什么 |
|---|---|
| `id` | 模型 id（`cn:` / `global:` 域前缀原样保留） |
| `name` | 选择器显示名（`showRate` 时拼上 `· x0.79`） |
| `reasoning_supported_efforts` | 推理等级（`low` / `medium` / `high` / `xhigh` / `max`） |
| `can_disable_thinking` | 是否提供「关闭思考」（仅 deepseek 系，见下） |
| `supports_reasoning` | 是否推理模型；false → 选择器里不出现档位控件 |
| `context_length` | **最大上下文**（`contextWindow`） |
| `max_output_tokens` | 最大输出（`maxTokens`，同时进 `defaultMaxTokens`） |
| `supports_images` | 输入模态：`text,image` |
| `credits` | 积分倍率，仅显示 |

模型表为空（网关无可用账号、`/healthz` 返回 503）时按失败处理：**保留上一次的模型表**，
并按 10s→20s→40s→…（封顶刷新周期）退避重试。模型表另有一份磁盘缓存
（`<配置文件>.models.json`），所以 DSH 启动时网关恰好不可达，分组也不会空。

## 思考档位怎么来的（含实测依据）

pi-ai 的档位表达是一张 `thinkingLevelMap`：**键**是选择器给出的等级，**值**是下发时在
协议里发送的拼写，`null` 表示该等级不支持。这里有四条不显然的规则，每条都是实测结论：

**1. 声明之外的档位显式写 `null`。** pi-ai 对缺键的默认是不对称的——base 五档
（`off`/`minimal`/`low`/`medium`/`high`）缺键当「支持」，`xhigh`/`max` 缺键当「不支持」。
只写声明的那些档，用户就会在 `cn:glm-5.1`（只声明 `medium`）上看到一个假的 `high`。

**2. 没有档位声明的模型给 `reasoning: false`。** `cn:auto`、`global:default-model` 这类
条目只声明了「我支持推理」，没给档位列表。此时不给档位控件，请求不带 `reasoning_effort`，
由网关/上游用自己的默认档——比根据经验补一套「通用档位」诚实：WorkBuddy 的档位是产品侧
私有逻辑，补出来的档位可能被上游静默忽略（一次成功不能证明档位真实可用）。

**3. 路由默认档 + 一条不变式：只有默认档能被明确下发时才提供 `off`。**

宿主只在确实有档位时才发 `reasoningEffort`（`dsh-agent-loop`），而 pi-ai 的 deepseek
分支把「没有档位」翻译成 `thinking: {type: 'disabled'}`。两者叠加意味着：一个 deepseek
模型如果既没被选中档位、又没被通告默认档，请求就会走成「关思考」——用户没做任何选择
却被静默关掉思考。

所以插件给每条路由一个默认档（默认 `high`，可用 `routes[].reasoning` 覆盖），并守住：
**只有该模型同时支持默认档时才提供 `off`**。于是

- 支持默认档：默认档会被通告并发下去，`off` 只在用户明确选它时下发 → 真关掉；
- 不支持默认档：一律不提供 `off`，此时两边都不发 `thinking`，由网关按自己的默认档
  注入（`thinking.go` 的 `enabled` + 该模型默认档）→ 不会误关。

**4. 「关闭思考」只给 deepseek 系，而且是 `thinking.type` 而非 `reasoning_effort`。**

实测（CN 网关 `:7863`，同一账号同一时刻）：

| 请求 | 结果 |
|---|---|
| `cn:deepseek-v4-flash` + `thinking:{type:'disabled'}` | 返回正文、**无 `reasoning_content`** → 真的关掉了 |
| `cn:deepseek-v4-flash` + `reasoning_effort:'low'` | 有 `reasoning_content` → 档位可用 |
| `cn:glm-5.3` + `thinking:{type:'disabled'}` | **仍有 `reasoning_content`** → 上游忽略该字段 |
| `cn:glm-5.3` + `reasoning_effort:'off'` | 仍有思考：网关照 `effortRank` 把 `off` 降级回该模型最低支持档（`internal/upstream/payload.go:normalizeReasoningEffort`） |

也就是说：只有 deepseek 系在链路上有真正关掉思考的手段（pi-ai 的
`compat.thinkingFormat = 'deepseek'` 分支会把它翻译成 `thinking:{type:'disabled'}`）；
对其它模型，给出一个「关闭」档位等于承诺一件链路上做不到的事，所以插件不给。

> 顺带一处旧配置的语义修正：原先手写路由里给 `cn:deepseek-v4.1-flash` /
> `cn:glm-5.3-flash` 写过 `reasoningEfforts: {off: null}`，按 `dsh-llm-pi-ai` 的规则
> 那是「提供 off 档但下发时不带 `reasoning_effort`」——网关的 `thinking.go` 会据此补上
> `thinking.type=enabled` + 默认档，也就是说那个「off」实际上从未关掉思考。

## 界面接口（`/workbuddy2api-connect/*`）

卡片是纯同源 `fetch` 调这三个宿主接口；接口只接受**环回**请求（Host 必须是环回地址，
浏览器带来的 Origin 也必须是环回），因此不能被外部页面或 DNS rebinding 页面驱动：

| 端点 | 说明 |
|---|---|
| `GET  /workbuddy2api-connect/status` | 当前路由表 + 每条路由的模型数 / 上下文范围 / 思考档 / 上次刷新 / 错误。**绝不回传密钥**，只回 `hasKey` 布尔 |
| `POST /workbuddy2api-connect/save` | 保存路由（`{routes:[{displayName, baseURL, apiKey?, id?, clearKey?}]}`）→ 密钥写凭据库 → 热重注册 → 重拉模型表 |
| `POST /workbuddy2api-connect/refresh` | 立刻重拉全部模型表 |

`save` 的两条语义（都是为了让「界面只填三样」不出事）：

- **`id` 缺省时按分组名称派生**（规则见上表）；带 `id` 说明是既有路由，原样沿用。
- **凭据名缺省时沿用该 id 原来的凭据名**，只有全新路由才派生 `WB2API_KEY_<id>`——否则
  界面只改个分组名，原本指向 `WORKBUDDY2API_API_KEY` 的路由会突然去查派生名，密钥凭空失效。

校验失败一律 400 + 具体原因：URL 必须是 http/https、路由 id 形态、路由 id 不重复、
**分组名称不重复**（它是界面上的唯一标识）、条数上限 32、密钥不得含换行/控制字符。

## 验证

```sh
node test/verify.mjs --offline   # 纯映射函数与派生规则，28 项
node test/verify.mjs             # 真连网关跑一遍插件 + 真发最小对话 + 界面接口 + 客户端卡片，共 100 项
```

在线模式用一个假的 Cordis 上下文把插件真跑起来（真 `apply`、真 `PiAiAdapter`、真 pi-ai、
真网关、真 HTTP 处理函数），核对：

- 模型表拉取与逐条上下文比对（网关字段 ↔ DSH 读到的 `contextWindow`）；
- 思考档位/`off` 的落点；
- **真发一条最小对话**：`cn:glm-5.3` 用 `high` 档拿到正文；`cn:deepseek-v4-flash`
  显式选 `off` 后流里**不出现思考块**；不显式给档位时**走路由默认档**（有思考块）；
- **界面接口**：status/save/refresh 的返回、环回门禁（非环回 Host/Origin → 403）、
  非 http(s) URL / 重复 id / **重复分组名称** → 400、保存后**热重注册**（未重启）、
  密钥进凭据库、配置文件里**没有明文密钥**、错误密钥的 401 如实出现在状态里、
  **不带 id 的新路由按分组名称派生**、**既有路由改名后 provider 名不变**；
- **客户端卡片**：bundle 走 `window.__ModuleLoader__` 注册、挂到 `plugins.bundle.config`
  且注册键 = 包名、卡片只渲染「分组名称 / URL / Key」三个字段（**不再展示路由 id 与
  凭据名**）、Key 不回显、保存体回传既有 id 且不带凭据名、「添加路由」新增一行且留空待派生；
- **显示开关**：默认档位下开关是关的、打开写入 `verbose`、关闭写回 `standard`、
  DSH 设置页改动会同步到开关、宿主没有设置服务时开关禁用且卡片不崩。

> 验证台需要能 import DSH 自带的 `@deepseek-ai/*` 与 `@earendil-works/pi-ai`。
> 在插件源码目录下建两个 junction 指过去即可：
> `node_modules\@deepseek-ai` / `node_modules\@earendil-works` →
> `<DSH 安装目录>\resources\app\dsh\node_modules\{@deepseek-ai,@earendil-works}`。
> 客户端卡片的核对用手写 React 桩（宿主不把 react 作为 Node 包提供，它由前端 shell 注入），
> 所以那是**结构**核对而非 DOM 渲染核对。

## 已知边界

- **首次装/升级需要重启一次**：provider 路由与客户端 bundle 都在 boot 时装配，所以
  装完要重启 DSH 才出现分组与卡片。此后改路由（界面保存）、模型表变化都不再需要重启
  ——这就是本插件的意义。
- **路由名即契约**：`routes[].id` 同时是 provider 名，由分组名称在**新建时**派生，之后
  改名不变。要真正换 provider 名，请直接编辑配置文件（并同步改 `agent-default-model`），
  因为会话与默认模型记的都是 `{provider, model}`。
- **同一个路由不能被两个适配器拥有**：本插件接管 `workbuddy2api` / `workbuddy2apicn`
  之后，请把 `@deepseek-ai/dsh-llm-pi-ai` 里同名的 `providers` 条目删掉（否则谁先注册
  谁生效，另一个静默让位）。
- **`max_output_tokens` 是上游声称值**：网关侧实测普遍虚高（仓库 `scripts/probe_max_tokens.py`
  有 16 个 CN 模型的探测结论），本插件如实透传；要钳就设 `maxTokensCap`。
- **界面只在有 webServer 的 profile 里出现**：headless profile 没有 `webServer`，界面接口
  随之缺席（同步与 provider 注册照常），此时改路由请直接编辑配置文件。
- **客户端卡片不做 i18n**：文案是内联中文，不接 DSH 的 locale 服务——少一个会随内核
  变动的依赖，代价是非中文界面下这块卡片仍是中文。
- 依赖网关的 `/v1/models` 形态（`data[].context_length` 等字段）。条目字段名做了大小写与
  snake/camel 兼容，但私有的网关若换了字段名，需要跟着改 `normalizeEntry`。

## 发布（tag / Release）

版本号只写在 `package.json`。切一个版本：

```sh
# 1) 改 package.json 的 version，并写发布说明 docs/release-notes-v<版本>.md
# 2) 一条命令走完：打 tag → 推 tag → 建 Release → 上传 npm pack 产物
python tools/cut-release.py

python tools/cut-release.py --dry-run     # 只打印计划，不动远端
python tools/cut-release.py --tag-only    # 只打并推 tag
python tools/cut-release.py --body-only   # 只按发布说明重写已有 Release 的正文（改错字用）
python tools/cut-release.py --notes FILE  # 指定发布说明文件
```

- 凭据取 `GITHUB_TOKEN`，没有就从 `~/.git-credentials`（git 的 store helper）取 github.com 那条；仓库地址从 `git remote get-url origin` 读，所以脚本不绑定具体仓库
- **已存在的 tag 不会被动**（tag 一推出去就是对外承诺）；Release 若已存在则复用，只补缺失的附件；`--body-only` 专门用来改正文而不碰 tag 与附件
- Release 正文 = `docs/release-notes-v<版本>.md` + 自动追加的安装章节（桌面版 / Web / TUI 两条路径）；说明里自己写了 `## 安装` 就不重复追加
- 附件就是 `npm pack` 出来的 tgz，安装可以直接指它（见上面「Web / TUI」）

已发布版本：**[v0.3.1](https://github.com/che246/DeepSeek-Harness-workbuddy2api-panel/releases/tag/v0.3.1)**（适配 dsh 0.2.1-rc.2，去掉 dsh peer 版本钉）、**[v0.3.0](https://github.com/che246/DeepSeek-Harness-workbuddy2api-panel/releases/tag/v0.3.0)**（界面新增「命令与思考：完全展开」开关）、**[v0.2.1](https://github.com/che246/DeepSeek-Harness-workbuddy2api-panel/releases/tag/v0.2.1)**。tag 指向发布内容那一次提交；之后的文档/工具提交不重打 tag。

## 许可

MIT。本插件只做「读网关模型表 + 注册 DSH provider」，不代理、不改写、不存储任何对话内容；
网关侧的账号与配额行为请在 WorkBuddy2API 项目里自行约束。
