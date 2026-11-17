Next.js standalone 运行时占位目录

npm run desktop:prepare 会用构建产物替换此目录内容（server.js、.next、public 等），
再打进 Tauri 安装包。

standalone 产物勿提交到 Git，由本地 / CI 构建生成。
