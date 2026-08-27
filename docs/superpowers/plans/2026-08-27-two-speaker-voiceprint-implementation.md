# 两人声纹模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有全自动说话人识别的前提下，增加主持人/嘉宾参考片段驱动的本地两人声纹识别，并把结果安全对齐到已有小宇宙文稿。

**Architecture:** 浏览器在现有本地音频面板中选择模式和两个 5–30 秒参考区间；FastAPI 继续负责回环访问、流式上传、任务生命周期和 2 小时/1GB 校验。`JobManager` 根据任务模式调度现有 pyannote 引擎或新的 `VoiceprintEngine`；声纹引擎用轻量语音活动检测跳过静音，用 pyannote WeSpeaker 嵌入模型对两个参考中心做余弦相似度二分类，输出仍为 `speaker_0`/`speaker_1`。Cloudflare 侧继续只接受时间区间，服务器从官方 artifact 重建 Markdown，不信任客户端正文。

**Tech Stack:** React 19 + TypeScript + Vinext、FastAPI/Uvicorn、Python `torch`/`torchcodec`/`pyannote.audio`、Hugging Face WeSpeaker 模型、PowerShell、Node `node:test`、Python `unittest`。

---

## 文件结构与职责

| 路径 | 职责 |
| --- | --- |
| `local-audio-service/app/models.py` | 定义任务模式、参考区间、快照和任务值对象。 |
| `local-audio-service/app/voiceprint.py` | 纯参考区间校验、声纹窗口/相似度/平滑算法；不依赖 HTTP。 |
| `local-audio-service/app/engine.py` | 复用音频解码和设备选择，保留 Community-1，引入可注入的 `VoiceprintEngine`。 |
| `local-audio-service/app/jobs.py` | 保存模式和参考区间，并把任务调度到对应引擎。 |
| `local-audio-service/app/main.py` | 解析 multipart 模式与参考区间、服务端二次校验、健康状态和安全错误。 |
| `local-audio-service/tests/test_voiceprint.py` | 参考区间和声纹纯函数、低置信度和平滑测试。 |
| `local-audio-service/tests/test_engine.py`、`test_jobs.py`、`test_main.py` | 新引擎、调度和 HTTP 回归测试。 |
| `lib/voiceprint.ts` | 浏览器端参考范围的纯校验和标签常量。 |
| `lib/local-speaker-client.ts` | 声纹任务字段、健康状态和错误码解析。 |
| `lib/transcript-artifact.ts`、`lib/speaker-markdown.ts` | 扩展引擎来源并写入声纹来源元数据。 |
| `app/api/episodes/[eid]/speakers/preview/route.ts`、`route.ts` | 接受受限引擎/标签，预览和保存仍以服务器官方正文为源。 |
| `app/speaker-diarization-panel.tsx`、`app/globals.css` | 模式选择、播放器、参考区间表单和响应式提示。 |
| `tests/local-speaker-client.test.ts`、`tests/voiceprint.test.ts`、`tests/rendered-html.test.mjs`、`tests/core.test.ts` | 客户端协议、UI 静态回归和路由保存安全性。 |
| `local-audio-service/README.md`、`README.md` | 安装、模型授权、两人模式使用和隐私说明。 |

## 任务 1：建立后端模式与参考区间契约

**Files:**

- Modify: `local-audio-service/app/models.py`
- Create: `local-audio-service/app/voiceprint.py`
- Test: `local-audio-service/tests/test_voiceprint.py`

- [ ] **Step 1: 写失败测试（RED）**

在 `test_voiceprint.py` 加入以下行为测试：

```python
class VoiceprintValidationTests(unittest.TestCase):
    def test_accepts_exactly_two_non_overlapping_10_to_30_second_references(self):
        refs = parse_voiceprint_references(json.dumps({
            "speaker_0": {"startMs": 0, "endMs": 10_000},
            "speaker_1": {"startMs": 20_000, "endMs": 50_000},
        }))
        self.assertEqual(refs, (
            VoiceprintReference("speaker_0", 0, 10_000),
            VoiceprintReference("speaker_1", 20_000, 50_000),
        ))

    def test_rejects_missing_speaker_overlap_short_long_and_out_of_range_references(self):
        cases = [
            {"speaker_0": {"startMs": 0, "endMs": 10_000}},
            {"speaker_0": {"startMs": 0, "endMs": 10_000}, "speaker_1": {"startMs": 5_000, "endMs": 20_000}},
            {"speaker_0": {"startMs": 0, "endMs": 9_999}, "speaker_1": {"startMs": 20_000, "endMs": 30_000}},
            {"speaker_0": {"startMs": 0, "endMs": 30_001}, "speaker_1": {"startMs": 40_000, "endMs": 50_000}},
            {"speaker_0": {"startMs": 0, "endMs": 10_000}, "speaker_1": {"startMs": 55_000, "endMs": 65_000}},
        ]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaisesRegex(VoiceprintInputError, "VOICEPRINT_REFERENCES_INVALID"):
                    refs = parse_voiceprint_references(json.dumps(value))
                    validate_voiceprint_reference_bounds(refs, duration_ms=60_000)
```

导入 `json`、`parse_voiceprint_references`、`VoiceprintInputError` 和 `VoiceprintReference`。测试只验证公开行为，不依赖模型。

- [ ] **Step 2: 运行 RED 并确认失败原因**

Run:

```powershell
& .\local-audio-service\.venv\Scripts\python.exe -m unittest local-audio-service/tests/test_voiceprint.py -v
```

Expected: FAIL，提示新类型或解析函数不存在；如果测试发生导入错误，先修正测试导入路径，直到失败原因是功能缺失。

- [ ] **Step 3: 实现最小契约**

在 `models.py` 增加：

```python
JobMode = Literal["diarization", "voiceprint"]

@dataclass(frozen=True)
class VoiceprintReference:
    speaker_id: str
    start_ms: int
    end_ms: int
```

在 `voiceprint.py` 定义 `MIN_REFERENCE_MS = 5_000`、`MAX_REFERENCE_MS = 30_000`，以及 `VoiceprintInputError`。`parse_voiceprint_references(value)` 只做结构校验：解析 JSON 对象；键集合恰好为 `speaker_0`、`speaker_1`；每个值只接受非负整数 `startMs`/`endMs`；持续时间在 5–30 秒；两段不重叠。另定义 `validate_voiceprint_reference_bounds(references, duration_ms)`，在 `ffprobe` 得到实际时长后检查结束时间不超过音频时长。两类失败都抛出 `VoiceprintInputError("VOICEPRINT_REFERENCES_INVALID")`，不能把原始 JSON、文件名或路径放进异常文本。

- [ ] **Step 4: 运行 GREEN 并提交**

Run 同一 `unittest` 命令，Expected: 所有参考区间测试 PASS。

```powershell
git add local-audio-service/app/models.py local-audio-service/app/voiceprint.py local-audio-service/tests/test_voiceprint.py
git commit -m "feat: define two-speaker voiceprint contract"
```

## 任务 2：实现纯声纹分类、低置信度和时间平滑

**Files:**

- Modify: `local-audio-service/app/voiceprint.py`
- Test: `local-audio-service/tests/test_voiceprint.py`

- [ ] **Step 1: 写失败测试（RED）**

在同一测试文件加入：

```python
class VoiceprintMathTests(unittest.TestCase):
    def test_classifies_nearest_reference_and_leaves_low_margin_unknown(self):
        centers = {
            "speaker_0": [1.0, 0.0],
            "speaker_1": [0.0, 1.0],
        }
        self.assertEqual(classify_embedding([0.98, 0.02], centers, min_similarity=0.7, min_margin=0.1), "speaker_0")
        self.assertEqual(classify_embedding([0.5, 0.5], centers, min_similarity=0.7, min_margin=0.1), None)

    def test_merges_only_stable_adjacent_windows_and_drops_unknown_windows(self):
        windows = [
            (0, 1_500, "speaker_0"), (750, 2_250, "speaker_0"),
            (1_500, 3_000, None), (2_250, 3_750, "speaker_1"),
            (3_000, 4_500, "speaker_1"),
        ]
        self.assertEqual(merge_labeled_windows(windows, hop_ms=750, min_turn_ms=750), [
            DiarizationTurn(0, 2_250, "speaker_0"),
            DiarizationTurn(2_250, 4_500, "speaker_1"),
        ])
```

- [ ] **Step 2: 运行 RED**

Run:

```powershell
& .\local-audio-service\.venv\Scripts\python.exe -m unittest local-audio-service/tests/test_voiceprint.py -v
```

Expected: 新的 `classify_embedding` 或 `merge_labeled_windows` 未定义而失败。

- [ ] **Step 3: 实现纯函数**

在 `voiceprint.py` 增加 `DiarizationTurn` 导入、L2 归一化、余弦相似度和以下接口：

```python
def classify_embedding(
    embedding: Sequence[float],
    centers: Mapping[str, Sequence[float]],
    *,
    min_similarity: float,
    min_margin: float,
) -> str | None:
    raise NotImplementedError

def merge_labeled_windows(
    windows: Sequence[tuple[int, int, str | None]],
    *,
    hop_ms: int,
    min_turn_ms: int,
) -> list[DiarizationTurn]:
    raise NotImplementedError
```

`classify_embedding` 只接受两个中心，先归一化后取余弦相似度；最高分低于 `min_similarity` 或最高/次高差值低于 `min_margin` 返回 `None`。`merge_labeled_windows` 把每个滑窗按中心/hop 转成不重叠标签，未知窗不产生标签；相邻同标签合并，持续时间小于 `min_turn_ms` 的孤立段并入相邻稳定标签或丢弃，最终按起点排序且不重叠。

- [ ] **Step 4: 运行 GREEN 并提交**

Run 同一 `unittest` 命令，Expected: 参考校验和声纹数学测试全部 PASS。

```powershell
git add local-audio-service/app/voiceprint.py local-audio-service/tests/test_voiceprint.py
git commit -m "feat: add voiceprint classification smoothing"
```

## 任务 3：接入 WeSpeaker 嵌入和分块处理

**Files:**

- Modify: `local-audio-service/app/engine.py`
- Modify: `local-audio-service/tests/test_engine.py`
- Modify: `local-audio-service/tests/test_voiceprint.py`

- [ ] **Step 1: 写失败测试（RED）**

增加可注入的 fake VAD/encoder，验证 `VoiceprintEngine.identify`：

```python
def test_voiceprint_identify_uses_reference_centers_and_absolute_chunk_times(self):
    engine = VoiceprintEngine(vad=FakeVAD(), encoder=FakeEncoder())
    with patch("app.engine.probe_duration_ms", return_value=25 * 60 * 1000), \
         patch("app.engine._decode_audio_range", return_value=RangeSamples()):
        turns = engine.identify(Path("sample.wav"), (
            VoiceprintReference("speaker_0", 0, 10_000),
            VoiceprintReference("speaker_1", 20_000, 30_000),
        ), lambda _: None)
    self.assertTrue(turns)
    self.assertEqual(turns, sorted(turns, key=lambda turn: turn.start_ms))
    self.assertTrue(all(turn.end_ms > turn.start_ms for turn in turns))
    self.assertTrue({turn.speaker_id for turn in turns} <= {"speaker_0", "speaker_1"})
```

Fake encoder 必须为参考窗和正文窗返回可区分的二维向量；Fake VAD 返回带相对毫秒的语音窗口。另加模型加载缺失 token 时抛 `ModelSetupError("HF_TOKEN_MISSING")`，低置信度全部为空时抛 `ModelSetupError("VOICEPRINT_LOW_CONFIDENCE")`。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
& .\local-audio-service\.venv\Scripts\python.exe -m unittest local-audio-service/tests/test_engine.py local-audio-service/tests/test_voiceprint.py -v
```

Expected: `VoiceprintEngine`、`identify` 或注入接口不存在而失败。

- [ ] **Step 3: 实现生产编码器和轻量 VAD**

在 `engine.py` 增加 `VoiceprintEngine` 和两个协议：

```python
class VoiceprintEncoder(Protocol):
    def embed(self, waveforms: Sequence[object], sample_rate: int) -> list[list[float]]:
        raise NotImplementedError

class SpeechActivityDetector(Protocol):
    def detect(self, waveform: object, sample_rate: int) -> list[tuple[int, int]]:
        raise NotImplementedError
```

默认编码器延迟导入 `pyannote.audio.Model`，使用 `Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM", token=token)`；把模型移到现有 `SPEAKER_DEVICE` 选择的设备，在 `torch.inference_mode()` 中批量前向，处理 tuple/帧维输出后做 L2 归一化。默认 VAD 使用 30ms RMS 能量帧、相对阈值、短间隙合并和最短语音段过滤，不引入 ASR；VAD 通过协议可替换。

`identify` 先解码并检测两个参考区间，要求每个至少有 3 秒有效语音；将有效语音切成约 1.5 秒窗口并建立两个中心。随后按 `CHUNK_DURATION_MS`/`CHUNK_OVERLAP_MS` 解码正文，VAD 后以 1.5 秒窗口、750ms hop 提取嵌入，调用纯函数分类和平滑，裁剪到核心窗口。只返回不重叠的 `DiarizationTurn`；如果没有任何稳定标签，抛 `VOICEPRINT_LOW_CONFIDENCE`。进度从 35 开始，按块递增到 90。

- [ ] **Step 4: 运行 GREEN 并回归**

Run:

```powershell
& .\local-audio-service\.venv\Scripts\python.exe -m unittest local-audio-service/tests/test_engine.py local-audio-service/tests/test_voiceprint.py -v
```

Expected: fake 引擎测试和原有 pyannote 测试全部 PASS，且不会下载真实模型。

- [ ] **Step 5: 提交引擎**

```powershell
git add local-audio-service/app/engine.py local-audio-service/tests/test_engine.py local-audio-service/tests/test_voiceprint.py
git commit -m "feat: add two-speaker voiceprint engine"
```

## 任务 4：扩展 JobManager、FastAPI 和健康协议

**Files:**

- Modify: `local-audio-service/app/models.py`
- Modify: `local-audio-service/app/jobs.py`
- Modify: `local-audio-service/app/main.py`
- Modify: `local-audio-service/tests/test_jobs.py`
- Modify: `local-audio-service/tests/test_main.py`

- [ ] **Step 1: 写失败测试（RED）**

在任务测试中加入 `FakeVoiceprintEngine.identify`，断言声纹任务调度、快照模式和错误码：

```python
def test_voiceprint_job_dispatches_references_to_voiceprint_engine(self):
    manager = JobManager(root=root, engine=FakeEngine(), voiceprint_engine=FakeVoiceprintEngine())
    job = manager.create_job(None, mode="voiceprint", references=references)
    source = manager.upload_path(job.id, ".wav")
    source.write_bytes(b"audio")
    manager.queue(job.id, source, duration_ms=2_000)
    manager.run(job.id)
    self.assertEqual(manager.snapshot(job.id).mode, "voiceprint")
    self.assertEqual(manager.snapshot(job.id).segments[0].speaker_id, "speaker_0")
```

在 `test_main.py` 用 TestClient 发送 `mode=voiceprint`、合法 `references` 和 fake `validate_audio_file`，断言 202、响应查询中的 `mode`，并为缺失/重叠/越界参考断言 422 `VOICEPRINT_REFERENCES_INVALID`。更新健康测试，断言新增字段只包含安全枚举状态，不含 token、路径或文件名。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
& .\local-audio-service\.venv\Scripts\python.exe -m unittest local-audio-service/tests/test_jobs.py local-audio-service/tests/test_main.py -v
```

Expected: `JobManager` 不接受模式/参考参数，FastAPI 不解析新字段而失败。

- [ ] **Step 3: 实现任务模式与服务端解析**

扩展 `Job`/`JobSnapshot` 的 `mode` 和可选 `references`，`create_job` 保持旧的 `create_job(expected_speakers)` 调用兼容，同时接受关键字 `mode`、`references`。`run` 在 `mode == "voiceprint"` 时调用 `voiceprint_engine.identify(source_path, references, on_progress)`，普通模式仍调用 `engine.diarize`；两种引擎的模型错误原样保留安全错误码，通用异常分别归一化为 `VOICEPRINT_FAILED`/`DIARIZATION_FAILED`。

`main.py` 增加 `_parse_mode` 和 multipart `references` 字段：模式默认为 `diarization`，声纹模式先用 `parse_voiceprint_references` 做结构校验，写入文件后在 `validate_audio_file` 得到实际时长，再调用 `validate_voiceprint_reference_bounds`；任何失败都先 discard 任务目录。响应 payload 增加 `mode`，区间结构不变。生产 `create_app` 同时创建两个引擎；健康接口保留 `model`/`device`，增加 `voiceprintModel`/`voiceprintDevice` 两个安全枚举字段。

- [ ] **Step 4: 运行 GREEN 并提交**

Run 两个 Python 测试文件，Expected: 新旧任务、HTTP 安全和清理测试全部 PASS。

```powershell
git add local-audio-service/app/models.py local-audio-service/app/jobs.py local-audio-service/app/main.py local-audio-service/tests/test_jobs.py local-audio-service/tests/test_main.py
git commit -m "feat: route voiceprint jobs through local service"
```

## 任务 5：扩展浏览器客户端、artifact 和 Markdown 来源

**Files:**

- Create: `lib/voiceprint.ts`
- Modify: `lib/local-speaker-client.ts`
- Modify: `lib/transcript-artifact.ts`
- Modify: `lib/speaker-markdown.ts`
- Modify: `app/api/episodes/[eid]/speakers/preview/route.ts`
- Modify: `app/api/episodes/[eid]/speakers/route.ts`
- Test: `tests/voiceprint.test.ts`
- Test: `tests/local-speaker-client.test.ts`
- Test: `tests/transcript-artifact.test.ts`
- Test: `tests/speaker-markdown.test.ts`
- Modify: `tests/core.test.ts`

- [ ] **Step 1: 写失败测试（RED）**

在 `tests/voiceprint.test.ts` 规定浏览器端范围校验：开始/结束均为有限非负整数毫秒、5–30 秒、在给定时长内、两段不重叠；错误返回中文而不是抛出异常。在客户端测试中断言声纹 multipart 包含 `mode=voiceprint` 和 JSON `references`，旧模式字段仍存在。增加 artifact/Markdown 测试：`pyannote-wespeaker-voiceprint-v1` 可解析，并写入 `speaker_source`。

在 `tests/core.test.ts` 的预览/保存路由场景中传递：

```json
{"engine":"pyannote-wespeaker-voiceprint-v1","labels":[
  {"id":"speaker_0","label":"主持人"},
  {"id":"speaker_1","label":"嘉宾"}
]}
```

断言 preview 使用传入标签，save 的 `speakerLayout.engine` 和 Markdown 来源均为声纹值，且仍忽略客户端 `markdown`。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --experimental-strip-types --test tests/voiceprint.test.ts tests/local-speaker-client.test.ts tests/transcript-artifact.test.ts tests/speaker-markdown.test.ts tests/core.test.ts
```

Expected: 新模块、模式字段和声纹引擎值尚不存在而失败。

- [ ] **Step 3: 实现客户端与纯校验**

在 `lib/voiceprint.ts` 导出 `VoiceprintReferences`、`validateVoiceprintReferences(references, durationMs): string | null` 和 `VOICEPRINT_LABELS`。在 `local-speaker-client.ts` 增加 `LocalSpeakerMode`、参考类型、可选健康字段和 `mode` 解析；`createLocalSpeakerJob(file, options)` 使用 FormData 写入 `mode`、`expectedSpeakers`（全自动）和 `references`（声纹），所有请求继续 `credentials: "omit"`。

错误映射增加：`VOICEPRINT_REFERENCES_INVALID`、`VOICEPRINT_MODEL_UNAVAILABLE`、`VOICEPRINT_LOW_CONFIDENCE`、`VOICEPRINT_FAILED`，不返回服务端原始异常文本。

- [ ] **Step 4: 实现 artifact、Markdown 和路由引擎来源**

将 `SpeakerLayout.engine` 扩展为：

```ts
"pyannote-community-1" | "pyannote-wespeaker-voiceprint-v1"
```

`renderSpeakerMarkdown` 增加受限的 `engine` 参数并按值写入 frontmatter；缺省值保持 `pyannote-community-1`。preview/save 路由只接受这两个值，调用 `normalizeSpeakerLabels` 后再渲染；保存时在 artifact 中写入收到的受限引擎，不接受任意字符串。

- [ ] **Step 5: 运行 GREEN 并提交**

Run 同一 Node 命令，Expected: 所有客户端、artifact、Markdown 和路由测试 PASS。

```powershell
git add lib/voiceprint.ts lib/local-speaker-client.ts lib/transcript-artifact.ts lib/speaker-markdown.ts app/api/episodes/[eid]/speakers tests/voiceprint.test.ts tests/local-speaker-client.test.ts tests/transcript-artifact.test.ts tests/speaker-markdown.test.ts tests/core.test.ts
git commit -m "feat: persist voiceprint speaker source"
```

## 任务 6：实现前端模式选择、参考试听和校验

**Files:**

- Modify: `app/speaker-diarization-panel.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `tests/voiceprint.test.ts`

- [ ] **Step 1: 写失败测试（RED）**

在静态测试中断言面板包含：`两人声纹`、`主持人参考`、`嘉宾参考`、`audio controls`、`validateVoiceprintReferences`、`mode: "voiceprint"`、`references`，并断言关闭/重选文件会释放对象 URL。纯函数测试覆盖空范围、超过时长和重叠范围的中文错误。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --experimental-strip-types --test tests/rendered-html.test.mjs tests/voiceprint.test.ts
```

Expected: 组件尚未出现声纹模式和参考字段而失败。

- [ ] **Step 3: 实现最小 UI 流程**

在 `SpeakerDiarizationPanel` 增加 `mode`、`referenceRanges`、`audioUrl` 和 `audioDurationMs` 状态。文件选中后读取时长并创建对象 URL；重选、关闭和组件卸载都调用 `URL.revokeObjectURL`。模式为 `voiceprint` 时显示 `<audio controls preload="metadata">`、四个秒数输入和清晰提示；输入值换算为毫秒后调用 `validateVoiceprintReferences`，失败时不请求本地服务。

`start` 为全自动模式沿用 `expectedSpeakers`；声纹模式先做浏览器校验，再调用客户端的 `createLocalSpeakerJob`。轮询逻辑不变，ready 后以声纹默认标签调用 preview。保存请求增加受限 `engine`，仍只发送 `turns`、`labels`、`overrides` 和引擎值，不发送音频、正文或参考文件。

- [ ] **Step 4: 样式和可访问性**

沿用现有模态框和移动端规则，给播放器、参考表格和提示增加窄屏布局；所有输入有可见 label，错误使用 `role="alert"`，进度和模型错误继续 `aria-live="polite"`。开始按钮在文件、时长和参考范围未满足前显示可点击但会给出具体错误，避免静默无反应。

- [ ] **Step 5: 运行 GREEN 并提交**

Run:

```powershell
node --experimental-strip-types --test tests/rendered-html.test.mjs tests/voiceprint.test.ts tests/local-speaker-client.test.ts
```

Expected: UI 静态断言、校验和客户端协议测试 PASS。

```powershell
git add app/speaker-diarization-panel.tsx app/globals.css tests/rendered-html.test.mjs tests/voiceprint.test.ts
git commit -m "feat: add two-speaker voiceprint controls"
```

## 任务 7：更新安装/使用文档并完成回归

**Files:**

- Modify: `local-audio-service/README.md`
- Modify: `README.md`
- Modify: `local-audio-service/requirements.txt`（仅在实现采用新的 VAD 包时添加锁定范围；首版能量 VAD 不新增依赖）
- Modify: `docs/superpowers/specs/2026-08-26-two-speaker-voiceprint-design.md`

- [ ] **Step 1: 文档测试先行**

在 `tests/rendered-html.test.mjs` 增加静态断言：两份 README 都说明两人模式需要已有文稿、两段 5–30 秒参考、低置信度人工确认、模型首次下载需要 Hugging Face 登录、音频只在本机处理和全自动模式仍可回退。

- [ ] **Step 2: 更新文档**

在本地服务 README 增加实际操作步骤：启动服务后在页面选择“两人声纹”，播放器中找到干净片段并填写主持人/嘉宾开始结束秒数；说明每段为 5–30 秒（推荐 8–10 秒以上）、两段不能重叠、参考应避免音乐和多人抢话；解释 `voiceprintModel`/`voiceprintDevice` 健康字段和低置信度提示。主 README 只做功能入口和隐私/版权边界说明。

- [ ] **Step 3: 运行 Python 回归**

Run:

```powershell
& .\local-audio-service\.venv\Scripts\python.exe -m unittest discover -s local-audio-service/tests -p 'test_*.py' -v
```

Expected: 所有 Python 测试 PASS，不下载模型、不输出 token、路径或音频正文。

- [ ] **Step 4: 运行 Node 构建、测试和 lint**

Run:

```powershell
npm test
npm run lint
```

Expected: 构建退出码 0，Node 测试零失败，lint 退出码 0。

- [ ] **Step 5: 记录规格与提交前检查**

在规格文档中补充已实现的实际模型加载状态和待人工基准项；运行：

```powershell
git diff --check
git status --short
git log --oneline -10
```

Expected: 无空白错误；工作树只包含本功能已提交的内容。提交文档：

```powershell
git add README.md local-audio-service/README.md docs/superpowers/specs/2026-08-26-two-speaker-voiceprint-design.md
git commit -m "docs: document two-speaker voiceprint mode"
```

## 任务 8：真实短音频基准与回退验证

**Files:**

- No additional production file changes unless a measured bug is found; bug fixes must add a failing regression test first.

- [ ] **Step 1: 启动并检查健康状态**

在声纹分支工作树运行 `scripts/start-local-speaker-service.ps1`，使用允许 Origin 和客户端版本头访问 `/health`。确认 `service=ok`、`ffmpegAvailable=true`，并记录声纹模型在首次加载前的安全状态；不把 token 或绝对路径写入日志。

- [ ] **Step 2: 用 5 分钟双人音频做声纹模式验收**

在页面选择现有 5 分钟双人音频，各选 5–30 秒干净参考（推荐 8–10 秒以上），完成识别和预览。记录总耗时、设备、显存、输出区间、待确认数量和人工修正数量；确认保存后的 `speaker_source` 是声纹值、`original.md` 未变、当前稿哈希保护仍生效。

- [ ] **Step 3: 对比全自动模式**

用相同音频运行全自动模式，比较处理时间和错分/待确认数量。若声纹模式无稳定输出或明显劣于全自动，只调整已覆盖测试的阈值/VAD；不在未验证时宣称固定倍速。

- [ ] **Step 4: 验证边界和清理**

用超过 2 小时或 1GB 的文件确认浏览器和服务端均在开始推理前拒绝；取消任务后确认结果不发布，任务目录在清理周期后消失。用手动改过的当前稿确认保存返回 409，不覆盖用户内容。

- [ ] **Step 5: 最终差异检查**

Run:

```powershell
git diff --check
git status --short --branch
git show --stat --oneline HEAD
```

只有在命令输出确认无未提交修改、自动测试通过且人工基准记录完整后，才能声称本功能完成；否则在分支上保留实际失败信息并继续修复。

## 计划自审

- **规格覆盖：** 任务 1 覆盖模式/参考区间和服务端二次校验；任务 2–3 覆盖嵌入、VAD、二分类、低置信度、平滑、分块和 CUDA；任务 4 覆盖任务调度、HTTP 错误和健康兼容；任务 5 覆盖 artifact、Markdown 来源和服务器正文所有权；任务 6 覆盖播放器、参考输入、模式切换、可访问性和对象 URL 清理；任务 7–8 覆盖文档、自动回归、真实基准、容量边界、取消和回退。
- **占位符扫描：** 计划中的“未来”只描述已确认的替换接口，不作为未定义实施步骤；每个实施步骤都有明确文件、命令和预期结果。
- **类型一致性：** Python 使用 `VoiceprintReference`、`JobMode`、`VoiceprintEngine.identify`；TypeScript 使用 `VoiceprintReferences`、`LocalSpeakerMode` 和受限 `SpeakerLayout.engine`；服务端和客户端统一 `speaker_0`/`speaker_1`、`mode`、`references` 字段。
- **TDD 顺序：** 每个生产改动任务先写一个可执行失败测试并确认 RED，再写最小实现并确认 GREEN；发现真实 bug 时遵循同样顺序。
