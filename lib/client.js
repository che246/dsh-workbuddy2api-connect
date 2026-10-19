/**
 * 浏览器侧：本插件在「插件」页（sidebar → 插件 → dsh-workbuddy2api-connect）的配置卡片。
 *
 * 卡片让用户直接增删网关路由：**分组名称 / URL / Key**，保存后宿主立即热重注册
 * provider 并重拉模型表——不重启 DSH。
 *
 * 这是**手写**的客户端 bundle（没有构建步骤）：DSH 的客户端模块系统只要求
 * `window.__ModuleLoader__.load({ id, factory })` 这段注册壳 + CommonJS 形态，
 * 组件用 `React.createElement` 直接写。依赖只有宿主提供的 `react`；样式全部内联，
 * 用 `currentColor` / 半透明中性色，因此明暗主题下都可用，也不依赖任何内部 UI 包
 * （内部包名与插槽契约变化时，本卡片只会少一块界面，不会把插件拖崩）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy2api-connect',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 与宿主 `lib/index.js` 的 WEB_BASE 一致。 */
    const BASE = '/workbuddy2api-connect'
    /** 本 bundle 的包名，也是 `plugins.bundle.config` 的分发键。 */
    const BUNDLE_NAME = 'dsh-workbuddy2api-connect'

    // ─────────────────────────── 样式（内联，明暗通吃） ───────────────────────────

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 },
      intro: { opacity: 0.75, lineHeight: 1.6, margin: 0 },
      card: { border: '1px solid rgba(128,128,128,0.3)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      label: { opacity: 0.7, fontSize: 12 },
      input: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid rgba(128,128,128,0.35)',
        borderRadius: 6,
        padding: '5px 8px',
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
      },
      hint: { opacity: 0.6, fontSize: 11, lineHeight: 1.5 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: {
        background: 'rgba(128,128,128,0.12)',
        color: 'inherit',
        border: '1px solid rgba(128,128,128,0.35)',
        borderRadius: 6,
        padding: '5px 12px',
        cursor: 'pointer',
        font: 'inherit',
      },
      buttonPrimary: {
        background: 'rgba(64,128,255,0.18)',
        borderColor: 'rgba(64,128,255,0.5)',
        color: 'inherit',
        borderRadius: 6,
        padding: '5px 12px',
        cursor: 'pointer',
        font: 'inherit',
      },
      buttonDanger: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid rgba(200,64,64,0.45)',
        borderRadius: 6,
        padding: '4px 10px',
        cursor: 'pointer',
        font: 'inherit',
        opacity: 0.85,
      },
      status: { fontSize: 12, opacity: 0.8, lineHeight: 1.6 },
      ok: { fontSize: 12, color: '#2e9e5b' },
      bad: { fontSize: 12, color: '#d1543f' },
      footer: { fontSize: 11, opacity: 0.55, lineHeight: 1.6, wordBreak: 'break-all' },
      buttonSmall: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid rgba(128,128,128,0.35)',
        borderRadius: 6,
        padding: '2px 8px',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
      },
      modelBox: { display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 8 },
      modelList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 260,
        overflowY: 'auto',
        border: '1px solid rgba(128,128,128,0.2)',
        borderRadius: 6,
        padding: 6,
      },
      modelRow: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', padding: '2px 0' },
      modelId: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' },
    }

    // ─────────────────────────── 工具 ───────────────────────────

    /** 把字节数说成人话。 */
    function formatContext(tokens) {
      if (typeof tokens !== 'number' || tokens <= 0) return null
      return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens)
    }

    /** 相对时间。 */
    function formatAge(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '尚未拉取'
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 60) return `${seconds} 秒前`
      if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
      return `${Math.round(seconds / 3600)} 小时前`
    }

    /** 一条路由的状态摘要。 */
    function describeRoute(route) {
      if (typeof route.error === 'string' && route.error.length > 0) return { text: route.error, bad: true }
      if (route.models === 0) return { text: `${formatAge(route.fetchedAt)} · 还没有模型`, bad: false }
      const span = route.contextMin !== null && route.contextMax !== null
        ? `上下文 ${formatContext(route.contextMin)}–${formatContext(route.contextMax)}`
        : '上下文未知'
      const enabled = typeof route.enabled === 'number' ? route.enabled : route.models
      const parts = [
        enabled === route.models ? `${route.models} 个模型` : `启用 ${enabled} / 共 ${route.models} 个模型`,
        span,
        route.efforts.length > 0 ? `思考档 ${route.efforts.join('/')}` : '无思考档',
        route.offCount > 0 ? `可关思考 ${route.offCount} 个` : null,
        formatAge(route.fetchedAt),
      ].filter(Boolean)
      return { text: parts.join(' · '), bad: false }
    }

    /** 一次宿主接口调用。 */
    async function callHost(path, options) {
      const response = await fetch(`${BASE}${path}`, {
        headers: { accept: 'application/json', ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...options,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`宿主返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    // ─────────────────── DSH 显示开关：命令与思考完全展开 ───────────────────

    /**
     * DSH 把「工作详情」（思考块 + 工具调用/命令）的展开程度存在 `ui-chat` 命名空间的
     * `transcriptView` 字段里，四个档位：
     *
     * | 值 | 中文 | 语义 |
     * |---|---|---|
     * | `compact` | 精简 | 折叠轮次、步骤折叠、无实时细节 |
     * | `standard` | 标准 | 折叠轮次、步骤折叠（桌面版默认） |
     * | `detailed` | 详细 | 折叠轮次、步骤按历史分组 |
     * | `verbose` | 完全展开 | **不折叠轮次、步骤不分组** —— 即「命令与思考全部摊开」 |
     *
     * 写入走 `ctx.configForms.get('ui-chat').set(...)`：这是 DSH 设置页自己用的那条路，
     * 落到宿主设置（`settings.yaml`）并**立即生效**，不需要重启；也因此和
     * 「设置 → 通用 → 工作详情」是同一个值，两边随时同步。
     */
    const TRANSCRIPT_NAMESPACE = 'ui-chat'
    const TRANSCRIPT_FIELD = 'transcriptView'
    const TRANSCRIPT_EXPANDED = 'verbose'
    const TRANSCRIPT_COLLAPSED = 'standard'
    const TRANSCRIPT_LABELS = {
      compact: '精简（折叠）',
      standard: '标准（折叠）',
      detailed: '详细',
      verbose: '完全展开',
    }

    // ─────────────────────────── 卡片 ───────────────────────────

    /** 空路由草稿（id 留空 = 由宿主按分组名称派生）。 */
    function emptyDraft() {
      return {
        id: '',
        displayName: '',
        baseURL: '',
        apiKey: '',
        hasKey: false,
        clearKey: false,
        status: null,
        /** 不启用的模型 id（宿主侧字段名就叫 exclude，方向是「排除」）。 */
        exclude: [],
        /** 模型选择区是否展开（纯界面状态，不提交）。 */
        showModels: false,
        /** 模型搜索词（纯界面状态，不提交）。 */
        filter: '',
      }
    }

    /** 宿主状态 → 可编辑草稿（id 只做回传，不展示）。 */
    function draftFromStatus(status) {
      return status.routes.map((route) => ({
        id: route.id,
        displayName: route.displayName,
        baseURL: route.baseURL,
        apiKey: '',
        hasKey: route.hasKey === true,
        clearKey: false,
        status: route,
        exclude: Array.isArray(route.exclude) ? [...route.exclude] : [],
        showModels: false,
        filter: '',
      }))
    }

    /** 这条路由可选的全部模型（宿主 /status 给的最新一次拉取结果）。 */
    function catalogOf(row) {
      return Array.isArray(row.status?.catalog) ? row.status.catalog : []
    }

    /** 上下文档位 → `192K` 这样的短标签。 */
    function contextLabel(window) {
      if (typeof window !== 'number' || window <= 0) return '—'
      if (window >= 1000) return `${Math.round(window / 1000)}K`
      return `${Math.round(window / 1024)}K`
    }

    /** 一条模型的能力摘要：`192K · 思考 low/high/max · 可关 · 图片`。 */
    function modelFacts(model) {
      const parts = [contextLabel(model.contextWindow)]
      if (model.reasoning === true) parts.push(`思考 ${(model.efforts ?? []).join('/') || '默认'}`)
      if (model.off === true) parts.push('可关')
      if (model.images === true) parts.push('图片')
      if (typeof model.rate === 'string') parts.push(model.rate)
      return parts.join(' · ')
    }

    /**
     * 卡片本体：左侧一串可编辑的路由卡，底部是保存 / 刷新 / 状态。
     */
    function WorkBuddy2ApiConfigPage(props) {
      const [draft, setDraft] = React.useState([])
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)

      // 显示开关：读 ui-chat 的设置作用域（服务缺席时优雅降级，不影响网关同步）。
      const configForms = props?.configForms
      const transcriptForm = configForms === undefined ? undefined : configForms.get(TRANSCRIPT_NAMESPACE)
      const readTranscriptMode = () => {
        if (transcriptForm === undefined) return null
        return transcriptForm.getSnapshot()?.value?.[TRANSCRIPT_FIELD] ?? null
      }
      const [transcriptMode, setTranscriptMode] = React.useState(readTranscriptMode())
      const [transcriptBusy, setTranscriptBusy] = React.useState(false)
      const [transcriptError, setTranscriptError] = React.useState(null)

      React.useEffect(() => {
        if (transcriptForm === undefined) return undefined
        // 先对齐一次当前值（设置可能由 DSH 自己的设置页改过），再订阅后续变化。
        setTranscriptMode(readTranscriptMode())
        return transcriptForm.subscribe(() => setTranscriptMode(readTranscriptMode()))
      }, [transcriptForm])

      const setTranscriptExpanded = async (expanded) => {
        if (transcriptForm === undefined) return
        setTranscriptBusy(true)
        setTranscriptError(null)
        setTranscriptMode(expanded ? TRANSCRIPT_EXPANDED : TRANSCRIPT_COLLAPSED)
        try {
          const accepted = await transcriptForm.set(TRANSCRIPT_FIELD, expanded ? TRANSCRIPT_EXPANDED : TRANSCRIPT_COLLAPSED)
          if (accepted === false) setTranscriptError('宿主没有接受这次写入（设置未改变）')
        } catch (error) {
          setTranscriptError(`写入失败：${error.message}`)
          setTranscriptMode(readTranscriptMode())
        } finally {
          setTranscriptBusy(false)
        }
      }

      const refresh = React.useCallback(async () => {
        const next = await callHost('/status')
        setStatus(next)
        setDraft(draftFromStatus(next))
        setLoaded(true)
        return next
      }, [])

      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const next = await callHost('/status')
            if (!alive) return
            setStatus(next)
            setDraft(draftFromStatus(next))
          } catch (error) {
            if (alive) setMessage({ kind: 'bad', text: `读取插件状态失败：${error.message}` })
          } finally {
            if (alive) setLoaded(true)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const patch = (index, changes) => {
        setDraft((current) => current.map((row, at) => (at === index ? { ...row, ...changes } : row)))
      }

      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          const body = {
            routes: draft.map((row) => {
              const id = row.id.trim()
              return {
                // 既有路由回传 id（界面不展示，只保证 provider 名不因改名而漂移）；
                // 新路由不带 id，由宿主按分组名称派生。
                ...(id.length === 0 ? {} : { id }),
                displayName: row.displayName.trim(),
                baseURL: row.baseURL.trim(),
                apiKey: row.apiKey.length > 0 ? row.apiKey : undefined,
                clearKey: row.clearKey === true,
                // 「不启用的模型」按排除列表提交：空数组 = 全都启用。
                exclude: [...row.exclude],
              }
            }),
          }
          const next = await callHost('/save', { method: 'POST', body: JSON.stringify(body) })
          setStatus(next)
          setDraft(draftFromStatus(next))
          const total = next.routes.reduce((sum, route) => sum + (route.models ?? 0), 0)
          setMessage({ kind: 'ok', text: `已保存并生效：${next.routes.length} 条路由、共 ${total} 个模型（无需重启）` })
        } catch (error) {
          setMessage({ kind: 'bad', text: `保存失败：${error.message}` })
        } finally {
          setBusy(null)
        }
      }

      const refreshModels = async () => {
        setBusy('refresh')
        setMessage(null)
        try {
          const next = await callHost('/refresh', { method: 'POST' })
          setStatus(next)
          setDraft((current) => current.map((row) => {
            const fresh = next.routes.find((route) => route.id === row.id)
            return fresh === undefined ? row : { ...row, status: fresh, hasKey: fresh.hasKey === true }
          }))
          setMessage({ kind: 'ok', text: '模型表已重拉' })
        } catch (error) {
          setMessage({ kind: 'bad', text: `刷新失败：${error.message}` })
        } finally {
          setBusy(null)
        }
      }

      if (props?.view === 'summary') {
        const total = draft.reduce((sum, row) => sum + (row.status?.models ?? 0), 0)
        return `WorkBuddy2API 网关：${draft.length} 条路由 / ${total} 个模型`
      }

      const rows = draft.map((row, index) => {
        const info = row.status ?? status?.routes.find((route) => route.id === row.id) ?? null
        const described = info === null ? null : describeRoute(info)

        // 模型选择：勾选 = 启用，未勾选进 exclude（宿主侧按 exclude 过滤再注册）。
        const catalog = catalogOf(row)
        const excluded = new Set(row.exclude)
        const enabledCount = catalog.filter((model) => !excluded.has(model.id)).length
        const keyword = row.filter.trim().toLowerCase()
        const visible = keyword.length === 0
          ? catalog
          : catalog.filter((model) => model.id.toLowerCase().includes(keyword)
              || String(model.name ?? '').toLowerCase().includes(keyword))
        const toggleModel = (modelId, enabled) => {
          setDraft((current) => current.map((item, at) => {
            if (at !== index) return item
            const next = new Set(item.exclude)
            if (enabled) next.delete(modelId)
            else next.add(modelId)
            return { ...item, exclude: [...next] }
          }))
        }
        const modelPicker = h('div', { style: S.modelBox },
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              style: S.buttonSmall,
              onClick: () => patch(index, { showModels: row.showModels !== true }),
            }, `${row.showModels === true ? '▾' : '▸'} 模型选择（启用 ${enabledCount} / 共 ${catalog.length}）`),
            h('div', { style: { flex: 1 } }),
            catalog.length === 0 ? null : h('button', {
              type: 'button',
              style: S.buttonSmall,
              onClick: () => patch(index, { exclude: [] }),
            }, '全选'),
            catalog.length === 0 ? null : h('button', {
              type: 'button',
              style: S.buttonSmall,
              onClick: () => patch(index, { exclude: catalog.map((model) => model.id) }),
            }, '全不选'),
          ),
          catalog.length === 0
            ? h('div', { style: S.hint }, '还没有模型表：先「保存并生效」或点「立即刷新模型表」，拿到网关的模型清单后再回来勾选。')
            : (row.showModels === true
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    h('input', {
                      style: S.input,
                      value: row.filter,
                      placeholder: `${catalog.length} 个模型，输入关键字过滤…`,
                      onChange: (event) => patch(index, { filter: event.target.value }),
                    }),
                    h('div', { style: S.modelList },
                      visible.map((model) => h('label', { key: model.id, style: S.modelRow },
                        h('input', {
                          type: 'checkbox',
                          checked: !excluded.has(model.id),
                          onChange: (event) => toggleModel(model.id, event.target.checked),
                        }),
                        h('span', { style: S.modelId }, model.id),
                        h('span', { style: S.hint }, modelFacts(model)),
                      )),
                    ),
                    visible.length === 0 ? h('div', { style: S.hint }, `没有匹配「${row.filter}」的模型`) : null,
                    enabledCount === 0
                      ? h('div', { style: S.bad }, '一个模型都没启用——这个分组在模型选择器里会是空的。')
                      : null,
                  )
                : null),
        )

        return h('div', { key: `${index}-${row.id}`, style: S.card },
          h('div', { style: S.grid },
            h('label', { style: S.field },
              h('span', { style: S.label }, '分组名称（模型选择器里显示的名字）'),
              h('input', {
                style: S.input,
                value: row.displayName,
                placeholder: '例如 work2api-CN',
                onChange: (event) => patch(index, { displayName: event.target.value }),
              }),
            ),
            h('label', { style: S.field },
              h('span', { style: S.label }, 'URL（OpenAI 兼容基地址）'),
              h('input', {
                style: S.input,
                value: row.baseURL,
                placeholder: 'http://127.0.0.1:7863/v1',
                spellCheck: false,
                onChange: (event) => patch(index, { baseURL: event.target.value }),
              }),
            ),
            h('label', { style: S.field },
              h('span', { style: S.label }, row.hasKey && row.apiKey.length === 0 ? 'Key（已保存，留空不改）' : 'Key'),
              h('input', {
                style: S.input,
                type: 'password',
                value: row.apiKey,
                autoComplete: 'off',
                placeholder: row.hasKey ? '••••••••（留空保持不变）' : 'sk-...',
                onChange: (event) => patch(index, { apiKey: event.target.value, clearKey: false }),
              }),
            ),
          ),
          h('div', { style: S.hint },
            'provider 名与凭据名都由分组名称自动派生（新建时确定，之后改名不变）；Key 存在 DSH 凭据库里，不会写进插件配置文件。',
          ),
          described !== null
            ? h('div', { style: described.bad ? S.bad : S.status }, described.text)
            : null,
          modelPicker,
          h('div', { style: S.row },
            h('label', { style: { ...S.hint, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: row.clearKey === true,
                onChange: (event) => patch(index, { clearKey: event.target.checked, apiKey: '' }),
              }),
              '清除已保存的 Key',
            ),
            h('div', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              style: S.buttonDanger,
              disabled: busy !== null,
              onClick: () => setDraft((current) => current.filter((_row, at) => at !== index)),
            }, '删除此路由'),
          ),
        )
      })

      const transcriptExpanded = transcriptMode === TRANSCRIPT_EXPANDED
      const transcriptLabel = transcriptMode === null
        ? '未知（还没读到设置）'
        : TRANSCRIPT_LABELS[transcriptMode] ?? transcriptMode
      const transcriptRow = h('div', { style: S.card },
        h('label', { style: { ...S.row, cursor: transcriptForm === undefined ? 'default' : 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: transcriptExpanded,
            disabled: transcriptForm === undefined || transcriptBusy,
            onChange: (event) => void setTranscriptExpanded(event.target.checked),
          }),
          h('span', null, '命令与思考：完全展开'),
          h('span', { style: S.hint }, `当前：${transcriptLabel}`),
        ),
        h('div', { style: S.hint },
          transcriptForm === undefined
            ? '本宿主没有设置服务（configForms），这个开关暂时不可用——不影响网关同步。'
            : '开 = 轮次不折叠、步骤不分组（命令与思考全部摊开）；关 = DSH 默认的标准折叠。' +
              '改的是 DSH 设置里同一个值（设置 → 通用 → 工作详情），保存即生效，不需要重启。',
        ),
        transcriptError !== null ? h('div', { style: S.bad }, transcriptError) : null,
      )

      return h('div', { style: S.page },
        h('p', { style: S.intro },
          '把 WorkBuddy2API 网关的模型目录接进 DSH：插件按每条路由的 /v1/models 自动读取模型名、' +
          '思考档位与最大上下文，注册成模型选择器里的一个分组。保存后立即生效（热重注册），' +
          '模型表随后按周期自动刷新。',
        ),
        transcriptRow,
        rows,
        h('div', { style: S.row },
          h('button', {
            type: 'button',
            style: S.button,
            disabled: busy !== null,
            onClick: () => setDraft((current) => [...current, emptyDraft()]),
          }, '＋ 添加路由'),
          h('button', {
            type: 'button',
            style: S.buttonPrimary,
            disabled: busy !== null || !loaded,
            onClick: () => void save(),
          }, busy === 'save' ? '保存中…' : '保存并生效'),
          h('button', {
            type: 'button',
            style: S.button,
            disabled: busy !== null || !loaded,
            onClick: () => void refreshModels(),
          }, busy === 'refresh' ? '刷新中…' : '立即刷新模型表'),
          h('button', {
            type: 'button',
            style: S.button,
            disabled: busy !== null || !loaded,
            onClick: () => void refresh().catch((error) => setMessage({ kind: 'bad', text: `重新读取失败：${error.message}` })),
          }, '重新读取'),
        ),
        message !== null ? h('div', { style: message.kind === 'ok' ? S.ok : S.bad }, message.text) : null,
        h('div', { style: S.footer },
          status === null
            ? '（还没读到宿主状态）'
            : `配置文件：${status.configFile}（界面保存优先于 cordis.patch.yml 里的 routes 种子）` +
              `　刷新周期：${status.refreshMinutes} 分钟　状态更新：${status.updatedAt}`,
        ),
      )
    }

    // ─────────────────────────── 注册 ───────────────────────────

    /** 浏览器插件名。 */
    const name = 'dsh-workbuddy2api-connect-client'

    /**
     * 只依赖插槽注册处（`@deepseek-ai/dsh-client-ui-renderer` 提供）。
     *
     * `configForms` 刻意**不**写进 inject：那个服务由 `dsh-client-ui-settings` 提供，
     * 声明成必需会让卡片在没有设置服务的宿主上永不注册。改成渲染时按需读取
     * （`ctx.get('configForms')`），服务缺席只是开关不可用，卡片照常工作。
     */
    const inject = ['slots']

    /** 把卡片挂到「插件」页的 bundle 配置位。 */
    function apply(ctx) {
      const register = () => ctx.slots.register(
        {
          name: 'plugins.bundle.config',
          key: BUNDLE_NAME,
          // inject 每次渲染时求值，所以这里读到的是当下的服务（可能晚于本 bundle 启动）。
          inject: () => ({ configForms: ctx.get('configForms') }),
        },
        WorkBuddy2ApiConfigPage,
      )
      try {
        ctx.slots.inject('plugins.bundle.config', () => {
          try {
            return register()
          } catch (error) {
            console.error('[dsh-workbuddy2api-connect] 客户端卡片注册失败（宿主侧同步不受影响）', error)
            return () => {}
          }
        })
      } catch (error) {
        console.error('[dsh-workbuddy2api-connect] 插槽不可用（宿主侧同步不受影响）', error)
      }
    }

    module.exports = { name, apply, inject }
    return module.exports
  },
})
