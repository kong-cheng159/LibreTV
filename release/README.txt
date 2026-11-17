桌面安装包输出目录

运行 npm run desktop:build 后，NSIS 安装包（*.exe）会复制到本目录。
原始产物仍在 src-tauri/target/release/bundle/nsis/。

不要改名为仓库根目录的 app/：Next.js 会把它当成 App Router，盖住 src/app，
导致桌面 standalone 缺少页面与 API，安装后无法启动。
