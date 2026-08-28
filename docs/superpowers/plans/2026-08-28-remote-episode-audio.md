# Remote Episode Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让声纹面板根据已导入的小宇宙单集自动获取官方音频，由本机服务流式下载并识别，不再要求用户选择本地音频文件，同时保留两人声纹与 AI 文稿清理链路。

**Architecture:** 应用服务使用已连接的小宇宙授权为单集签发短时音频源和一次性 relay ticket；本机 FastAPI 服务优先直连官方 CDN，失败时使用受保护的 relay 地址，并把音频按块写入任务临时目录后复用现有 GPU/分块引擎。前端只传 `eid`、音频源和说话人模式，识别保存后继续对 current.md 执行 AI 清理。

**Tech Stack:** React 19 + TypeScript、Vinext/Cloudflare Worker、D1 `app_state`、Web Crypto、Node `node:test`、Python 3.12 标准库 `urllib`/FastAPI/Uvicorn、FFmpeg、现有 pyannote/WeSpeaker 引擎。

---

### Task 1: 提取并验证官方音频源

**Files:**

- Modify: `lib/xiaoyuzhou.ts`
- Test: `tests/core.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/core.test.ts` 的小宇宙接口测试旁增加三个用例。先在测试文件顶部现有导入之后定义固定的测试凭据和响应工厂，避免测试依赖未声明的变量：

```ts
const officialAudioTestTokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  deviceId: "device-id",
};

function officialEpisodeResponse(extra: Record<string, unknown> = {}) {
  return Response.json({ data: {
    id: "67fc60374d8edb5eb86d6026",
    title: "测试单集",
    podcast: { title: "测试节目" },
    duration: 120,
    transcript: { mediaId: "transcript.m4a" },
    ...extra,
  } });
}

test("extracts the official audio source from media source data", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ data: {
      id: "67fc60374d8edb5eb86d6026", title: "测试单集",
      podcast: { title: "测试节目" }, duration: 120,
      media: { id: "media.m4a", mimeType: "audio/mp4", source: {
        url: "https://media.xyzcdn.net/test.m4a",
      } }, transcript: { mediaId: "transcript.m4a" },
    } });
    const episode = await getOfficialEpisode("67fc60374d8edb5eb86d6026", officialAudioTestTokens);
    assert.equal(episode.audioUrl, "https://media.xyzcdn.net/test.m4a");
    assert.equal(episode.audioMimeType, "audio/mp4");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("falls back through official audio URL fields in a fixed order", async () => {
  const previousFetch = globalThis.fetch;
  try {
    const responses = [
      officialEpisodeResponse({
        media: { url: "https://media.xyzcdn.net/media-url.m4a", source: { url: "" } },
        enclosure: { url: "https://media.xyzcdn.net/enclosure-url.m4a" },
      }),
      officialEpisodeResponse({
        media: { source: { url: "" } },
        enclosure: { url: "https://media.xyzcdn.net/enclosure-only.m4a", type: "audio/mp4" },
      }),
      officialEpisodeResponse({
        media: { source: { url: "" } },
        enclosure: { url: "" },
        audioUrl: "https://media.xyzcdn.net/audio-field.m4a",
        audioMimeType: "audio/mp4",
      }),
    ];
    globalThis.fetch = async () => {
      const response = responses.shift();
      assert.ok(response, "测试响应数量必须与请求数量一致");
      return response;
    };
    const first = await getOfficialEpisode("67fc60374d8edb5eb86d6026", officialAudioTestTokens);
    const second = await getOfficialEpisode("67fc60374d8edb5eb86d6026", officialAudioTestTokens);
    const third = await getOfficialEpisode("67fc60374d8edb5eb86d6026", officialAudioTestTokens);
    assert.equal(first.audioUrl, "https://media.xyzcdn.net/media-url.m4a");
    assert.equal(second.audioUrl, "https://media.xyzcdn.net/enclosure-only.m4a");
    assert.equal(second.audioMimeType, "audio/mp4");
    assert.equal(third.audioUrl, "https://media.xyzcdn.net/audio-field.m4a");
    assert.equal(third.audioMimeType, "audio/mp4");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("rejects unsafe official audio URLs", () => {
  assert.throws(() => validateOfficialAudioUrl("http://127.0.0.1/audio.m4a"), XiaoyuzhouError);
  assert.throws(() => validateOfficialAudioUrl("https://example.com/audio.m4a"), XiaoyuzhouError);
  assert.equal(validateOfficialAudioUrl("https://media.xyzcdn.net/audio.m4a"), "https://media.xyzcdn.net/audio.m4a");
});
```

Keep the existing fetch restoration pattern so the test suite does not leak a stubbed `fetch`.

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --experimental-strip-types --test tests/core.test.ts --test-name-pattern="official audio|unsafe official"`

Expected: FAIL because `OfficialEpisode` has no audio fields and `validateOfficialAudioUrl` is not implemented.

- [ ] **Step 3: 实现最小代码**

在 `OfficialEpisode` 增加 `audioUrl: string | null` 和 `audioMimeType: string | null`。增加并导出 `validateOfficialAudioUrl(value: string): string`：只接受 HTTPS、无用户名/密码、公开主机，并将官方媒体主机限制为 `xyzcdn.net`/其子域和 `xiaoyuzhoufm.com`/其子域；拒绝回环、私网、无效 URL 和其他主机，失败抛出 `XiaoyuzhouError("AUDIO_URL_INVALID", "小宇宙返回了不安全的官方音频地址")`。

在 `getOfficialEpisode` 中从 `media.source.url`、`media.url`、`enclosure.url`、`audioUrl` 按顺序取字符串；通过 `media.mimeType`、`enclosure.type` 或 `audioMimeType` 取 MIME。音频字段缺失时返回 `null`，不要影响已有官方文稿导入；字段存在但不安全时让验证函数在音频源路由中报错。更新现有 `getOfficialEpisode` 和 `buildMarkdown` 测试对象以包含两个新字段。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --experimental-strip-types --test tests/core.test.ts --test-name-pattern="official audio|unsafe official"`

Expected: 所有匹配测试 PASS，原有小宇宙接口测试仍 PASS。

- [ ] **Step 5: 提交**

```powershell
git add lib/xiaoyuzhou.ts tests/core.test.ts
git commit -m "feat: extract official episode audio source"
```

### Task 2: 建立一次性 relay ticket 和音频源/中转路由

**Files:**

- Create: `lib/audio-relay-ticket.ts`
- Create: `app/api/episodes/[eid]/audio-source/route.ts`
- Create: `app/api/episodes/[eid]/audio-relay/route.ts`
- Test: `tests/audio-source-routes.test.ts`
- Test: `tests/audio-relay-ticket.test.ts`
- Modify: `lib/xiaoyuzhou.ts`

- [ ] **Step 1: 写失败测试**

新增纯 ticket 测试，使用现有 D1 测试夹具和 Web Crypto：

```ts
test("relay ticket is bound to user and episode and can be consumed once", async () => {
  const db = createFakeD1();
  const ticket = await issueAudioRelayTicket(db, { userId: "user-a", eid: "episode-a", ttlSeconds: 90 });
  assert.deepEqual(await consumeAudioRelayTicket(db, ticket, "episode-a"), { userId: "user-a", eid: "episode-a" });
  assert.equal(await consumeAudioRelayTicket(db, ticket, "episode-a"), null);
  assert.equal(await consumeAudioRelayTicket(db, ticket, "episode-b"), null);
});
```

在 `tests/audio-relay-ticket.test.ts` 顶部提供一个只实现本测试所需 D1 操作的内存夹具；它明确模拟 `app_state` 的插入、条件删除和过期清理，不依赖未定义的外部 helper：

```ts
function createFakeD1() {
  const rows = new Map<string, { value: string; updated_at: number }>();
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T = { value: string }>() {
              if (sql.includes("SELECT value FROM app_state WHERE key = ?")) {
                const row = rows.get(String(args[0]));
                return row ? ({ value: row.value } as T) : null;
              }
              return null;
            },
            async run() {
              if (sql.includes("DELETE FROM app_state WHERE key LIKE 'audio-relay:%'")) {
                const cutoff = Number(args[0]);
                for (const [key, row] of rows) if (row.updated_at < cutoff) rows.delete(key);
                return { meta: { changes: 0 } };
              }
              if (sql.includes("INSERT INTO app_state")) {
                rows.set(String(args[0]), { value: String(args[1]), updated_at: Number(args[2]) });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("DELETE FROM app_state WHERE key = ? AND value = ?")) {
                const key = String(args[0]);
                const row = rows.get(key);
                if (row && row.value === String(args[1])) {
                  rows.delete(key);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              throw new Error(`未覆盖的 D1 测试语句: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
```

新增音频源路由测试，替换 `requireApiUser`、`getEpisodeRecord`、`withFreshTokens`、`getOfficialEpisode` 和 ticket 依赖，断言：

- 不属于当前用户的 `eid` 返回 404；
- 正常响应为 `audioUrl`、`relayUrl`、`mimeType`、`durationSeconds`、`expiresAt`，响应头为 `Cache-Control: no-store`；
- 官方音频缺失返回 404 `NO_AUDIO`；
- relay 路由只消费有效 ticket，过期/重复/错误 `eid` 返回 410/404；
- relay 请求使用官方音频 URL，通过 `Response(upstream.body, ...)` 流式返回，并只透传 `content-type`、`content-length`、`accept-ranges`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --experimental-strip-types --test tests/audio-relay-ticket.test.ts tests/audio-source-routes.test.ts`

Expected: FAIL because ticket module and both routes do not exist.

- [ ] **Step 3: 实现最小代码**

在 `lib/audio-relay-ticket.ts` 中使用 `app_state` 表保存 `audio-relay:<sha256(ticket)>`：value 为 `{ userId, eid, expiresAt }`，ticket 使用 Web Crypto 随机 32 字节的 base64url 字符串；消费使用带原 value 条件的 DELETE，只有 `meta.changes === 1` 才成功，从而保证并发请求只能消费一次。创建时删除已过期的 `audio-relay:%` 记录，不增加数据库迁移。

在 `lib/xiaoyuzhou.ts` 增加 `fetchOfficialAudio(url, init?)`：调用现有 `fetchUpstream`，使用 `redirect: "manual"` 检查最多 3 次 HTTPS 官方主机重定向，最终返回原始 `Response`；不读取完整 body，不记录 URL 或响应正文。

`audio-source` 路由必须先 `requireApiUser()`、确认 episode 属于当前用户，再在 `withFreshTokens` 中调用 `getOfficialEpisode` 和 URL 验证；ticket 只绑定用户/eid，不把小宇宙 token 放入 URL。`relayUrl` 使用 `new URL(..., request.url)` 生成绝对地址，响应设置 `Cache-Control: no-store`。

`audio-relay` 路由不依赖浏览器 cookie，只接收 ticket 和路径 `eid`，消费 ticket 后用绑定用户的 `withFreshTokens` 重新取得最新官方 URL，再调用 `fetchOfficialAudio`；上游失败、非音频 MIME、超过 1GB 或 ticket 无效时返回不含 URL/token 的中文错误。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --experimental-strip-types --test tests/audio-relay-ticket.test.ts tests/audio-source-routes.test.ts`

Expected: 新测试全部 PASS，且响应 body 不被转换为 `arrayBuffer`。

- [ ] **Step 5: 提交**

```powershell
git add -- lib/audio-relay-ticket.ts lib/xiaoyuzhou.ts 'app/api/episodes/[eid]/audio-source/route.ts' 'app/api/episodes/[eid]/audio-relay/route.ts' tests/audio-relay-ticket.test.ts tests/audio-source-routes.test.ts
git commit -m "feat: add short-lived episode audio relay"
```

### Task 3: 让开发代理能够流式转发大体积官方音频

**Files:**

- Modify: `scripts/dev-upstream-proxy.mjs`
- Test: `tests/dev-upstream-proxy.test.mjs`

- [ ] **Step 1: 写失败测试**

为代理增加可测试的 `streamUpstreamResponse`/目标判断导出，测试模拟一个带 `ReadableStream` body 的官方媒体响应，断言代理不调用 `arrayBuffer()`，以固定块转发并允许大于 32MB、但在 1GB 前停止；非官方 JSON 仍保持 32MB 限制。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/dev-upstream-proxy.test.mjs`

Expected: FAIL because the current proxy always calls `upstream.arrayBuffer()` and enforces the 32MB cap for every target.

- [ ] **Step 3: 实现最小代码**

在 `scripts/dev-upstream-proxy.mjs` 中为 `isOfficialTarget(target)` 的官方 CDN 响应增加 1GB 上限和流式写出：优先检查可信 `Content-Length`，未知长度时按块计数；JSON/普通目标仍读入最多 32MB。转发过程中不复制 hop-by-hop headers，不输出目标 URL、音频内容或认证 token；超限在写 header 前返回受限 JSON，写出后发现超限则销毁响应连接。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test tests/dev-upstream-proxy.test.mjs`

Expected: 官方媒体流式测试和旧 32MB 限制测试 PASS。

- [ ] **Step 5: 提交**

```powershell
git add scripts/dev-upstream-proxy.mjs tests/dev-upstream-proxy.test.mjs
git commit -m "fix: stream large official audio through dev proxy"
```

### Task 4: 扩展本机服务以流式下载远程音频

**Files:**

- Modify: `local-audio-service/app/audio.py`
- Modify: `local-audio-service/app/models.py`
- Modify: `local-audio-service/app/jobs.py`
- Modify: `local-audio-service/app/main.py`
- Test: `local-audio-service/tests/test_audio.py`
- Test: `local-audio-service/tests/test_jobs.py`
- Test: `local-audio-service/tests/test_main.py`

- [ ] **Step 1: 写失败测试**

在 Python 测试中先增加：

- `download_remote_audio` 按 1MiB 块写入临时文件，不调用 `read()` 无参数或一次性读取；
- `https://media.xyzcdn.net/a.m4a` 允许，HTTP、回环、私网、未知主机和跳转到私网拒绝；
- `Content-Length`/累计字节超过 1GB 返回 `AUDIO_TOO_LARGE`，`ffprobe` 超过 2 小时返回 `AUDIO_TOO_LONG`；
- `POST /jobs` 在 `audio` 与 `sourceUrl` 都缺失或同时存在时返回 422；
- 远程源失败时使用 `fallbackUrl`，两个源都失败时清理目录且任务不进入模型；
- 原有 multipart 文件上传、voiceprint references、取消和任务快照测试继续使用原接口。

- [ ] **Step 2: 运行测试确认 RED**

Run: `py -3.12 -m unittest local-audio-service/tests/test_audio.py local-audio-service/tests/test_jobs.py local-audio-service/tests/test_main.py -v`

Expected: 新增远程下载/字段测试 FAIL，旧测试保持可运行。

- [ ] **Step 3: 实现最小代码**

在 `audio.py` 使用标准库 `urllib.request` 自定义重定向处理器：每次请求和重定向都验证 HTTPS、官方 CDN 或 `SPEAKER_ALLOWED_ORIGINS` 中的本站 relay origin；最多 3 次跳转。以 1MiB 缓冲区写入任务目录，检查取消事件、可信 `Content-Length` 和累计字节；依据 URL 后缀或安全 MIME 选择 `.m4a`/`.mp3`/`.wav`/`.flac`/`.ogg`/`.mp4`/`.webm`，下载完成后调用现有 `validate_audio_file` 做真实格式/时长校验。新增错误码 `AUDIO_DOWNLOAD_FAILED`、`AUDIO_HOST_NOT_ALLOWED`、`AUDIO_REDIRECT_NOT_ALLOWED`，不把 URL 写入错误消息。

在 `Job` 增加 `source_urls`，在 `JobManager.create_job`/`start` 中允许远程任务；`run` 的 `decoding` 阶段先下载直连 URL，失败后清理部分文件并尝试 relay URL，再设置 `source_path`、`duration_ms` 和分块进度。捕获 `AudioValidationError` 时保留具体安全错误码；取消事件在下载循环和推理前后检查，失败/取消沿用现有目录清理。

在 `main.py` 将 `audio: UploadFile = File(...)` 改为可选，增加 `sourceUrl`、`fallbackUrl` 表单字段；严格要求上传文件和远程源二选一，远程源最多两个且必须通过 URL 校验。远程任务不在 HTTP 请求线程中下载，创建后立即 202 并交给 JobManager；`_job_payload` 只返回状态/错误码/进度/区间，不返回源 URL、relay ticket 或文件名。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `py -3.12 -m unittest local-audio-service/tests/test_audio.py local-audio-service/tests/test_jobs.py local-audio-service/tests/test_main.py -v`

Expected: 远程下载、回退、上限、SSRF 防护、旧上传和取消测试全部 PASS。

- [ ] **Step 5: 提交**

```powershell
git add local-audio-service/app/audio.py local-audio-service/app/models.py local-audio-service/app/jobs.py local-audio-service/app/main.py local-audio-service/tests/test_audio.py local-audio-service/tests/test_jobs.py local-audio-service/tests/test_main.py
git commit -m "feat: stream remote episode audio in local service"
```

### Task 5: 扩展 TypeScript 本机客户端协议

**Files:**

- Modify: `lib/local-speaker-client.ts`
- Test: `tests/local-speaker-client.test.ts`

- [ ] **Step 1: 写失败测试**

增加测试，调用 `createLocalSpeakerJob(
  { sourceUrl: "https://media.xyzcdn.net/a.m4a", fallbackUrl: "http://localhost:3000/api/episodes/e/audio-relay?ticket=t" },
  { mode: "voiceprint", references: {
    speaker_0: { startMs: 0, endMs: 10_000 },
    speaker_1: { startMs: 20_000, endMs: 30_000 },
  } },
)`，断言 FormData 含 `sourceUrl`、`fallbackUrl`、`mode`、`references`，不含 `audio`；并断言 `AUDIO_DOWNLOAD_FAILED` 的错误提示为可重试中文文案。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --experimental-strip-types --test tests/local-speaker-client.test.ts --test-name-pattern="远程|下载"`

Expected: FAIL because the client only accepts `File` and has no remote source fields.

- [ ] **Step 3: 实现最小代码**

增加 `RemoteSpeakerAudioSource { sourceUrl: string; fallbackUrl?: string }` 类型和 `createLocalSpeakerJob` 重载；保留旧 File 重载及 multipart 行为。远程重载只附加源字段和现有模式字段，`credentials: "omit"`、`X-Speaker-Client-Version`、错误结构解析保持不变。将 `AUDIO_DOWNLOAD_FAILED`、`AUDIO_HOST_NOT_ALLOWED`、`AUDIO_REDIRECT_NOT_ALLOWED` 映射为不暴露 URL 的中文提示。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --experimental-strip-types --test tests/local-speaker-client.test.ts`

Expected: 新旧客户端测试全部 PASS。

- [ ] **Step 5: 提交**

```powershell
git add lib/local-speaker-client.ts tests/local-speaker-client.test.ts
git commit -m "feat: send remote audio sources to local speaker service"
```

### Task 6: 将声纹面板改为单集链接音频

**Files:**

- Modify: `app/speaker-diarization-panel.tsx`
- Modify: `app/globals.css`
- Modify: `app/workspace.tsx`
- Test: `tests/rendered-html.test.mjs`

- [ ] **Step 1: 写失败测试**

在静态测试中断言面板包含 `audio-source`、`sourceUrl`、`fallbackUrl`、`正在获取小宇宙官方音频`，仍包含 `两人声纹`、`主持人参考`、`嘉宾参考` 和 `<audio controls>`，并且不包含 `<input ... type="file">`、`选择本地音频` 或 `AUDIO_ACCEPT`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/rendered-html.test.mjs --test-name-pattern="local-only speaker|voiceprint"`

Expected: FAIL because the current panel renders a local file input and never requests `audio-source`.

- [ ] **Step 3: 实现最小代码**

将 `SpeakerDiarizationPanel` 状态从 `File`/object URL 改为 `AudioSource { audioUrl, relayUrl, mimeType, durationSeconds, expiresAt }`；面板打开后通过 `apiFetch(/api/episodes/${eid}/audio-source)` 请求源，显示获取状态和可重试错误。`<audio>` 使用返回的 `audioUrl`，时长优先使用接口/episode 值并由 `loadedmetadata` 校正。

`start()` 在源未就绪时不创建任务；健康检查成功后调用远程 `createLocalSpeakerJob`，传入直连和 fallback relay、全自动或两人声纹模式以及已有参考区间。保留 2 小时/1GB 文案、5–30 秒参考校验、进度轮询、取消、预览、人工修正和保存；关闭/完成/失败时清空内存中的源对象。错误提示增加“官方音频获取失败，可重试”，不显示完整 URL。工具栏仍保持 `AI 清理文稿` 与声纹按钮互斥禁用逻辑。

更新 CSS 只处理状态/播放器间距，不恢复文件上传样式；更新 `workspace.tsx` 传入现有 `episode.eid`/时长即可，不改变 AI 清理默认使用 current.md 的逻辑。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test tests/rendered-html.test.mjs --test-name-pattern="local-only speaker|voiceprint"`

Expected: 静态 UI 测试 PASS，且原有 AI 清理/登录/下载断言不变。

- [ ] **Step 5: 提交**

```powershell
git add app/speaker-diarization-panel.tsx app/globals.css app/workspace.tsx tests/rendered-html.test.mjs
git commit -m "feat: load episode audio from official link"
```

### Task 7: 更新使用说明和安全边界

**Files:**

- Modify: `README.md`
- Modify: `local-audio-service/README.md`
- Modify: `docs/superpowers/specs/2026-08-28-remote-episode-audio-design.md`
- Test: `tests/rendered-html.test.mjs`

- [ ] **Step 1: 写失败测试**

增加文档静态断言：两份 README 都说明“打开已有小宇宙单集即可获取官方音频”“本机流式下载”“默认直连、失败时短时 relay”“不保存永久音频”“2 小时/1GB”“两人声纹参考 5–30 秒”和“用户需有权处理音频”；同时断言旧的“必须选择本地音频”表述不再作为用户流程。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/rendered-html.test.mjs --test-name-pattern="remote audio|speaker workflow"`

Expected: FAIL because README 仍描述本地文件上传流程。

- [ ] **Step 3: 更新文档**

主 README 的声纹章节改为：导入文稿后打开面板，系统从同一单集链接获取官方音频，本机服务直连 CDN，网络不通时短时 relay；音频临时落盘并自动清理，官方音频版权和账号权限由用户负责。`local-audio-service/README.md` 删除“选择本地音频”的操作步骤，补充 `SPEAKER_ALLOWED_ORIGINS` 对 relay origin 的说明、下载失败/重试提示和旧 File API 仅用于兼容。

在设计规格的实现说明中补充开发代理必须对官方媒体流式转发、不能使用 32MB JSON 缓冲的约束，保持规格与实现一致。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test tests/rendered-html.test.mjs --test-name-pattern="remote audio|speaker workflow"`

Expected: 文档与静态页面断言 PASS。

- [ ] **Step 5: 提交**

```powershell
git add README.md local-audio-service/README.md docs/superpowers/specs/2026-08-28-remote-episode-audio-design.md tests/rendered-html.test.mjs
git commit -m "docs: explain official episode audio workflow"
```

### Task 8: 全量验证与本机启动

**Files:**

- No additional production files unless a failing regression test identifies a specific defect; every fix must add a failing test first.

- [ ] **Step 1: 运行 TypeScript 回归**

Run: `npm test`, `npm run lint`, `npx tsc --noEmit`, `git diff --check`

Expected: build、Node tests、lint、TypeScript 和空白检查全部退出码 0。

- [ ] **Step 2: 运行 Python 回归**

Run: `py -3.12 -m unittest discover -s local-audio-service/tests -p 'test_*.py' -v`

Expected: 本地服务单元测试零失败，不下载模型、不输出 token、路径、完整 URL 或音频正文；若 `.venv` 尚未恢复，先按 `local-audio-service/README.md` 重新安装，再重复本步骤。

- [ ] **Step 3: 启动并检查两项服务**

在远程音频分支工作树启动 `npm run dev -- --port 3000` 和 `./scripts/start-local-speaker-service.ps1`。通过页面打开一个已有小宇宙单集，确认面板显示官方播放器而不是文件选择器；健康接口确认 `service=ok`、FFmpeg 可用和 CUDA/CPU 状态；不要在日志或截图中暴露 ticket、官方完整 URL 或 token。

- [ ] **Step 4: 手工验收完整链路**

1. 选“两人声纹”，给主持人/嘉宾各填 5–30 秒参考，确认本机服务下载并显示分块进度；
2. 预览中检查待确认片段并保存，确认 current.md 有说话人标题/时间戳且 original.md 未改变；
3. 点击“AI 清理文稿”，确认清理的是带说话人的 current.md，统计和撤销仍可用；
4. 模拟官方 CDN 直连失败，确认自动使用 relay；
5. 用超 2 小时或 1GB 的官方音频确认下载阶段拒绝，且不启动模型、不改稿；
6. 关闭/取消任务后确认临时目录最终清理，响应和日志没有完整音频 URL、ticket、token 或正文。

- [ ] **Step 5: 最终检查与提交记录**

Run: `git status --short --branch`, `git log --oneline -12`, `git worktree list`

Expected: `feature/remote-episode-audio` 工作树干净，`feature/ai-transcript-cleanup`、`feature/two-speaker-voiceprint` 和归档分支仍存在且未被改写。

## Plan self-review

- **Spec coverage:** Tasks 1–3 cover official field extraction, URL safety, one-time relay and large-response proxying; Task 4 covers remote streaming, SSRF/redirect/size limits and job lifecycle; Task 5–6 cover client protocol and UI removal of file input; Task 7 covers docs/privacy; Task 8 covers automated and manual acceptance, including AI cleanup after speaker save.
- **Placeholder scan:** No `TBD`, `TODO`, or unspecified implementation steps are used; every production change has an explicit file, failing test, command, expected result, and commit.
- **Type consistency:** `OfficialEpisode.audioUrl/audioMimeType`, `RemoteSpeakerAudioSource.sourceUrl/fallbackUrl`, Python `Job.source_urls`, `AUDIO_*` error codes, and relay route names are used consistently across tasks.
- **Isolation:** Work is on `feature/remote-episode-audio`, based on the approved AI cleanup branch; main branch user edits and the preserved voiceprint branch are not touched.
