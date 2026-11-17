Tauri 应用内更新签名密钥

- libretv.key      私钥：仅本机 / CI Secret，禁止提交 Git
- libretv.key.pub  公钥：内容已写入 tauri.conf.json → plugins.updater.pubkey

本地打包并生成 .sig：

  set TAURI_SIGNING_PRIVATE_KEY_PATH=src-tauri\keys\libretv.key
  npm run desktop:build

CI 请把私钥全文放进 Secret：TAURI_SIGNING_PRIVATE_KEY
（可选）TAURI_SIGNING_PRIVATE_KEY_PASSWORD

发布到 GitHub Release 时需附带：
  - LibreTV_*_x64-setup.exe
  - 对应的 .sig
  - latest.json（可用 tauri-action 的 includeUpdaterJson / updaterJsonPreferNsis）

latest.json 示例见仓库 scripts/updater-latest.example.json
