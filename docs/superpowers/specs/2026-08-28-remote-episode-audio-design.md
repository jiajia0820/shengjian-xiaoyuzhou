# 通过小宇宙官方链接获取音频的设计规格

- 日期：2026-08-28
- 状态：已获用户确认，待实现
- 实现分支：`feature/remote-episode-audio`
- 基础分支：`feature/ai-transcript-cleanup`（包含两人声纹与 AI 文稿清理）

## 1. 目标与范围

当前按说话人分段面板要求用户选择本地音频文件。用户希望只粘贴或使用已经导入的小宇宙单集链接，由系统自动获取该单集的官方音频，不再提供本地文件选择。

本功能的目标是：

- 复用已保存单集的 `eid` 和小宇宙授权，从官方接口取得新鲜的音频地址；
- 让本机声纹服务直接流式下载官方音频并执行现有全自动/两人声纹识别；
- 保留现有 GPU 自动选择、10 分钟分块、取消、进度、2 小时/1GB 限制、预览修正和 Markdown 保存行为；
- 说话人保存后，继续在同一份当前文稿上执行“AI 清理文稿”，保留说话人标题和时间戳；
- 官方原稿、当前稿哈希保护、声纹 artifact 和 AI 清理撤销能力继续有效；
- 音频只保留在本机任务临时目录，任务完成、失败、取消或过期后按现有清理策略删除。

本期不做：

- 不把音频写入 R2、数据库或永久缓存；
- 不把官方音频转为新的转写稿；
- 不改变小宇宙登录、文稿导入和 AI 提供商配置流程；
- 不删除或改写旧的本地文件接口，以便已有客户端和回归测试继续可用，但前端不再暴露文件选择入口；
- 不绕过小宇宙访问控制。只能获取当前账号有权访问的单集，且遵守节目和音频的版权/服务条款。

## 2. 已确认的上游数据

小宇宙公开单集页面的结构化数据通常包含：

- `media.source.url`；
- `enclosure.url`；
- `media.id` 与 `media.mimeType`。

实测公开单集会返回类似 `https://media.xyzcdn.net/<key>.m4a` 的官方 CDN 地址。当前 `lib/xiaoyuzhou.ts` 只提取 `mediaId`，不保留音频 URL，因此需要在同一个已鉴权的单集查询中提取并验证音频字段。

音频字段提取顺序固定为：

1. `episode.media.source.url`；
2. `episode.media.url`；
3. `episode.enclosure.url`；
4. `episode.audioUrl`。

如果所有字段缺失、不是 HTTPS 或主机属于回环/私网地址，返回明确的 `NO_AUDIO` 或 `AUDIO_URL_INVALID`，不启动本地模型。

## 3. 方案比较与选择

### 方案 A：本机服务直连官方 CDN，本站提供短时中转回退（采用）

应用新增受保护的音频源接口。前端只提交 `eid`，应用使用当前小宇宙授权获取并校验官方地址；本机服务收到经过校验的源地址后，以流式方式下载到随机任务目录并处理。若 CDN 对本机请求拒绝、地址过期或网络策略不允许直连，则应用签发一个短时、一次性的音频中转地址，本机服务再请求该地址。

优点：大文件不经过浏览器内存，默认音频只在官方 CDN 与本机之间传输，保留了现有本地隐私边界；中转只作为兼容性回退。缺点是需要在本地服务增加远程下载、重定向和临时授权校验。

### 方案 B：本站始终下载并转发到本机服务

应用服务器用小宇宙授权下载完整音频，再把字节流转发给本机服务。

优点是最容易兼容需要鉴权或特殊 CDN 请求头的音频地址。缺点是大文件占用站点带宽和请求时长，部署在 Cloudflare Worker 时还可能受到响应体、超时或费用限制，与“不让音频经过云端”的既有隐私目标冲突，因此只保留为回退路径，不作为默认路径。

### 方案 C：浏览器直接获取音频后上传本机服务

浏览器用 `fetch` 下载官方 URL，再组装成 `File` 上传。

优点是后端改动最少。缺点是 CDN CORS、跨源私网请求、1GB 文件内存和浏览器网络中断都会造成不稳定，无法满足长音频日常使用，不采用。

## 4. 总体数据流

```text
已导入的小宇宙单集
        │ eid
        ▼
GET /api/episodes/:eid/audio-source（鉴权、刷新 token、解析官方音频 URL）
        │ 官方 HTTPS URL + 时长/MIME + 短时回退地址
        ▼
本机声纹服务 POST /jobs（sourceUrl 或 relayUrl、模式、参考区间）
        │ 流式下载到随机临时目录，ffprobe 校验，GPU/分块推理
        ▼
匿名说话人时间区间
        │ 现有 preview / save API
        ▼
带说话人标题和时间戳的 current.md
        │ 现有 AI 清理按钮
        ▼
清理后的 current.md（可撤销）
```

### 4.1 获取音频源

新增 `GET /api/episodes/[eid]/audio-source`：

1. `requireApiUser` 并确认 `eid` 属于当前用户；
2. `withFreshTokens` 调用 `getOfficialEpisode`；
3. 从受限字段顺序提取 `audioUrl`、`audioMimeType` 和时长；
4. 校验 URL 必须为 HTTPS，拒绝回环、私网、非绝对 URL 和明显的非音频 MIME；
5. 生成短时中转授权（仅绑定当前用户、`eid`、随机 nonce 和过期时间），返回：

```json
{
  "audioUrl": "https://media.xyzcdn.net/…m4a",
  "relayUrl": "/api/episodes/<eid>/audio-relay?ticket=…",
  "mimeType": "audio/mp4",
  "durationSeconds": 3352,
  "expiresAt": "2026-08-28T…Z"
}
```

`audioUrl` 只作为本次本机任务的临时输入，不写入数据库或 Markdown。若小宇宙没有音频 URL，接口返回 404 `NO_AUDIO`，前端说明“该单集没有可用官方音频”。

### 4.2 官方音频中转

新增 `GET /api/episodes/[eid]/audio-relay`：

- 只接受音频源接口签发的短时 ticket；ticket 一次性消费并绑定用户和 `eid`；
- 服务端重新取得/验证官方 URL，不接受客户端提交任意目标 URL；
- 以流式响应转发官方音频，透传安全的 `Content-Type`、`Content-Length`（若可靠）和 `Accept-Ranges`；
- 不把完整响应缓存在 R2 或数据库；
- 上游非 2xx、超时、超过 1GB 或内容类型明显不符时返回不包含 token 的错误；
- relay URL 过期或已使用时返回 410，前端重新请求音频源后重试。

如果部署环境不适合长时间中转，接口明确返回 `AUDIO_RELAY_UNAVAILABLE`，前端显示“官方音频无法由当前网络直接获取”，不伪造本地任务成功。

#### 开发代理的流式约束

开发环境的上游代理也必须支持官方媒体流式转发：识别到官方音频 CDN 目标后，响应体按固定块直接写给客户端，只透传安全的媒体响应头，并在累计超过 1GB 时中止。官方媒体路径不能使用 32MB JSON 缓冲，也不能调用 `arrayBuffer()` 一次性读入音频；普通 JSON/API 目标仍可保留 32MB 响应上限。代理不得把音频 URL、ticket、令牌或正文写入日志。

### 4.3 本机服务远程下载

扩展现有 `POST /jobs`：

- 继续接受旧的 `audio` multipart 字段，保证旧客户端和测试兼容；
- 新增 `sourceUrl` 字段；`audio` 与 `sourceUrl` 必须恰好提供一个；
- `sourceUrl` 只允许 `https`，拒绝回环、私网、无 DNS 名称和不在允许 CDN/本站 relay 范围内的主机；
- HTTP 重定向最多 3 次，每次重定向都重新执行主机和协议校验；
- 下载使用固定大小缓冲区写入随机任务目录，不把整个音频载入内存；
- 依据 URL 后缀或安全的 `Content-Type` 选择临时文件后缀，下载后仍由 `ffprobe` 检查真实格式和时长；
- 流式累计字节数超过 1GB 立即终止并返回 `AUDIO_TOO_LARGE`；时长超过 2 小时返回 `AUDIO_TOO_LONG`；
- DNS、TLS、超时、HTTP 非 2xx 或解码失败分别映射为可重试的 `AUDIO_DOWNLOAD_FAILED` / `AUDIO_DECODE_FAILED`；
- 远程下载成功后进入现有 `JobManager`，后续模式、参考区间、进度、取消和清理逻辑不变。

本机服务不接受任意第三方 URL。默认允许官方媒体 CDN（`media.xyzcdn.net` 及同级官方媒体域名）和当前应用 relay 主机；允许列表集中在配置中，并在测试中覆盖恶意重定向、私网地址和非 HTTPS 地址。

## 5. 前端用户体验

`SpeakerDiarizationPanel` 改为接收 `episode.eid`、标题和时长，不再渲染 `<input type="file">`。打开面板后：

1. 自动请求音频源；显示“正在获取小宇宙官方音频”；
2. 成功后用返回地址设置 `<audio controls preload="metadata">`，用于定位两人的 5–30 秒参考区间；
3. 保留“全自动识别 / 两人声纹”、说话人数、主持人/嘉宾参考区间和 5 秒最低提示；
4. 点击开始时只提交 `sourceUrl`（直连地址优先，失败可切换 relay）以及现有模式字段；
5. 显示“下载官方音频 → 本机识别 → 第 N/M 块”阶段，下载或网络错误可重新获取源地址；
6. 成功后沿用现有待确认预览、标签修改、人工 overrides 和保存流程；
7. 保存完成后，工具栏的“AI 清理文稿”继续处理当前稿，而不是官方原稿。

音频源地址只保存在组件内存；关闭面板、任务完成或失败时清空，不写入 localStorage、数据库、Markdown 或日志。页面继续提醒音频会在本机临时处理，并由用户确认其有权处理节目音频。

当单集已有保存的声纹布局时，不自动重新识别；用户明确打开面板并开始新任务才会覆盖当前布局。AI 清理完成后若布局 hash 失配，沿用现有“说话人布局需重新生成”提示和可撤销清理，不丢失文稿正文。

## 6. 数据模型与兼容性

- `OfficialEpisode` 增加 `audioUrl: string | null`、`audioMimeType: string | null`；不新增数据库列。
- `getOfficialEpisode` 继续返回旧字段，现有文稿导入行为不变；音频字段只用于声纹任务。
- `LocalSpeakerJobOptions` 增加 `{ sourceUrl: string; mode: … }` 远程源变体；旧的 `File` 重载保留给兼容测试和 API 使用者。
- `Job` 增加受限的 `source_url` 内部字段或下载回调，但 `JobSnapshot` 不返回完整 URL、ticket、文件名或请求头。
- `GET /health` 不返回上游 URL；错误响应不得回显完整 URL、认证信息或响应正文。
- 现有 speaker artifact、`speaker_source`、current/original hash、AI 清理快照与撤销协议不变。

## 7. 错误与资源边界

错误分层如下：

- 账号/单集：`AUTH_EXPIRED`、`EPISODE_NOT_FOUND`、`NO_AUDIO`；
- 地址安全：`AUDIO_URL_INVALID`、`AUDIO_HOST_NOT_ALLOWED`、`AUDIO_REDIRECT_NOT_ALLOWED`；
- 下载：`AUDIO_DOWNLOAD_FAILED`、`AUDIO_TOO_LARGE`、`AUDIO_TOO_LONG`；
- 解码/模型：沿用 `AUDIO_DECODE_FAILED`、模型登录和声纹错误码。

所有失败必须满足：不创建或不发布说话人结果，不修改 current.md、transcript.json 或 AI 清理快照；任务临时目录可立即删除，过期清理再次兜底。取消任务后，下载和模型阶段均检查取消事件，晚到的结果不发布。

## 8. 测试与验收

### TypeScript/Worker

- `getOfficialEpisode` 能从 `media.source.url`、`media.url`、`enclosure.url`、`audioUrl` 按顺序提取，并拒绝非 HTTPS/回环地址；
- 音频源路由只允许当前用户的 `eid`，返回时长、MIME 和 relay ticket，不泄漏授权 header；
- relay ticket 绑定用户和单集、过期/重复消费失败，流式转发不缓存完整正文；
- 前端声纹面板不再包含本地 `<input type="file">`，会先获取音频源，并把 `sourceUrl` 传给本地客户端；
- 直连失败时能切换 relay，失败任务不改稿；
- 现有导入、登录、声纹对齐、AI 清理和下载测试继续通过。

### Python 本地服务

- 远程下载按块写盘，不把响应一次性读入内存；
- 最大字节数、时长、协议、主机和重定向限制在下载前后都生效；
- 官方 CDN 和本站 relay 允许，localhost、127.0.0.1、IPv6 回环、私网、恶意重定向和非 HTTPS 拒绝；
- `audio` 与 `sourceUrl` 同时缺失或同时存在返回明确的 422；
- 下载失败、取消、超限会清理临时目录且不会进入推理；
- 旧 multipart 文件上传测试、两人声纹、全自动模式、GPU/CPU 状态和任务轮询继续通过。

### 手工验收

1. 打开已有小宇宙单集，确认面板自动显示官方音频播放器且不要求选择文件；
2. 选取主持人/嘉宾各 5–30 秒参考，运行两人声纹，记录下载、识别和总耗时；
3. 保存后确认 Markdown 仍保留说话人标题和时间戳，`original.md` 未改变；
4. 点击“AI 清理文稿”，确认处理的是带说话人标题的 current.md，并可撤销；
5. 断开网络或模拟直连 CDN 失败，确认自动使用 relay 或给出明确错误；
6. 用超过 2 小时/1GB 的官方音频确认在下载和推理前拒绝；
7. 检查任务结束后的临时目录、日志和响应中没有完整 URL、token、音频正文或文件名。

## 9. 回退与版本策略

- 新开发分支：`feature/remote-episode-audio`；
- `feature/ai-transcript-cleanup`、`feature/two-speaker-voiceprint` 和归档的本地音频分支均保持可找回；
- 若官方接口字段变化或 relay 在部署环境不可用，可切回现有本地文件 UI，不需要迁移数据库；
- 远程音频能力仅在新分支验证通过后再考虑合并，不删除旧分支。
