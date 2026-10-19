# v0.3.1

修好 **DSH 0.2.1-rc.2** 上的「不适配」：插件代码没坏，坏在两处元数据。

## 根因

| 现象 | 真因 |
|---|---|
| 升级后模型分组整组消失 | 更新重写了 profile 的 `package.json`，`dsh.profile.bundles` 里只剩官方条目，插件的 `cordis.patch.yml` 不再生效 |
| 即便加回 bundle 也不加载 | manifest 的 peer 钉着 `@deepseek-ai/dsh-llm: 0.2.0-rc.2`，运行时是 `0.2.1-rc.2`，被 `evaluatePluginCompatibility` 判为不兼容 |

第二点值得单独记一句：npm semver 对**预发布版本**有额外规则——只有 range 里出现同一个
`X.Y.Z` 的预发布比较符，该版本才算满足。所以 `0.2.0-rc.2`、`>=0.2.0-rc.2`、
`>=0.2.0-0 <0.3.0` 这几种写法**都**判定不了 `0.2.1-rc.2`（已用运行时自带的 semver 逐个验证）。
结论：**不要用 peer 去钉 dsh 版本**。

## 改动

- **去掉 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-llm-pi-ai` 两个 peer**（官方自带插件也都不声明），
  不再被 dsh 的版本闸门卡住；`@earendil-works/pi-ai` 的 peer 放宽为 `>=0.87.1 <2.0.0`（运行时已升到 1.1.0）
- 新增 `node tools/check-compat.mjs`：直接用 DSH 自己的 `evaluatePluginCompatibility` 判定当前
  运行时，退出码 1 表示不兼容并打印 `requirements` 细节——以后每次 DSH 升级跑一次即可
- README 增「兼容性与升级排查」：两种成因、自检命令、以及补丁版部署下 `dsh plugin install`
  因 `app.asar` 路径而失败时的兜底装法（解压到 profile 的 `node_modules`）

## 验证

- `node tools/check-compat.mjs` → 兼容 ✓（同一脚本对旧清单返回不兼容 ✗，反证判定确实生效）
- `node tools/dump-profile.mjs` → bundle 层含 `dsh-workbuddy2api-connect`，合成条目 7 条
- `node test/verify.mjs --offline` → 28/28；`node test/verify.mjs` → **100/100**
  （真连两个网关、真发最小对话、界面接口、客户端卡片与展开开关，全部在 0.2.1-rc.2 + pi-ai 1.1.0 上跑通）

## 顺带

- profile 里被更新冲掉的 `ui-chat.transcriptView` 已改回 `standard`（= 卡片上「命令与思考：
  完全展开」开关的关闭态），并在配置里加了两行注释，免得下次更新又被静默改回 `verbose`
- 与本次更新无关但会挡路的：profile 里 `dsh-purge`（github master tarball）的锁文件哈希已过期，
  `pnpm install` 会报 `ERR_PNPM_TARBALL_INTEGRITY`。本次没动它（用解压兜底装法绕开），
  要恢复一条命令装包的话，需在确认上游内容后跑 `pnpm install --update-checksums`。
