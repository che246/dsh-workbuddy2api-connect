# v0.5.1

**只跟着仓库改名走的一版**，功能与 v0.5.0 完全一致。

## 变更

- 仓库改名：`DeepSeek-Harness-workbuddy2api-panel` → **`dsh-workbuddy2api-connect`**
  （旧地址 301 到新地址，历史 tag / release / 附件全部保留）
- `package.json` 补上 `repository` / `homepage` / `bugs`（之前没有仓库字段），指向新地址
- README 里的安装示例与版本链接改用新地址，并记一句改名说明

## 为什么值得单独发一版

附件里的 `package.json` 与 `README.md` 是随包分发的：v0.5.0 的包内还写着旧仓库地址。虽然 GitHub
对旧地址做了 301，但把「包里写的就是现在的地址」这件事做对更省心。

功能无变化，不必特意升级；下次装新版时自然会拿到这份元数据。
