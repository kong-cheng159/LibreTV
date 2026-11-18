# LibreTV PC 优先、三端演进完整落地方案

> 实施状态更新：2026-11-18  
> 标记说明：✅ 已完成；🟡 部分完成；⬜ 待实施。

## 当前实施进度

| 里程碑 | 状态 | 已落地范围 |
| --- | --- | --- |
| 本地字幕 | 🟡 部分完成 | 支持选择 `SRT`、`ASS`、`SSA`、`VTT`；UTF-8 解码及 GB18030 回退；SRT/ASS/SSA 转 WebVTT；旧字幕资源清理 |
| HLS 多音轨 | 🟡 部分完成 | 监听 HLS 音轨更新，并在播放器设置中提供动态音轨切换 |
| 播放截图 | 🟡 部分完成 | 已启用 ArtPlayer 截图按钮 |
| 无痕模式 | ✅ 已完成 | 设置持久化、顶栏状态提示，并阻止历史、进度、搜索、直播最近观看和追剧行为写入 |
| 播放诊断 | ✅ 已完成 | 播放信息、错误分类、恢复入口、源健康、帧率/码率、系统播放器及脱敏诊断复制均已落地 |
| 本地媒体 | 🟡 部分完成 | 已支持文件/文件夹选择、拖放、临时播放列表、对象 URL 原生播放、自动/手动字幕、文件指纹进度及兼容错误提示 |
| 下载中心增强 | 🟡 部分完成 | 已增加下载字节、速度、预计剩余时间、开始/完成时间、输出位置和详细失败原因 |

当前实现已通过 TypeScript、ESLint、50 个测试文件共 671 项 Vitest 测试，以及 Rust/Tauri `cargo check`。最近一次 Next.js 生产构建基线已通过；本轮为避免覆盖正在运行的开发服务热更新缓存，没有重复执行生产构建。ESLint 仍有 5 条既有警告，无错误。

## 1. 项目目标

LibreTV 先发展为成熟的 Windows PC 影音客户端，再逐步扩展为家庭局域网影音中心，最终形成 PC、手机、电视三端统一产品。

总体原则：

- 保留现有 Next.js、Tauri、Node Sidecar 架构。
- 先完善播放体验，不立即重写原生客户端。
- 新功能采用适配器接口，避免绑定单一第三方服务。
- 现有纯本地、自托管和隐私优先模式继续可用。
- 不内置影视源、字幕源、弹幕源或网盘凭据。
- 暂不执行任意 TVBox Spider 代码。

## 2. 现状与能力缺口

### 2.1 已有能力

- Apple CMS 多源搜索、分类浏览和跨源聚合。
- 搜索流式返回、源测速、健康度记录和自动停用。
- HLS、HTTP-FLV、广告分片过滤和播放失败恢复。
- 自动换源、集数匹配、清晰度探测。
- 片头、中段、片尾标记及自动跳过。
- 播放进度、历史、追剧和直播收藏。
- M3U、XMLTV EPG、直播测活。
- 多集下载、断点缓存和桌面流式落盘。
- TVBox 配置、LibreTV 源列表和接口目录订阅。
- Tauri Windows 客户端和应用内更新。

### 2.2 主要缺口

- 外挂字幕、内嵌字幕和多音轨管理。
- 弹幕生态。
- 播放技术信息和问题诊断。
- 本地视频与家庭媒体库。
- DLNA 投放和手机遥控。
- 多设备进度同步。
- 多用户及儿童模式。
- 完整电视遥控焦点系统。
- WebDAV、Emby、Jellyfin 等媒体服务接入。

## 3. 总体技术架构

```text
                         LibreTV Core
 ┌────────────────────────────────────────────────────┐
 │ 搜索 │ 详情 │ 播放会话 │ 历史 │ 收藏 │ 下载 │ 设置 │
 └────────────────────────────────────────────────────┘
             │                │               │
       Content Adapter   Playback Adapter   Sync Adapter
             │                │               │
      CMS / Media Lib    HLS / Local File   Local / Server
             │                │               │
 ┌───────────┴────────────────┴───────────────┴───────────┐
 │                  平台能力适配层                         │
 │ Web/PWA │ Tauri Windows │ Mobile Layout │ TV Layout   │
 └────────────────────────────────────────────────────────┘
```

新增功能不得直接散落在页面中，应分别进入：

- 内容与媒体库适配层。
- 播放扩展层。
- 设备互联层。
- 同步层。
- 平台能力层。

## 4. 第一阶段：PC 播放器完善版

建议版本周期：V2.24 ～ V2.26。

### 4.1 字幕系统

**状态：🟡 部分完成。** 本地字幕选择、基础编码兼容和 WebVTT 转换已落地；HLS 内嵌字幕、偏移、样式、跨集偏好及拖放仍待实施。

#### 支持范围

- ⬜ HLS `EXT-X-MEDIA` 内嵌字幕。
- ✅ 本地 `SRT`、`ASS`、`SSA`、`VTT` 文件选择与加载。
- 🟡 UTF-8、UTF-16、GBK 编码识别：已支持 UTF-8 与 GB18030 回退，UTF-16 待补充。
- 🟡 字幕开关和轨道切换：已完成本地字幕轨道挂载，完整多轨管理待补充。
- ⬜ 时间偏移，支持正负调整。
- ⬜ 字号、颜色、描边、背景、位置设置。
- ⬜ 当前影片字幕设置跨集保持。
- ⬜ 字幕文件拖放到播放器加载。

#### 数据结构

```ts
interface SubtitleTrack {
  id: string;
  label: string;
  language?: string;
  format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'hls';
  source: 'embedded' | 'local' | 'provider';
  url?: string;
  content?: string;
}

interface SubtitlePreference {
  enabled: boolean;
  trackId?: string;
  offsetMs: number;
  fontSize: number;
  color: string;
  outline: boolean;
  position: number;
}
```

按标准化影片标识保存偏好，不保存本地字幕文件内容；刷新后本地文件需要重新选择。

#### 扩展接口

```ts
interface SubtitleProvider {
  id: string;
  name: string;
  search(input: SubtitleSearchInput, signal: AbortSignal): Promise<SubtitleCandidate[]>;
  load(candidate: SubtitleCandidate, signal: AbortSignal): Promise<SubtitleTrack>;
}
```

首个版本只实现本地和内嵌字幕，在线提供器作为插件接口预留。

### 4.2 多音轨

**状态：🟡 部分完成。** 已完成 HLS 音轨发现和基础切换，偏好记忆、失败恢复和更完整的轨道信息仍待实施。

- ✅ 从 HLS 音轨更新事件获取音频轨道。
- 🟡 展示语言、名称和默认轨道：已提供动态音轨选项，信息展示仍可完善。
- ✅ 切换时不中断播放进度。
- ⬜ 同一影片跨集沿用音轨语言偏好。
- ✅ 不存在偏好语言时使用默认轨道。
- ⬜ 音轨切换失败时恢复原轨道并提示。

### 4.3 弹幕系统

#### 提供器接口

```ts
interface DanmakuProvider {
  id: string;
  name: string;
  search(input: DanmakuSearchInput, signal: AbortSignal): Promise<DanmakuCandidate[]>;
  load(candidate: DanmakuCandidate, signal: AbortSignal): Promise<DanmakuItem[]>;
}
```

#### 功能

- 根据标题、年份、季度、集数匹配弹幕。
- 用户确认匹配结果，不自动采用低置信结果。
- 支持滚动、顶部和底部弹幕。
- 设置透明度、字号、速度、密度和显示区域。
- 支持关键词和用户屏蔽。
- 支持时间轴偏移。
- 按影片及集数缓存弹幕。
- 弹幕不可用时不影响正常播放。

#### 安全边界

- 不在核心代码中写死非官方接口。
- 提供器必须声明访问域名。
- 请求经过服务端代理和 SSRF 校验。
- 缓存只保存弹幕文本及时间，不保存登录凭据。

### 4.4 播放诊断

**状态：✅ 已完成。** 已提供实际播放地址、直连/代理、协议、分辨率、帧率、码率、音视频编码、HLS 档位、缓冲、带宽估算、丢帧、解码错误、源健康、最近错误和恢复动作；支持重试、代理重试、自动换源、换源面板、系统播放器及脱敏诊断复制。

播放器增加“播放信息”面板：

- ✅ 当前播放地址的域名和协议。
- ✅ 直连或代理状态。
- ✅ 视频编码、音频编码。
- ✅ 当前分辨率、实时帧率和 HLS 声明媒体码率。
- ✅ 缓冲时长和实时下载速度估算。
- ✅ 当前 HLS 清晰度层级。
- ✅ 丢帧和解码错误数量。
- ✅ 最近一次恢复操作。
- ✅ 当前源健康状态。

增加错误分类：

```ts
type PlaybackFailureStage =
  | 'manifest'
  | 'key'
  | 'segment'
  | 'network'
  | 'cors'
  | 'decode'
  | 'codec'
  | 'timeout'
  | 'unknown';
```

错误面板提供：

- ✅ 重试当前线路。
- ✅ 经代理重试。
- ✅ 自动换源。
- ✅ 打开换源面板。
- ✅ 复制诊断信息。
- ✅ 复制原始播放地址（用户主动操作，用于外部播放器或排查）。
- ✅ 使用系统播放器打开（Windows 桌面客户端）。

复制完整诊断信息时会移除 Token、签名、密钥、密码、会话标识等敏感查询参数；单独复制播放地址属于用户明确操作，保留完整可播放参数。

桌面系统播放器安全边界：

- 仅在 Tauri Windows 客户端中启用。
- Rust 命令只接受 `HTTP` 和 `HTTPS` 地址。
- 拒绝本地文件路径、自定义协议和其他可执行形式。
- 交给 Windows 默认协议关联程序处理，不在前端拼接系统命令。

### 4.5 截图和系统播放器

**状态：🟡 部分完成。** 已启用播放器截图入口和 Windows 系统播放器打开能力；截图保存、命名与跨域错误提示仍待实施。

- ✅ 启用播放器截图按钮。
- 🟡 默认保存为 PNG：当前沿用 ArtPlayer 默认截图行为。
- ⬜ 文件名包含影片名、集数和时间点。
- ⬜ 桌面端使用系统保存对话框。
- 🟡 Web 端使用浏览器下载：当前沿用 ArtPlayer 默认行为，待补充定制。
- ⬜ 跨域视频无法截图时显示明确原因。
- ✅ 支持将当前播放地址交给系统默认播放器（Windows 桌面客户端）。
- ⬜ 后续可增加自定义播放器路径，不进入首版。

### 4.6 本地媒体

**状态：🟡 部分完成。** 已完成浏览器本地文件播放主流程；桌面端完整目录扫描、更多容器兼容和更完善的本地字幕管理仍待补充。

新增“本地媒体”页面：

- ✅ 选择单个或多个视频文件。
- ✅ 拖放视频到页面。
- ✅ 选择文件夹并生成临时播放列表（基于浏览器目录选择能力）。
- ✅ 支持常见浏览器可解码格式；不承诺浏览器原生不支持的容器和编码。
- ✅ 使用对象 URL 播放，不把完整文件复制到 JavaScript 内存。
- ✅ 自动查找同目录同名字幕，并兼容“视频名.语言.srt”命名。
- ✅ 支持手动选择、切换和清除 `SRT`、`ASS`、`SSA`、`VTT` 字幕。
- ✅ 播放进度以文件指纹保存；隐私模式下不写入。
- ✅ 本地媒体不参与远程换源和内容搜索。
- ✅ 支持上一项、下一项、播放完成自动续播和从临时列表移除。
- ✅ 容器或编码不受浏览器支持时给出明确兼容提示。

文件指纹由以下字段组成：

```text
文件名 + 文件大小 + 最后修改时间
```

本地文件路径不得写入普通配置导出。

### 4.7 下载中心增强

**状态：🟡 部分完成。** 运行统计和失败信息已落地；默认目录、完成后打开文件/目录、磁盘预检及仅重试失败分片仍待实施。

在现有影片分组下载中心上增加：

- ✅ 当前速度。
- ✅ 已下载字节及估算总大小。
- ✅ 预计剩余时间。
- ✅ 开始时间和完成时间。
- ⬜ 默认下载目录。
- ⬜ 完成后打开文件。
- ⬜ 打开所在目录。
- 同名文件处理策略。
- 🟡 磁盘空间不足提示：缓存配额不足已有明确提示，桌面磁盘剩余空间预检待补充。
- 🟡 下载失败原因与失败分片：详细失败原因和分片编号已展示，失败分片结构化记录待补充。
- ⬜ 仅重试失败分片。

扩展任务字段：

```ts
interface DownloadRuntimeStats {
  downloadedBytes: number;
  totalBytes?: number;
  bytesPerSecond: number;
  estimatedSeconds?: number;
  startedAt?: number;
  completedAt?: number;
  outputPath?: string;
}
```

旧任务字段缺失时按未知值展示，不要求清空 IndexedDB。

### 4.8 追剧更新

- 保存上次已知总集数。
- 打开应用或刷新详情时比较新总集数。
- 显示新增集数角标。
- 增加“最近更新”区域。
- 支持标记已读。
- 记录最近观看集和最新可用集。
- 不在后台高频抓取全部源，只检测用户追剧条目。
- 同一影片优先使用最近成功源，失败后再换源查询。

### 4.9 无痕模式

**状态：✅ 已完成。** 设置已持久化，顶栏持续提示状态，既有数据保留不删除。

新增全局设置：

```ts
privacyMode: boolean;
```

开启后：

- ✅ 不写观看历史。
- ✅ 不写播放进度。
- ✅ 不写搜索历史。
- ✅ 不更新最近直播。
- ✅ 不写追剧行为。
- ✅ 不影响源健康度和必要运行缓存。
- ✅ 已存在的数据不会自动删除。

界面持续显示无痕状态，避免用户误以为正在保存进度。

## 5. 第二阶段：家庭互联版

建议版本周期：V2.27 ～ V2.30。

### 5.1 同步服务

同步服务是可选组件，未配置时继续使用本地模式。

#### 部署形态

- 与现有 Node Sidecar/Next 服务共同运行。
- SQLite 保存同步数据。
- 单用户部署无需 Redis。
- Web 部署和桌面端使用同一协议。

#### 同步对象

- 设置。
- 源和订阅。
- 追剧。
- 历史。
- 播放进度。
- 跳过标记。
- 直播收藏。
- Profile。

不同步：

- 下载文件。
- 视频缓存。
- 本地文件路径。
- 明文密码。
- 临时字幕文件。
- 弹幕缓存。

#### 增量协议

```ts
interface SyncRecord<T> {
  id: string;
  type: SyncEntityType;
  value?: T;
  updatedAt: number;
  deviceId: string;
  deletedAt?: number;
  revision: number;
}
```

接口：

```text
POST   /api/sync/pair
POST   /api/sync/push
GET    /api/sync/pull?cursor=...
POST   /api/sync/resolve
DELETE /api/sync/device/:id
```

#### 冲突规则

- 播放进度：更新时间新者胜出。
- 历史：同影片合并并保留较新的观看位置。
- 收藏和追剧：按条目集合合并。
- 删除：使用墓碑，至少保留 30 天。
- 设置：按字段更新时间合并。
- 源配置：冲突时保留两个版本，交由用户选择。
- 跳过标记：同一剧发生冲突时保留最新版本及旧版本备份。

### 5.2 设备配对

- 服务端生成一次性短 PIN 和二维码。
- PIN 有效期 5 分钟。
- 新设备必须在已授权设备上确认。
- 配对后签发设备令牌。
- 令牌只显示一次并存储于安全区域。
- 支持设备列表、重命名和撤销。
- 桌面端令牌存储在 Tauri 安全存储。
- Web 端存储为 HttpOnly 会话。

### 5.3 手机网页遥控

新增 `/remote` 页面：

- 扫码连接当前播放设备。
- 播放、暂停、快进、快退。
- 音量、倍速、字幕和弹幕控制。
- 选集和换源。
- 搜索并发送影片。
- 直播频道切换。
- 查看当前播放信息。

控制通道使用 WebSocket：

```ts
interface RemoteCommand {
  id: string;
  deviceId: string;
  type: RemoteCommandType;
  payload?: unknown;
  timestamp: number;
}
```

安全要求：

- 默认仅允许局域网。
- 首次连接需主设备确认。
- 连接空闲 30 分钟失效。
- 所有命令校验设备令牌。
- 禁止远程修改管理员密码及代理配置。

### 5.4 DLNA 投放

- 搜索局域网 MediaRenderer。
- 支持投放、暂停、恢复、跳转、停止和音量。
- 为需要代理或鉴权的媒体生成临时签名地址。
- 签名地址绑定设备 IP、资源和过期时间。
- 默认有效期 4 小时，播放活跃时续期。
- 不直接暴露真实上游 Cookie 和鉴权头。
- 设备不支持目标编码时提前提示。

接口：

```ts
interface CastSession {
  discover(): Promise<CastDevice[]>;
  connect(deviceId: string): Promise<void>;
  load(media: CastMedia): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  stop(): Promise<void>;
}
```

### 5.5 Profile 与儿童模式

Profile 独立数据：

- 历史。
- 进度。
- 追剧。
- 推荐偏好。
- 直播收藏。
- 内容过滤。

儿童模式：

- Profile PIN。
- 允许源白名单。
- 限制分类和搜索关键词。
- 禁止打开设置、源管理和外部链接。
- 禁止查看成人源。
- 可选每日播放时长。
- 不构建复杂互联网账号体系。

## 6. 第三阶段：三端和媒体库版

建议版本周期：V2.31 以后。

### 6.1 统一平台能力

```ts
interface DeviceCapabilities {
  platform: 'web' | 'windows' | 'mobile' | 'tv';
  touch: boolean;
  dpad: boolean;
  filesystem: boolean;
  secureStorage: boolean;
  backgroundPlayback: boolean;
  cast: boolean;
}
```

功能通过能力判断展示，不在组件中直接判断 User-Agent。

### 6.2 电视交互

- 建立空间焦点导航系统。
- 支持方向键、确认、返回、菜单、长按和数字键。
- 记忆每个页面离开前的焦点。
- 弹窗打开时锁定焦点范围。
- 返回键优先关闭弹层，再返回页面。
- 列表虚拟化后仍能恢复焦点。
- 独立电视布局，不直接放大 PC 页面。
- 支持低性能模式和关闭动画。
- 首屏遥控可操作时间作为性能指标。

### 6.3 手机布局

- 底部导航替代 PC 侧边栏。
- 播放页优先横屏。
- 手势控制与系统返回行为统一。
- 下载任务适配移动存储权限。
- 遥控器入口和扫码入口放在首页。
- 保留 PWA 安装能力。

### 6.4 媒体库适配器

```ts
interface MediaLibraryAdapter {
  id: string;
  name: string;
  authenticate(config: LibraryConfig): Promise<void>;
  browse(input: BrowseInput, signal: AbortSignal): Promise<MediaPage>;
  search(query: string, signal: AbortSignal): Promise<MediaItem[]>;
  detail(id: string, signal: AbortSignal): Promise<MediaDetail>;
  playback(id: string, options: PlaybackOptions): Promise<PlaybackSource>;
  updateProgress(input: MediaProgress): Promise<void>;
}
```

适配顺序：

1. WebDAV。
2. 本地/LAN 目录。
3. Jellyfin。
4. Emby。
5. Plex。

统一媒体模型：

```ts
interface MediaItem {
  id: string;
  libraryId: string;
  type: 'movie' | 'series' | 'season' | 'episode' | 'folder' | 'file';
  title: string;
  poster?: string;
  backdrop?: string;
  year?: number;
  duration?: number;
  progress?: number;
}
```

### 6.5 WebDAV

- Basic、Digest 或令牌认证按服务能力适配。
- 目录浏览、搜索和分页。
- 支持视频与字幕文件关联。
- 凭据进入安全存储。
- 不在日志和导出文件中输出密码。
- 大目录使用增量加载和缓存。
- 支持直连及服务端代理两种播放方式。

### 6.6 Jellyfin 与 Emby

- 使用服务器原始元数据和海报。
- 支持继续观看、收藏和播放进度回写。
- 优先直播放，必要时提示服务端转码。
- LibreTV 首版不自行实现转码服务器。
- 外部字幕和多音轨映射到统一播放器接口。
- 服务端不可用时显示最近缓存的媒体信息。

## 7. TVBox 生态兼容策略

### 7.1 继续支持

- TVBox JSON 站点列表。
- 多仓目录。
- 站点分组。
- M3U 及常见直播 TXT 格式。
- 安全的名称、图标、分类和推荐配置。
- 可直接访问的标准 CMS 接口。

### 7.2 暂不支持

- 任意 Java Spider。
- 未隔离的 QuickJS/Python 脚本。
- 远程配置直接执行本地命令。
- 任意本地文件访问。
- 未声明域名的插件网络请求。
- 远程动态修改应用权限。

### 7.3 后续插件沙箱要求

若以后实现插件系统，必须具备：

- 独立进程。
- 权限清单。
- 域名白名单。
- CPU、内存和执行时间限制。
- 文件系统隔离。
- 插件签名和版本锁定。
- 用户明确授权。
- 一键禁用及安全模式启动。

## 8. 数据迁移

每次新增持久化字段都提升 Zustand 或 Dexie 版本。

迁移要求：

- 旧字段缺失时补默认值。
- 不清空已有历史、源、收藏或下载任务。
- 新媒体库和 Profile 使用独立表。
- 大型缓存数据不进入配置导出。
- 配置导出格式增加版本号及能力声明。
- 导入高版本配置时忽略未知字段并提示兼容性。
- 每次迁移提供旧版本快照测试。

建议新增数据表：

```text
profiles
devices
syncRecords
subtitlePreferences
danmakuCache
localMedia
mediaLibraries
mediaProgress
watchlistUpdates
```

## 9. 安全和隐私

- 所有远程媒体、字幕、弹幕和媒体库地址经过 SSRF 校验。
- 凭据不进入 URL、日志、错误提示和普通配置导出。
- 局域网遥控默认关闭，用户主动开启。
- 投屏签名地址短期有效并绑定资源。
- 在线字幕和弹幕提供器可单独禁用。
- 无痕模式不得产生历史类持久化数据。
- 儿童 Profile 不能退出到管理员环境而无需 PIN。
- TVBox 配置仅作为数据解析，不视为可信代码。

## 10. 测试与验收

### 10.1 V1 验收

- 🟡 本地及内嵌字幕可加载、切换和调整偏移：本地字幕基础加载已完成，其余待实施。
- 🟡 音轨切换跨集保持：基础切换已完成，跨集偏好待实施。
- 弹幕失败不影响视频播放。
- ✅ 诊断面板能区分清单、密钥、网络、分片、CORS、解码、编码和超时问题。
- 本地大文件播放不复制完整文件到 JavaScript 内存。
- 下载速度和剩余时间稳定更新。
- ✅ 无痕模式不写历史、进度和搜索记录，并同时阻止直播最近观看与追剧写入。
- 🟡 PC 端生产构建和安装包通过：Next.js 生产构建已通过，Windows 安装包仍待本阶段发布验收。

### 10.2 V2 验收

- 两台设备可以配对并同步播放进度。
- 离线设备重新上线后正确合并数据。
- 删除数据不会被旧设备重新恢复。
- 手机遥控断线可以重连。
- 未配对设备无法发送控制命令。
- DLNA 设备能完成投放、暂停、跳转和停止。
- Profile 数据互相隔离。
- 儿童模式无法访问受限设置。

### 10.3 V3 验收

- 遥控器可以覆盖电视端全部核心流程。
- 页面不存在焦点陷阱和焦点丢失。
- WebDAV 大目录可以分页浏览。
- Jellyfin/Emby 进度能够双向同步。
- PC、手机、电视使用相同影片标识和播放进度。
- 低性能电视可以关闭动画和预加载。
- 旧配置升级不丢数据。

所有阶段统一执行：

- TypeScript 检查。
- ESLint。
- Vitest。
- Next.js 生产构建。
- Windows Tauri 安装包构建。
- 数据迁移回归。
- 播放器长时间稳定性测试。

## 11. 发布策略

每项大功能通过独立开关逐步开放：

```ts
interface FeatureFlags {
  subtitles: boolean;
  danmaku: boolean;
  localMedia: boolean;
  playbackDiagnostics: boolean;
  sync: boolean;
  remoteControl: boolean;
  dlna: boolean;
  profiles: boolean;
  mediaLibraries: boolean;
  tvLayout: boolean;
}
```

发布流程：

1. 开发环境默认开启。
2. 内部测试版本开放。
3. 稳定版本默认关闭实验性能力。
4. 数据格式和接口稳定后默认开启。
5. 出现严重问题时可关闭功能而不回滚数据库。

## 12. 交付优先级

| 优先级 | 功能 | 用户价值 | 实施风险 |
| --- | --- | ---: | ---: |
| P0 | 字幕与多音轨（🟡 部分完成） | 高 | 中 |
| P0 | 播放诊断（✅ 已完成） | 高 | 低 |
| P0 | 本地媒体 | 高 | 中 |
| P0 | 下载信息增强 | 高 | 低 |
| P1 | 追剧更新 | 高 | 中 |
| P1 | 无痕模式（✅ 已完成） | 中 | 低 |
| P1 | 弹幕提供器 | 高 | 中 |
| P2 | 同步服务 | 高 | 高 |
| P2 | 手机遥控 | 高 | 中 |
| P2 | DLNA | 高 | 高 |
| P2 | Profile/儿童模式 | 中 | 中 |
| P3 | WebDAV | 高 | 中 |
| P3 | Jellyfin/Emby | 高 | 高 |
| P3 | 电视焦点系统 | 高 | 高 |
| P4 | 安全插件沙箱 | 中 | 极高 |

## 13. 默认决策

- 第一阶段只面向 Windows PC 体验。
- 字幕先实现本地及 HLS 内嵌字幕。
- 弹幕采用提供器接口，不绑定固定服务。
- 同步服务默认关闭且完全可选。
- DLNA 作为首个投屏协议。
- 媒体库先做 WebDAV，再做 Jellyfin/Emby。
- 电视端先复用核心业务层，单独实现电视布局。
- 三阶段内不执行任意 TVBox Spider 代码。
- 新增能力不得破坏现有纯本地使用方式。
