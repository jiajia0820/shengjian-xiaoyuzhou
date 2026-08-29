# 本地音频说话人分段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户把不超过 30 分钟的本地音频交给回环地址上的本地服务做匿名说话人分离，并将已保存的小宇宙官方文稿按说话人轮次保存为当前稿。

**Architecture:** 浏览器直接把 File 发送给 `127.0.0.1:8765`，本地 FastAPI 服务仅返回匿名时间区间，绝不转发音频。Cloudflare 应用的预览与保存路由从 R2 的 `transcript.json` 读取官方片段，计算重叠覆盖率、应用用户修正并重建 Markdown，因此客户端不能提交或修改正文。独立 Python 引擎接口将 pyannote 的实现与 HTTP/任务管理隔离，自动测试使用假的引擎和固定时间轴。

**Tech Stack:** TypeScript、React 19、Vinext/Cloudflare Worker、R2 JSON 旁车文件、FastAPI、Uvicorn、pyannote.audio Community-1、PyTorch CPU、FFmpeg、Python `unittest`。

---

## 文件结构

| 路径 | 职责 |
| --- | --- |
| `lib/transcript-artifact.ts` | 校验并读写版本化的官方片段、说话人标签和本功能生成的当前稿哈希。 |
| `lib/transcript-speakers.ts` | 纯函数：校验时间区间、按重叠对齐、应用人工修正、生成显示标签。 |
| `lib/speaker-markdown.ts` | 纯函数：使用官方片段重建 `### 说话人 N` 的 Markdown，绝不使用客户端正文。 |
| `app/api/episodes/[eid]/speakers/preview/route.ts` | 无副作用预览路由。 |
| `app/api/episodes/[eid]/speakers/route.ts` | 确认保存路由，写 `transcript.json` 与 `current.md`。 |
| `local-audio-service/app/*.py` | 仅回环监听的本地上传、校验、任务、pyannote 引擎和 HTTP API。 |
| `lib/local-speaker-client.ts` | 浏览器直连本地服务的受限客户端。 |
| `app/speaker-diarization-panel.tsx` | 选择文件、轮询、人工校正与确认保存的 UI。 |
| `app/workspace.tsx`、`app/globals.css` | 在文稿工具栏挂载入口，提供响应式样式。 |

### Task 1: 建立版本化文字稿旁车文件

**Files:**

- Modify: `lib/xiaoyuzhou.ts`
- Create: `lib/transcript-artifact.ts`
- Modify: `lib/documents.ts`
- Modify: `app/api/episodes/import/route.ts`
- Modify: `package.json`
- Create: `tests/transcript-artifact.test.ts`

- [x] **Step 1: 写入失败测试，规定 v1 兼容、v2 校验与 R2 key。**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { buildTranscriptArtifact, parseTranscriptArtifact } from "../lib/transcript-artifact.ts";

  test("将官方片段保存为 v2，拒绝错误的 speaker 字段", () => {
    const artifact = buildTranscriptArtifact("episode", [{ startMs: 0, endMs: 800, text: "原文" }], "2026-08-24T00:00:00.000Z");
    assert.equal(artifact.schemaVersion, 2);
    assert.deepEqual(artifact.segments[0], {
      startMs: 0, endMs: 800, text: "原文", speakerId: null,
      speakerConfidence: null, speakerNeedsReview: false,
    });
    assert.equal(parseTranscriptArtifact(JSON.stringify({ ...artifact, segments: [{ ...artifact.segments[0], speakerConfidence: 2 }] })), null);
  });

  test("读取旧 v1 旁车文件时补齐说话人字段", () => {
    const parsed = parseTranscriptArtifact(JSON.stringify({
      schemaVersion: 1, source: "xiaoyuzhou", episodeId: "episode", capturedAt: "2026-08-24T00:00:00.000Z",
      segments: [{ startMs: 0, text: "原文" }],
    }));
    assert.equal(parsed?.schemaVersion, 2);
    assert.equal(parsed?.segments[0].speakerNeedsReview, false);
  });
  ```

- [x] **Step 2: 运行测试，确认模块尚不存在。**

  Run: `node --experimental-strip-types --test tests/transcript-artifact.test.ts`

  Expected: FAIL，提示找不到 `../lib/transcript-artifact.ts`。

- [x] **Step 3: 扩展官方片段类型，并实现无信任的 artifact parser。**

  在 `lib/xiaoyuzhou.ts` 中使用以下兼容类型；`getTranscriptSegments` 同时读取合法 `endMs`，但对官方返回的说话人字段一律按普通外部数据校验：

  ```ts
  export type TranscriptSegment = {
    startMs: number;
    endMs?: number | null;
    text: string;
    speakerId?: string | null;
    speakerConfidence?: number | null;
    speakerNeedsReview?: boolean;
  };
  ```

  在 `lib/transcript-artifact.ts` 定义 v2；只接受非负整数时间、非空文本、长度不超过 80 的 ID、0–1 的覆盖率以及布尔的 `speakerNeedsReview`。v1 输入应升级为 v2，标签和 `speakerLayout` 为空。核心类型定义为：

  ```ts
  export type SpeakerLabel = { id: string; label: string };
  export type SpeakerLayout = {
    engine: "pyannote-community-1";
    generatedAt: string;
    currentMarkdownHash: string;
    labels: SpeakerLabel[];
  };
  export type StoredTranscriptSegment = {
    startMs: number; endMs: number | null; text: string; speakerId: string | null;
    speakerConfidence: number | null; speakerNeedsReview: boolean;
  };
  export type TranscriptArtifact = {
    schemaVersion: 2; source: "xiaoyuzhou"; episodeId: string; capturedAt: string;
    segments: StoredTranscriptSegment[]; speakerLayout: SpeakerLayout | null;
  };
  ```

  `buildTranscriptArtifact` 必须复制文本、归一化可选字段并设置 `speakerLayout: null`；`parseTranscriptArtifact` 必须检查片段开始时间单调不减，失败返回 `null` 而不是抛出。

- [x] **Step 4: 在文档存储层添加 JSON 支持并于导入时原子顺序写入。**

  将 `documentKeys` 扩展为：

  ```ts
  return {
    originalKey: `${base}/original.md`, currentKey: `${base}/current.md`,
    transcriptKey: `${base}/transcript.json`,
  };
  ```

  添加 `putJson(key, value)`（`application/json; charset=utf-8`）和 `readJson(key)`；二者不记录正文。导入路由在 `putMarkdown(keys.originalKey, markdown)` 后执行：

  ```ts
  await putJson(keys.transcriptKey, buildTranscriptArtifact(parsed.eid, extracted.segments, now));
  ```

  已存在单集的刷新也覆盖官方 artifact，但绝不覆盖 `current.md`。

- [x] **Step 5: 将新 Node 测试加入默认测试命令并验证。**

  将 `package.json` 的 `test` 脚本末尾改为：

  ```json
  "node --experimental-strip-types --test tests/core.test.ts tests/rendered-html.test.mjs tests/transcript-artifact.test.ts"
  ```

  Run: `npm test`

  Expected: PASS；原有 75 个测试及新增 artifact 测试均通过。

- [x] **Step 6: 提交 artifact 基础。**

  ```powershell
  git add lib/xiaoyuzhou.ts lib/transcript-artifact.ts lib/documents.ts app/api/episodes/import/route.ts package.json tests/transcript-artifact.test.ts
  git commit -m "feat: persist transcript speaker artifacts"
  ```

### Task 2: 实现纯时间轴对齐和 Markdown 渲染

**Files:**

- Create: `lib/transcript-speakers.ts`
- Create: `lib/speaker-markdown.ts`
- Create: `tests/transcript-speakers.test.ts`
- Create: `tests/speaker-markdown.test.ts`
- Modify: `package.json`

- [x] **Step 1: 为重叠算法写出失败测试。**

  ```ts
  test("按累计重叠选择说话人，并把低覆盖率标记为待确认", () => {
    const result = alignTranscriptSpeakers([
      { startMs: 0, endMs: null, text: "甲" },
      { startMs: 10_000, endMs: 12_000, text: "乙" },
    ], [
      { startMs: 0, endMs: 8_000, speakerId: "speaker_0" },
      { startMs: 8_000, endMs: 12_000, speakerId: "speaker_1" },
    ], 12_000);
    assert.deepEqual(result.segments.map(({ speakerId, speakerConfidence, speakerNeedsReview }) => ({ speakerId, speakerConfidence, speakerNeedsReview })), [
      { speakerId: "speaker_0", speakerConfidence: 0.8, speakerNeedsReview: false },
      { speakerId: "speaker_1", speakerConfidence: 1, speakerNeedsReview: false },
    ]);
  });

  test("拒绝越界、相交和乱序的本地时间区间", () => {
    assert.throws(() => normalizeDiarizationTurns([{ startMs: 9, endMs: 2, speakerId: "speaker_0" }]));
    assert.throws(() => normalizeDiarizationTurns([{ startMs: 0, endMs: 3, speakerId: "a" }, { startMs: 2, endMs: 4, speakerId: "b" }]));
  });
  ```

- [x] **Step 2: 运行并确认失败。**

  Run: `node --experimental-strip-types --test tests/transcript-speakers.test.ts`

  Expected: FAIL，提示找不到 `transcript-speakers.ts`。

- [x] **Step 3: 实现时间区间和人工修正的纯函数。**

  `normalizeDiarizationTurns` 要求最多 10,000 条、严格递增、不重叠、`endMs > startMs`、ID 满足 `/^speaker_[0-9]{1,3}$/`。`alignTranscriptSpeakers` 使用下列规则，所有浮点覆盖率四舍五入到 3 位：

  ```ts
  const endMs = segment.endMs ?? nextSegment?.startMs ?? episodeDurationMs;
  const durationMs = Math.max(1, endMs - segment.startMs);
  const overlap = Math.max(0, Math.min(endMs, turn.endMs) - Math.max(segment.startMs, turn.startMs));
  ```

  按同一 `speakerId` 累加 overlap；最高者为结果，覆盖率低于 `0.6`、无重叠或片段涉及多个说话人时 `speakerNeedsReview: true`。`applySpeakerOverrides` 仅允许已出现在 turns 的 ID 或 `null`，并拒绝越界索引。`normalizeSpeakerLabels` 仅允许已知 ID、1–40 个 Unicode 字符、去空白后不重名；没填时按首次出现顺序产生“说话人 1”。

- [x] **Step 4: 为 Markdown 轮次规则写失败测试。**

  ```ts
  test("仅在说话人变化时新建标题，保留每轮开头时间戳", () => {
    const markdown = renderSpeakerMarkdown(OFFICIAL_MARKDOWN, [
      { startMs: 0, endMs: 2_000, text: "你好", speakerId: "speaker_0", speakerConfidence: 1, speakerNeedsReview: false },
      { startMs: 2_000, endMs: 4_000, text: "世界", speakerId: "speaker_0", speakerConfidence: 1, speakerNeedsReview: false },
      { startMs: 4_000, endMs: 6_000, text: "回应", speakerId: "speaker_1", speakerConfidence: 1, speakerNeedsReview: false },
    ], [{ id: "speaker_0", label: "主持人" }, { id: "speaker_1", label: "嘉宾" }]);
    assert.match(markdown, /### 主持人[\s\S]*\[00:00:00\] 你好世界[\s\S]*### 嘉宾[\s\S]*\[00:00:04\] 回应/);
    assert.doesNotMatch(markdown, /意群|organization_mode/);
  });
  ```

- [x] **Step 5: 实现安全 renderer。**

  `renderSpeakerMarkdown` 从传入的官方 Markdown 中保留 frontmatter、标题、Show Notes 和 `## 官方文稿` 标题，只替换该标题后的连续文稿区域；frontmatter 移除旧的 `transcript_layout`/`organization_mode`，加入：

  ```yaml
  transcript_layout: "speaker-v1"
  speaker_source: "pyannote-community-1"
  ```

  以 `speakerId ?? "unconfirmed"` 作为轮次键，变化时输出 `### ${safeLabel}` 和一个空行。相邻原文使用 `joinSegmentText` 合并：中文直接相连；仅当上一段以 ASCII 字母/数字结束、下一段以 ASCII 字母/数字开始时插入一个空格，防止 `hello` 和 `world` 粘连。绝不将模型或浏览器传入的正文用作输出来源。

- [x] **Step 6: 运行新增纯函数测试和全量测试。**

  Run: `node --experimental-strip-types --test tests/transcript-speakers.test.ts tests/speaker-markdown.test.ts`

  Expected: PASS。

  将这两个文件加入 `package.json` 的 `test` 脚本后运行：`npm test`

  Expected: PASS。

- [x] **Step 7: 提交纯业务逻辑。**

  ```powershell
  git add lib/transcript-speakers.ts lib/speaker-markdown.ts tests/transcript-speakers.test.ts tests/speaker-markdown.test.ts package.json
  git commit -m "feat: align transcript speakers locally"
  ```

### Task 3: 增加安全的预览与确认保存 API

**Files:**

- Create: `app/api/episodes/[eid]/speakers/preview/route.ts`
- Create: `app/api/episodes/[eid]/speakers/route.ts`
- Modify: `tests/core.test.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: 为路由写失败测试，证明浏览器不能提交正文。**

  使用已有 `registerHooks` 的 route mock 方式，为新增路由注册如下依赖名：

  ```ts
  "@/lib/db": "getEpisodeRecord,touchCurrentDocument",
  "@/lib/documents": "putJson,putMarkdown,readJson,readMarkdown",
  "@/lib/security": "sha256Hex",
  "@/lib/transcript-artifact": "parseTranscriptArtifact",
  "@/lib/transcript-speakers": "alignTranscriptSpeakers,applySpeakerOverrides,normalizeDiarizationTurns,normalizeSpeakerLabels",
  "@/lib/speaker-markdown": "renderSpeakerMarkdown",
  "@/lib/user": "apiError,HttpError,requireApiUser",
  ```

  断言 preview 对 `{ turns }` 返回只读 `segments` 和 `markdown`，并断言保存请求即使额外携带 `markdown: "恶意正文"`，写入的正文仍等于 `renderSpeakerMarkdown` 的结果。

- [x] **Step 2: 运行目标测试并确认路由尚不存在。**

  Run: `node --experimental-strip-types --test tests/core.test.ts`

  Expected: FAIL，提示 speaker route 无法导入或断言失败。

- [x] **Step 3: 实现共同的请求解析与预览路由。**

  两个路由均先执行 `requireApiUser({ mutation: true })`，再读取单集和 `keys.transcriptKey`。若 artifact 不存在或 `parseTranscriptArtifact` 返回 `null`，返回 `409 TRANSCRIPT_ARTIFACT_UNAVAILABLE`，提示用户重新获取官方原稿。

  preview 请求体仅允许：

  ```ts
  type PreviewBody = { turns: unknown; expectedSpeakers?: unknown };
  ```

  解析成功后执行 `normalizeDiarizationTurns` 与 `alignTranscriptSpeakers(artifact.segments, turns, record.duration_seconds ? record.duration_seconds * 1000 : null)`，返回：

  ```ts
  { preview: { segments, labels, markdown, reviewCount } }
  ```

  超过 1MB 的 `content-length`、非法 JSON、10,000 条以上 turns 或任何正文型字段都返回 `400 INVALID_SPEAKER_PREVIEW`。

- [x] **Step 4: 实现确认保存、当前稿冲突检测与回滚顺序。**

  保存体只能包含 `turns`、`labels` 和 `overrides`。重新从 artifact 对齐后才应用 `applySpeakerOverrides`；不要复用浏览器的 `segments` 或 `markdown`。读取 `current.md` 并哈希，允许保存的条件为：

  ```ts
  currentHash === record.original_hash || currentHash === artifact.speakerLayout?.currentMarkdownHash
  ```

  否则抛出 `HttpError(409, "CURRENT_DOCUMENT_CHANGED", "当前编辑稿已被手动修改；为避免覆盖，请先下载备份并恢复官方原稿后再保存说话人分段")`。

  成功路径必须依次：渲染服务器拥有的 Markdown → 计算哈希 → 构造 v2 artifact（带 `speakerLayout: { engine, generatedAt, currentMarkdownHash, labels }`）→ `putJson` → `putMarkdown` → `touchCurrentDocument`。任何校验失败发生在第一处写入前；写入 API 不记录文稿和说话人结果。

- [x] **Step 5: 为路由存在和 UI 接口增加静态回归断言。**

  在 `tests/rendered-html.test.mjs` 读取两个新 route，检查：

  ```js
  assert.match(saveRoute, /CURRENT_DOCUMENT_CHANGED/);
  assert.match(saveRoute, /renderSpeakerMarkdown/);
  assert.doesNotMatch(saveRoute, /body\.markdown/);
  assert.match(previewRoute, /normalizeDiarizationTurns/);
  ```

- [x] **Step 6: 运行全量 Node 测试并提交。**

  Run: `npm test`

  Expected: PASS。

  ```powershell
  git add app/api/episodes/[eid]/speakers tests/core.test.ts tests/rendered-html.test.mjs
  git commit -m "feat: save speaker-separated transcripts"
  ```

### Task 4: 以测试驱动构建本地 Python 任务核心

**Files:**

- Create: `local-audio-service/app/__init__.py`
- Create: `local-audio-service/app/models.py`
- Create: `local-audio-service/app/audio.py`
- Create: `local-audio-service/app/engine.py`
- Create: `local-audio-service/app/jobs.py`
- Create: `local-audio-service/tests/test_audio.py`
- Create: `local-audio-service/tests/test_jobs.py`

- [x] **Step 1: 写不依赖真实模型的 Python 失败测试。**

  ```python
  class FakeEngine:
      def diarize(self, path, expected_speakers, on_progress):
          on_progress(70)
          return [DiarizationTurn(start_ms=0, end_ms=2_000, speaker_id="speaker_0")]

  def test_job_finishes_and_removes_source_after_ttl(tmp_path):
      jobs = JobManager(root=tmp_path, engine=FakeEngine(), retention_seconds=0)
      job = jobs.create_ready_job(tmp_path / "sample.wav", duration_ms=2_000, expected_speakers=None)
      jobs.run(job.id)
      assert jobs.snapshot(job.id).status == "ready"
      assert jobs.snapshot(job.id).segments[0].speaker_id == "speaker_0"
      jobs.cleanup_expired()
      assert not (tmp_path / job.id).exists()
  ```

  `test_audio.py` 用 mock `subprocess.run` 验证 `probe_duration_ms` 只调用：

  ```python
  ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
  ```

  并在 `duration > 30 * 60 * 1000` 时抛出 `AudioValidationError("AUDIO_TOO_LONG")`。

- [x] **Step 2: 运行 Python 测试，确认缺少模块。**

  Run: `py -3.12 -m unittest discover -s local-audio-service/tests -v`

  Expected: FAIL，提示 `app` 或测试目标无法导入。

- [x] **Step 3: 实现值对象、音频校验和单并发 JobManager。**

  在 `models.py` 定义不可变 `DiarizationTurn(start_ms, end_ms, speaker_id)` 与状态为 `queued|decoding|diarizing|ready|failed|cancelled` 的 `JobSnapshot`。在 `audio.py` 固定：

  ```python
  MAX_BYTES = 500 * 1024 * 1024
  MAX_DURATION_MS = 30 * 60 * 1000
  SUPPORTED_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".mp4", ".webm"}
  ```

  `JobManager` 使用一个 `ThreadPoolExecutor(max_workers=1)`；任务目录只能是 `root / job_id`，其中 ID 由 `secrets.token_urlsafe(18)` 生成，禁止使用上传文件名作为目录。取消通过 `threading.Event` 表示；pyannote 不能安全中断时任务可完成推理但不得发布结果，最终状态为 `cancelled`。每个状态更新均不保存绝对路径或文件名到快照。

- [x] **Step 4: 定义可替换 pyannote engine，默认 CPU。**

  `engine.py` 提供：

  ```python
  class DiarizationEngine(Protocol):
      def diarize(self, path: Path, expected_speakers: int | None, on_progress: Callable[[int], None]) -> list[DiarizationTurn]: ...
  ```

  `PyannoteCommunityEngine` 延迟导入 `torch` 与 `pyannote.audio`，通过 `HF_TOKEN` 或 `huggingface_hub.get_token()` 获得 token；没有 token 时抛出不含 token 的 `ModelSetupError("HF_TOKEN_MISSING")`。调用 `Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=token)`，只在显式 `SPEAKER_DEVICE=cuda` 且 CUDA 可用时迁移到 GPU，默认 CPU。读取 `output.exclusive_speaker_diarization`，转换秒为毫秒，按起点排序，重新命名为首见顺序的 `speaker_0`、`speaker_1`；不输出模型概率。

- [x] **Step 5: 运行 Python 单元测试并提交。**

  Run: `py -3.12 -m unittest discover -s local-audio-service/tests -v`

  Expected: PASS，且输出中没有音频路径、文件名或 token。

  ```powershell
  git add local-audio-service/app local-audio-service/tests
  git commit -m "feat: add local diarization job core"
  ```

### Task 5: 暴露仅回环可访问的本地服务与安装脚本

**Files:**

- Create: `local-audio-service/app/main.py`
- Create: `local-audio-service/requirements.txt`
- Create: `local-audio-service/tests/test_main.py`
- Create: `local-audio-service/README.md`
- Create: `scripts/setup-local-speaker-service.ps1`
- Create: `scripts/start-local-speaker-service.ps1`
- Modify: `.gitignore`

- [x] **Step 1: 为 HTTP 边界写失败测试。**

  用 `fastapi.testclient.TestClient` 和 FakeEngine 断言：

  ```python
  def headers(origin="http://localhost:3000"):
      return {"Origin": origin, "X-Speaker-Client-Version": "1"}

  def test_rejects_foreign_origin_and_missing_custom_header(client):
      assert client.post("/jobs", headers=headers("https://evil.example")).status_code == 403
      assert client.post("/jobs", headers={"Origin": "http://localhost:3000"}).status_code == 403
  ```

  还要断言 `/health` 不含 `token`、`path`、`filename`；超过 500MB 的流式上传在写完整文件前返回 413；`DELETE /jobs/{id}` 只影响对应 ID。

- [x] **Step 2: 实现 FastAPI 路由与 CORS/PNA 规则。**

  `create_app(settings, manager)` 默认只允许以下 Origin：

  ```python
  {"http://localhost:3000", "http://127.0.0.1:3000"}
  ```

  可通过逗号分隔的 `SPEAKER_ALLOWED_ORIGINS` 额外配置部署站点。CORS 只能允许 `GET, POST, DELETE, OPTIONS` 与 `Content-Type, X-Speaker-Client-Version`，禁止 `allow_origins=["*"]` 和 cookie。对带 `Access-Control-Request-Private-Network: true` 且 Origin 已允许的 OPTIONS 响应添加 `Access-Control-Allow-Private-Network: true`。

  `POST /jobs` 必须校验实际连接来自 `127.0.0.1` 或 `::1`、Origin 在白名单、请求头 `X-Speaker-Client-Version: 1`。把 `UploadFile` 分块写入任务目录，超过 `MAX_BYTES` 立即停止和删除；`ffprobe` 成功后才入队。`GET /jobs/{id}` 与 `DELETE /jobs/{id}` 采用相同 Origin/header 依赖。`/health` 仅返回 `{ service: "ok", ffmpegAvailable, model: "unloaded"|"ready"|"needs_setup" }`。

- [x] **Step 3: 提供可复现的 Windows 安装与启动脚本。**

  `setup-local-speaker-service.ps1` 使用 `Set-StrictMode -Version Latest`，检查 `py -3.12` 和 `ffmpeg`，在 `local-audio-service/.venv` 创建虚拟环境；随后按以下顺序执行，且绝不读取或输出 Hugging Face token：

  ```powershell
  & $python -m pip install --upgrade pip
  & $python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  & $python -m pip install -r "$serviceRoot/requirements.txt"
  ```

  `start-local-speaker-service.ps1` 只运行：

  ```powershell
  & "$serviceRoot/.venv/Scripts/python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8765
  ```

  `requirements.txt` 固定主依赖范围：`fastapi>=0.115,<1`、`uvicorn[standard]>=0.30,<1`、`python-multipart>=0.0.9,<1`、`pyannote.audio>=4,<5`。

- [x] **Step 4: 文档化模型授权、离线边界与不记录策略。**

  README 必须包含：接受 pyannote Community-1 模型条件和 `hf auth login` 的手动步骤；音频不离开本机、首次模型下载需要联网、模型和节目版权独立；不支持把 token 写进 `.env`、仓库或浏览器；端口仅用于回环地址；30 分钟/500MB 限制与取消/自动清理规则。

- [x] **Step 5: 忽略虚拟环境和临时目录，运行本地服务测试并提交。**

  在 `.gitignore` 加入：

  ```gitignore
  /local-audio-service/.venv/
  /local-audio-service/.speaker-jobs/
  __pycache__/
  ```

  Run: `py -3.12 -m unittest discover -s local-audio-service/tests -v`

  Expected: PASS。

  ```powershell
  git add local-audio-service scripts .gitignore
  git commit -m "feat: expose local speaker service"
  ```

### Task 6: 增加浏览器本地服务客户端与人工校正面板

**Files:**

- Create: `lib/local-speaker-client.ts`
- Create: `app/speaker-diarization-panel.tsx`
- Create: `tests/local-speaker-client.test.ts`
- Modify: `app/workspace.tsx`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: 为本地客户端写失败测试。**

  ```ts
  test("本地服务请求带专用请求头且不携带站点认证 cookie", async () => {
    let request: Request | undefined;
    globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ service: "ok", ffmpegAvailable: true, model: "ready" });
    };
    await getLocalSpeakerHealth();
    assert.equal(request?.url, "http://127.0.0.1:8765/health");
    assert.equal(request?.headers.get("x-speaker-client-version"), "1");
    assert.equal(request?.credentials, "omit");
  });
  ```

  再断言 `createLocalSpeakerJob` 使用 `FormData` 中的 `audio` 和 `expectedSpeakers`，不读取 File 的路径、不上传 markdown、不调用 `apiFetch`。

- [x] **Step 2: 实现 local-speaker-client。**

  固定默认 URL 为 `http://127.0.0.1:8765`，但允许构建时 `NEXT_PUBLIC_LOCAL_SPEAKER_URL` 覆盖。所有请求设置：

  ```ts
  headers: { "X-Speaker-Client-Version": "1" },
  credentials: "omit",
  cache: "no-store",
  ```

  导出 `getLocalSpeakerHealth`、`createLocalSpeakerJob`、`getLocalSpeakerJob`、`cancelLocalSpeakerJob`，并把服务的错误类别映射为中文、无敏感细节的 `Error`。不在日志中输出响应原文。

- [x] **Step 3: 创建面板并先连接 preview/save API。**

  `SpeakerDiarizationPanel` props：

  ```ts
  type SpeakerDiarizationPanelProps = {
    episode: { eid: string; durationSeconds: number | null; title: string };
    onSaved: (markdown: string) => void;
    reportNotice: (notice: { kind: "success" | "error" | "info"; text: string }) => void;
  };
  ```

  面板状态依次为 `idle → validating → uploading → diarizing → reviewing → saving`。`<input type="file">` 的 `accept` 明确列出八种格式；在 client 侧先检查 `file.size <= 500 * 1024 * 1024`，使用隐藏 `<audio preload="metadata">` 检查时长 `<= 1800` 秒，读取失败时交给本地服务二次校验。说话人数为“自动判断”或 1–8。没有服务时显示“运行 scripts/start-local-speaker-service.ps1”，不要假装云端处理。

  服务任务 `ready` 后将 `turns` POST 到 `/api/episodes/${eid}/speakers/preview`。预览中渲染所有待确认片段的 select（值为匿名 ID 或空值），以及每个说话人的标签 input；所有片段可通过“查看全部片段”展开后修正。确认保存 PUT 到 `/api/episodes/${eid}/speakers`，仅发送 `turns`、`labels`、`overrides`，成功后调用 `onSaved(markdown)`。

- [x] **Step 4: 将面板挂到文稿工具栏。**

  在 `workspace.tsx` 的 `document-actions` 中，在“下载 .md”后插入：

  ```tsx
  <SpeakerDiarizationPanel
    episode={selected}
    onSaved={(nextMarkdown) => { setMarkdown(nextMarkdown); setEditorMode("preview"); void loadEpisodes(); }}
    reportNotice={setNotice}
  />
  ```

  传入期间禁用“编辑 Markdown”“恢复原稿”“重新获取原稿”和删除按钮，避免并发覆盖；面板关闭或失败时解除禁用。

- [x] **Step 5: 添加静态 UI 回归和客户端测试。**

  在 `rendered-html.test.mjs` 断言 Workspace 引用 `SpeakerDiarizationPanel`、按钮包含“从本地音频识别说话人”、组件调用 `/speakers/preview` 与 `/speakers`，并且代码不包含 `apiFetch(LOCAL_SPEAKER` 或 `credentials: "include"`。

  Run: `node --experimental-strip-types --test tests/local-speaker-client.test.ts`

  Expected: PASS。

- [x] **Step 6: 提交客户端与面板。**

  ```powershell
  git add lib/local-speaker-client.ts app/speaker-diarization-panel.tsx app/workspace.tsx tests/local-speaker-client.test.ts tests/rendered-html.test.mjs
  git commit -m "feat: add local speaker review panel"
  ```

### Task 7: 完成预览样式、可读性与移动端处理

**Files:**

- Modify: `app/globals.css`
- Modify: `app/speaker-diarization-panel.tsx`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: 为可访问性和窄屏样式写失败断言。**

  ```js
  assert.match(styles, /\.speaker-diarization-modal\s*\{[^}]*max-height:/);
  assert.match(styles, /\.speaker-review-list\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.speaker-label-grid/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(panel, /aria-label="选择本地音频"/);
  ```

- [x] **Step 2: 实现有限、可取消且不会横向溢出的界面。**

  样式需要：模态框 `width: min(760px, calc(100vw - 28px))`、`max-height: min(780px, calc(100dvh - 28px))`；review 列表纵向滚动；标签和片段文字使用 `overflow-wrap:anywhere`；待确认徽标用文字加颜色，不只依赖颜色。进度显示明确阶段和百分比；处理中提供“取消本地任务”；确认保存前显示“音频不会上传，保存后将覆盖当前编辑稿”。

- [x] **Step 3: 构建并运行全量 Node 测试。**

  Run: `npm test`

  Expected: PASS，构建输出中出现 `/api/episodes/:eid/speakers` 和 `/api/episodes/:eid/speakers/preview`。

- [x] **Step 4: 提交样式。**

  ```powershell
  git add app/globals.css app/speaker-diarization-panel.tsx tests/rendered-html.test.mjs
  git commit -m "style: make speaker review responsive"
  ```

### Task 8: 端到端验证、文档收尾与提交前检查

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-24-audio-speaker-diarization-design.md`
- Modify: `docs/superpowers/plans/2026-08-24-audio-speaker-diarization-implementation.md`

- [x] **Step 1: 更新主 README 的可选本地服务说明。**

  在功能说明中增加“本地音频说话人分段（实验性）”；链接到 `local-audio-service/README.md`。明确说明需要用户有权处理音频、首次下载模型需要 Hugging Face token、音频不经本应用服务器、30 分钟/500MB 限制、输出是匿名说话人而非真实身份。

- [x] **Step 2: 运行全部自动化检查。**

  Run: `npm test`

  Expected: PASS。

  Run: `npm run lint`

  Expected: exit code 0。

  Run: `py -3.12 -m unittest discover -s local-audio-service/tests -v`

  Expected: PASS，且不下载 pyannote 模型。

- [x] **Step 3: 执行无真实模型的本地服务健康检查。**

  使用 `scripts/start-local-speaker-service.ps1` 启动服务（不创建任务、不下载模型）；随后执行：

  ```powershell
  curl.exe --noproxy "*" -H "Origin: http://localhost:3000" -H "X-Speaker-Client-Version: 1" http://127.0.0.1:8765/health
  ```

  Expected: `200` JSON，只有 service、ffmpegAvailable 和 model 字段。任务状态、取消与临时文件清理由 Task 4–5 的 FakeEngine 自动测试覆盖；本步骤禁止使用真实用户音频、账号、验证码、API Key 或 Hugging Face token。

- [ ] **Step 4: 执行用户授权音频的人工验收清单（不纳入仓库）。**

  先用 1–3 分钟两人中文对话验证：服务可连接、说话人标签出现、预览中可改名/改片段、保存后只有说话人轮次分段。随后测试 10 分钟；最后选择超过 30 分钟或超过 500MB 的文件，确认前端和服务端均拒绝。确认 `original.md` 未变、音频任务目录被删除、手动编辑过当前稿后保存返回 `409`。

- [x] **Step 5: 更新状态、检查差异并提交。**

  将设计文档状态更新为“已实现，待真实音频验收”，在本计划每项完成后勾选复选框。运行：

  ```powershell
  git diff --check
  git status --short
  git log --oneline -8
  ```

  Expected: 没有空白错误；仅包含本功能文件。

  ```powershell
  git add README.md docs/superpowers/specs/2026-08-24-audio-speaker-diarization-design.md docs/superpowers/plans/2026-08-24-audio-speaker-diarization-implementation.md
  git commit -m "docs: document local speaker diarization"
  ```

## 计划自审

- 规格覆盖：Task 1 提供 `transcript.json`；Task 2 覆盖对齐、60% 待确认和说话人轮次；Task 3 覆盖预览、保存、冲突和正文所有权；Task 4–5 覆盖 CPU 本地推理、30 分钟/500MB、取消、清理、CORS/PNA 与模型安装；Task 6–7 覆盖选择文件、人工修正、重命名、进度和移动端；Task 8 覆盖自动与人工验收、版权/隐私文档。
- 占位符检查：未使用 TBD、TODO 或“以后实现”作为实施步骤；Future 扩展仅保留在已确认的设计文档，不进入本计划。
- 类型一致性：本地服务返回 `DiarizationTurn`；preview/save 只传 `turns`、`labels`、`overrides`；服务端返回 `segments` 和服务器渲染的 `markdown`；持久化使用 v2 `TranscriptArtifact` 的 `speakerLayout.currentMarkdownHash`。
