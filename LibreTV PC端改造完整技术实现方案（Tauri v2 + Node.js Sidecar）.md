# LibreTV PC 端方案（Tauri v2 + Node.js Sidecar，修正版）

本文件替换原稿。下面的约定与仓库里的实现一致，按阶段落地。第一期只做 **Windows x64** 的 NSIS 安装包。

## 1. 目标与边界

LibreTV 的搜索、详情、防盗链代理、直播长连接都在 Next.js Route Handler 里。桌面版不把站点导出成纯静态页，而是：

- 窗口使用系统 WebView2（Tauri v2）
- 旁边用官方 Node.js 22 跑现有的 Next.js standalone 服务
- 服务只监听 `127.0.0.1`
- 现有 Docker / `npm run dev` / `npm start` 行为保持不变

第一期不做：macOS / Linux 安装包、自动更新、代码签名、托盘、窗口置顶、拦截 F5。

安装包压缩后大约 90–140 MB。体积主要来自 `node.exe`（约 80 MB）和 standalone，不是 30–50 MB。不对 `node.exe` 做 UPX 压缩。

## 2. 运行方式

```
LibreTV.exe（单实例）
    │
    ├─ 开发：连接已启动的 next dev（127.0.0.1:18080）
    └─ 安装包：拉起 sidecar node.exe
                 cwd = standalone 目录
                 监听 127.0.0.1:47321
    │
    ▼
隐藏窗口先显示启动页，探活 GET /api/status
    │
    ▼
打开 http://127.0.0.1:<端口>/api/desktop-bootstrap?t=<一次性令牌>
    │  校验通过后写入真正的 ltv_session，再跳回 /
    ▼
用户进入已登录的站点
```

退出时杀掉 sidecar。服务崩了或 30 秒内探活失败，停在启动页并写明日志路径，同时结束已经拉起的 Node 进程。

### 2.1 固定端口

端口固定为 **47321**，并用单实例锁。

IndexedDB、localStorage、会话 cookie 都按 `http://127.0.0.1:端口` 隔离。每次换端口，历史、源和进度都会对不上。`identifier` 不变只保证 WebView 配置目录还在，保不住换端口后的数据。

第二个进程不新开服务，只把已有窗口调到前台。47321 被别的程序占用时，启动页提示端口冲突，不再去绑 `127.0.0.1:0`。

### 2.2 免密登录

不新增 `middleware.ts`。Edge Middleware 不能使用现有的 `node:crypto` 会话签名。

现有会话 cookie 是 `ltv_session`，值是 `过期时间.HMAC`（见 `src/lib/auth.ts`）。不能把 `PASSWORD` 原文写进 cookie，也不能使用 `auth_session` 这个名字。

桌面版的做法：

1. 首次启动在本机配置里生成 `password` 与 `proxySecret`，之后一直复用。Windows 路径为 `%APPDATA%\com.libretv.desktop\config.json`。
2. 每次启动另生成一次性的 `DESKTOP_BOOT_TOKEN`，只放进 sidecar 的环境变量，不写进配置。
3. 窗口打开 `/api/desktop-bootstrap?t=<令牌>`。
4. 该接口仅在 `DESKTOP_MODE=1` 且令牌匹配时签发 `ltv_session` 并 307 到 `http://127.0.0.1:<PORT>/`。其他部署（Docker、普通 `npm start`）此接口返回 404。
5. Cookie：`httpOnly`、`SameSite=Lax`、`Secure=false`、`Path=/`。页面是 HTTP 回环地址。

开发模式使用固定口令，便于和 `next dev` 对齐：

| 变量 | 开发值 |
| --- | --- |
| `PORT` | `18080` |
| `DESKTOP_BOOT_TOKEN` | `dev-desktop` |
| `PASSWORD` | `dev-password` |
| `PROXY_SECRET` | `dev-desktop-proxy-secret` |

### 2.3 环境变量

sidecar 与开发服务器注入：

| 变量 | 值 |
| --- | --- |
| `HOSTNAME` | `127.0.0.1` |
| `NODE_ENV` | 安装包为 `production`；开发由 `next dev` 自己处理 |
| `DESKTOP_MODE` | `1` |
| `DESKTOP_BOOT_TOKEN` | 见上一节 |
| `PASSWORD` / `PROXY_SECRET` | 本机配置，或开发固定值 |
| `COOKIE_SECURE` | `false` |
| `LIVE_ALLOW_PRIVATE` | `1` |

`LIVE_ALLOW_PRIVATE=1` 已经会放行直播订阅、节目单、测活和直播流代理上的内网地址。点播搜索和 `/api/proxy` 仍然拒绝内网。不存在 `ALLOW_CONFIG_LOCAL_IP`，也不要放宽点播 SSRF。

工作目录必须是 standalone 根目录，参数只传相对路径 `server.js`。Windows 上 `resource_dir()` 会带 `\\?\` 前缀，这个前缀要去掉再交给 Node，否则脚本入口会被解析成 `C:`。

### 2.4 外链

http(s) 且主机不是 `127.0.0.1`、`localhost`、`::1` 或以 `.localhost` 结尾（含 Tauri 启动页 `tauri.localhost`）的跳转，用系统浏览器打开，WebView 留在本站。视频请求走 XHR / MSE，不受这次导航拦截影响。

### 2.5 配置导出

桌面壳通过 `save_text_file` 命令弹出系统「另存为」，用户自选路径后写入 JSON。浏览器环境优先 File System Access 选择器，否则回退为下载。

## 3. 目录

```
LibreTV/
├── scripts/
│   ├── desktop-shared.mjs        # 版本同步、Node 下载、资源拷贝
│   ├── prepare-sidecar.mjs       # 打安装包前：standalone + node.exe
│   ├── desktop-dev-server.mjs    # tauri dev 时启动 next dev
│   ├── desktop-build.mjs         # 先同步版本，再 tauri build
│   └── generate-app-icon.mjs
├── src/app/api/desktop-bootstrap/route.ts
├── src/lib/desktop-mode.ts
├── src-tauri/
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   ├── binaries/                 # node-x86_64-pc-windows-msvc.exe（不入库）
│   ├── resources/
│   │   ├── splash/index.html
│   │   └── standalone/           # 构建产物，不入库
│   ├── icons/
│   └── src/lib.rs
└── next.config.ts                # DESKTOP_BUILD=1 时才 output: 'standalone'
```

版本号只以根目录 `package.json` 为准。`desktop-build.mjs` 在调用 Tauri 之前把它写入 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml`。

`next.config.ts` 继续在非 Docker、非桌面打包时关闭 standalone，避免本地 `npm start` 失效，并保留 `APP_VERSION`。

## 4. 分阶段实施

### 阶段 A — Next 适配

- `DOCKER_BUILD=1` 或 `DESKTOP_BUILD=1` 时 `output: 'standalone'`
- `src/lib/desktop-mode.ts`：判断桌面模式、校验启动令牌（对 sha256 做恒定时间比较）
- `GET /api/desktop-bootstrap`：非桌面模式 404；令牌不对 403；通过则种 `ltv_session` 并跳转首页
- 单元测试覆盖令牌校验

### 阶段 B — 构建脚本

- sidecar 使用 Node.js **v22.23.5** 官方 Windows x64 单文件 `node.exe`，不复制 `process.execPath`（本机可能是 nvm 垫片，也可能是 Node 25）
- 下载地址：`https://nodejs.org/dist/v22.23.5/win-x64/node.exe`
- 落到 `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`，旁边写 `.version`，版本一致则跳过下载
- `prepare-sidecar.mjs` 用这份 Node 22 执行 `next build`（`DESKTOP_BUILD=1`），再把下列目录对齐：
  - `.next/standalone` → `src-tauri/resources/standalone`
  - `.next/static` → `src-tauri/resources/standalone/.next/static`
  - `public` → `src-tauri/resources/standalone/public`
- 开发命令不跑生产构建。`desktop:dev` 只保证 sidecar 文件存在（Tauri 编译要检查 externalBin），然后在 18080 起 `next dev`。不用 8080：这台 Windows 的保留端口段 8032–8131 含 8080，绑定会得到 EACCES

### 阶段 C — Tauri 宿主

`src-tauri/src/lib.rs` 按第 2 节的顺序执行：单实例、创建窗口、开发模式等待 18080、安装包模式检查 47321 并拉起 sidecar、最多 30 秒轮询 `/api/status`、导航到 bootstrap、退出时 `child.kill()`。

sidecar 日志追加到应用日志目录的 `sidecar.log`。

Tauri 配置要点：

- `identifier`：`com.libretv.desktop`（以后不能改，否则 WebView 数据目录换地方）
- `externalBin`：`binaries/node`；Rust 侧 `sidecar("node")`，运行时在 exe 同目录找 `node.exe`
- `resources`：`resources/standalone/` 映射为资源目录下的 `standalone/`
- `frontendDist`：`resources/splash`
- 安装包目标：NSIS，`currentUser`，WebView2 使用 `downloadBootstrapper`
- 能力文件允许 `shell:allow-spawn` 执行 `binaries/node`，参数不限

### 阶段 D — 安装包与验收

```bash
npm install
npm test
npm run desktop:dev      # 开发窗口
npm run desktop:build    # NSIS 安装包
```

安装包位置：根目录 `release/`（构建脚本从 `src-tauri/target/release/bundle/nsis/` 复制过来）。
不要使用根目录 `app/`，会与 Next.js 的 `src/app` 路由目录冲突。

验收时看这些路径：启动即进入主页且不出现登录框；关掉再开，源配置和历史还在；搜索、播放、直播页能打开；任务管理器里退出后没有残留的 sidecar `node.exe`；未设置 `DESKTOP_MODE` 时访问 `/api/desktop-bootstrap` 得到 404。

未签名安装包会被 SmartScreen 提示未知发布者。签名不在第一期。

许可证是 AGPL-3.0。把安装包发给别人时，对方有权索取对应源码。安装包版本与 git tag / `package.json` 对齐。

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| 一直停在「正在启动」 | 看 `%APPDATA%\com.libretv.desktop\logs\sidecar.log`（日志目录以 Tauri `app_log_dir` 为准）。确认 `resources/standalone/server.js` 已打进包，且 `.next/static` 已拷贝 |
| 有页面但没有样式 | standalone 里缺 `.next/static` 或 `public`。重新跑 `npm run desktop:prepare` |
| 每次打开都要重新登录或历史消失 | 端口被改成随机口。必须继续固定 47321，且 `identifier` 保持 `com.libretv.desktop` |
| 退出后仍有 `node.exe` | 确认走的是窗口关闭触发的 `RunEvent::ExitRequested` / `Exit`，并对 `CommandChild` 调用 `kill()` |
| 47321 被占用 | 结束占用该端口的进程后重开。单实例锁只能拦住第二个 LibreTV，拦不住无关进程 |
| 内网直播源失败 | 确认 sidecar 带了 `LIVE_ALLOW_PRIVATE=1`。点播源仍然必须是公网地址 |
| 开发窗口打不开 | 18080 无法监听。先停掉占用该端口的进程。网站版 `npm run dev` 仍使用 8080，那是另一个入口 |
