# LibreTV PC 版

本仓库是 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的 fork，在原有 **Next.js 15 影视聚合站** 之上，增加了 **Windows 桌面客户端**（Tauri v2 + Node.js Sidecar），并补齐一批接近 TVBox 体验的点播 / 直播能力。

> 上游 Web 版完整说明见仓库内 [`README.md`](./README.md) 与 [官方文档](https://libretv.is-an.org/wiki/)。  
> 本文件只描述 **本 fork 的定位、桌面端与增量功能**。

| 项 | 说明 |
| --- | --- |
| 仓库 | https://github.com/kong-cheng159/LibreTV |
| 上游 | https://github.com/LibreSpark/LibreTV |
| 版本 | 以 `package.json` 为准（当前 2.23.2） |
| 桌面端一期 | Windows x64 NSIS 安装包 |
| 安装包输出 | 仓库根目录 `release/`（**不要**放到 `app/`） |

---

## 这个 fork 多了什么

### 桌面壳

- Tauri v2 窗口 + 系统 WebView2
- 内置 Node.js sidecar 跑 Next.js standalone，仅监听 `127.0.0.1:47321`
- 本机免密启动（一次性 bootstrap 令牌签发会话）
- 单实例；外链用系统浏览器打开
- 安装包体积大约 90–140 MB（主要是 `node.exe` + standalone）

### 点播体验

- 分类浏览（按源 / 分类拉取 Apple CMS 目录，可搜索、粘性筛选、分页）
- 追剧 / 收藏、观看历史独立页面
- 播放失败自动换源，集名 / 集数尽量对齐
- 播放器：亮度 / 音量 / 进度手势、画面比例、画中画、定时关闭、清晰度手选
- 连播倒计时、进度条命中区优化
- 整季 / 多集下载管理

### 直播体验

- 数字键换台、恢复上次频道
- 继续沿用上游的 M3U / EPG / 收藏能力

### 源管理

- 订阅 LibreTV-SourceList JSON、TVBOX 配置、接口目录
- **本地 JSON 文件直接导入**（导入的是源列表，不是 CMS 搜索接口返回）
- 成人内容过滤、源测活、健康度自动停用

Web 部署方式（Docker / standalone / 环境变量）与上游一致，细节请看 [`README.md`](./README.md)。

---

## 桌面端：安装使用

1. 安装 [WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（多数 Win10/11 已自带）
2. 运行 `release/LibreTV_<版本>_x64-setup.exe`（当前用户安装）
3. 启动后短暂停留启动页 → 自动进入本机站点（免输密码）

若启动失败：

- 确认安装的是修复后的包（路由清单含 `/api/status`）
- 不要把安装包目录命名为项目根下的 `app/` 再去打包（Next 会误把它当成 App Router，导致 API 全 404）
- 查看本机日志：`%APPDATA%\com.libretv.desktop\`（配置与启动相关信息）
- 端口 `47321` 被占用时会启动失败，请释放端口后重试

---

## 桌面端：开发与打包

### 环境

- Node.js 18+
- Rust / Visual Studio C++ 构建工具（Tauri 需要）
- Windows x64

### 命令

```bash
npm install

# 桌面开发（拉起 next dev + Tauri 窗口，端口 18080）
npm run desktop:dev

# 仅准备 sidecar（standalone + node.exe，并校验路由清单）
npm run desktop:prepare

# 打完整安装包 → 输出到 release/
npm run desktop:build
```

### 架构简述

```
LibreTV.exe
  └─ node.exe  →  standalone/server.js  (127.0.0.1:47321)
       └─ WebView 打开 /api/desktop-bootstrap → 写入会话 → /
```

关键目录：

```
scripts/           # desktop-dev / prepare-sidecar / desktop-build
src-tauri/         # Tauri 壳、图标、sidecar 资源
release/           # 安装包输出（勿改名为根目录 app/）
src/app/browse/    # 分类浏览
src/app/downloads/ # 下载管理
src/app/history/   # 历史
src/app/settings/  # 设置
```

更细的设计说明见：[`LibreTV PC端改造完整技术实现方案（Tauri v2 + Node.js Sidecar）.md`](./LibreTV%20PC端改造完整技术实现方案（Tauri%20v2%20+%20Node.js%20Sidecar）.md)

---

## Web 开发（与上游相同）

```bash
npm install
PASSWORD=dev-password npm run dev    # http://localhost:8080
npm test
npm run typecheck
```

Docker / 环境变量 / 订阅 JSON 格式等仍以 [`README.md`](./README.md) 为准。

---

## 与上游的关系

| | 说明 |
| --- | --- |
| `origin` | 本 fork：`kong-cheng159/LibreTV` |
| `upstream` | 源仓库：`LibreSpark/LibreTV` |
| 同步 | `git fetch upstream` 后按需合并 `upstream/main` |
| 推送 | 推到 `origin`，不要默认推上游 |

本 fork **不替代** 上游官方镜像与文档站点；桌面安装包与 PC 增量功能以本仓库 Releases / `release/` 为准。

---

## 免责声明

本项目不存储、不制作任何视频内容，仅提供第三方公开接口的聚合与播放能力。内容合法性由对应数据源负责。请勿将本软件用于传播违法违规内容。
