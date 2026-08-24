# 长音频 GPU 说话人识别 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将本地说话人识别扩展到 2 小时/1GB，按 10 分钟窗口分块处理，并在 CUDA 可用时优先使用 GPU、失败时回退 CPU。

**Architecture:** 浏览器与 FastAPI 服务端共享 2 小时/1GB 校验；JobManager 继续负责上传、排队、取消和清理；Pyannote 引擎使用 torchcodec 按范围读取每个分块，给 pipeline 输入带绝对时间的分块结果，并按重叠区映射匿名说话人。设备选择独立封装，默认自动检测 CUDA。

**Tech Stack:** Next/Vinext + TypeScript、FastAPI、Python `torchcodec`、`pyannote.audio` Community-1、PyTorch CUDA/CPU wheels、Node test runner、Python unittest。

---

### Task 1: 扩大容量校验并锁定契约

**Files:**
- Modify: `local-audio-service/app/audio.py`
- Modify: `app/speaker-diarization-panel.tsx`
- Test: `local-audio-service/tests/test_audio.py`
- Test: `tests/local-speaker-client.test.ts`

- [x] **Step 1: Write failing tests**

  在 Python 音频测试中断言 `MAX_DURATION_MS == 2 * 60 * 60 * 1000`、`MAX_BYTES == 1 * 1024 * 1024 * 1024`，并增加一个刚好 2 小时的 probe 可通过、超过 2 小时被拒绝的测试。TypeScript 客户端测试断言错误文案包含“2 小时”和“1GB”。

- [x] **Step 2: Run tests and verify RED**

  Run: `& .\\local-audio-service\\.venv\\Scripts\\python.exe -m unittest local-audio-service/tests/test_audio.py -v` and `npm test -- --test-name-pattern='本地服务请求|创建本地任务'`.
  Expected: Python duration/size assertions fail against the existing 30-minute/500MB constants; TypeScript text assertion fails against the existing UI wording.

- [x] **Step 3: Implement minimal limit changes**

  Set the shared Python constants to 2 hours and 1GB, mirror the browser constants, and update the visible upload hint plus `localSpeakerErrorMessage` mappings without changing the upload protocol.

- [x] **Step 4: Run tests and verify GREEN**

  Re-run the two commands above; expected all selected tests pass.

### Task 2: Add a tested chunking contract

**Files:**
- Modify: `local-audio-service/app/engine.py`
- Modify: `local-audio-service/app/models.py`
- Test: `local-audio-service/tests/test_engine.py`

- [x] **Step 1: Write failing tests**

  Add a fake pipeline and fake range decoder. Test that a 25-minute input is processed as three core windows, outputs are converted to absolute milliseconds, overlap-only output is clipped out, local labels are mapped across an overlap, and progress is monotonic from 35 to 90. Test a decoder failure raises `DIARIZATION_FAILED` at the JobManager boundary rather than publishing partial segments.

- [x] **Step 2: Run the engine tests and verify RED**

  Run: `& .\\local-audio-service\\.venv\\Scripts\\python.exe -m unittest local-audio-service/tests/test_engine.py -v`.
  Expected: the new chunking tests fail because the current engine calls the pipeline once with the complete path and has no range decoder or global-speaker mapping.

- [x] **Step 3: Implement minimal chunking helpers**

  Introduce constants `CHUNK_DURATION_MS = 10 * 60 * 1000` and `CHUNK_OVERLAP_MS = 15 * 1000`. Add a small decoder protocol whose production implementation wraps `torchcodec.decoders.AudioDecoder.get_samples_played_in_range`. For each core window, decode only `[core_start-overlap, core_end+overlap]`, call the pipeline with `{"waveform": samples, "sample_rate": rate, "uri": unique_uri}`, translate local turns to absolute time, clip to the core window, and append valid turns.

- [x] **Step 4: Implement overlap speaker mapping**

  For each local label, sum temporal intersections with the previous global turns in the overlap region. Reuse the highest-overlap global ID when it has positive overlap and is not already assigned in the same chunk; otherwise allocate the next `speaker_N`. Keep the result anonymous and deterministic by first appearance.

- [x] **Step 5: Run engine tests and verify GREEN**

  Re-run `test_engine.py`; expected all old and new tests pass with no model download.

### Task 3: Make device selection automatic and GPU-safe

**Files:**
- Modify: `local-audio-service/app/engine.py`
- Modify: `local-audio-service/app/main.py`
- Modify: `local-audio-service/tests/test_engine.py`
- Modify: `local-audio-service/tests/test_main.py`

- [x] **Step 1: Write failing tests**

  Add tests with patched torch objects for `SPEAKER_DEVICE=auto`, `cpu`, and `cuda`: auto selects CUDA only when `torch.cuda.is_available()` is true; explicit CPU never moves the pipeline; unavailable CUDA falls back to CPU. Add a health test asserting the response contains only a safe `device` value (`cuda` or `cpu`).

- [x] **Step 2: Run tests and verify RED**

  Run: `& .\\local-audio-service\\.venv\\Scripts\\python.exe -m unittest local-audio-service/tests/test_engine.py local-audio-service/tests/test_main.py -v`.
  Expected: device-selection tests fail because the current engine only moves to CUDA when the environment is exactly `cuda`, and health has no device field.

- [x] **Step 3: Implement device selection**

  Add a safe device resolver with default `auto`; keep `cpu` as an explicit override. Load the pipeline once, try moving it to CUDA, and catch CUDA initialization/OOM errors to keep the pipeline on CPU. Expose a sanitized `device_status()` through `/health`.

- [x] **Step 4: Run tests and verify GREEN**

  Re-run the selected Python tests; expected all pass.

### Task 4: Update installation and startup behavior for CUDA

**Files:**
- Modify: `scripts/setup-local-speaker-service.ps1`
- Modify: `scripts/start-local-speaker-service.ps1`
- Modify: `local-audio-service/README.md`

- [x] **Step 1: Write a setup-script check**

  Add a PowerShell-level testable helper or static assertion that the setup script selects a CUDA wheel index when `nvidia-smi` is available and the CPU index otherwise, and that startup defaults `SPEAKER_DEVICE=auto` without overwriting an explicit user choice.

- [x] **Step 2: Run the check and verify RED**

  Run the script assertion against the current files; expected it fails because setup always uses the CPU index and startup does not set a device default.

- [x] **Step 3: Implement installation selection**

  Detect `nvidia-smi`, use the CUDA 12.8 PyTorch wheel index for NVIDIA hosts, use the CPU index otherwise, and force-replace an existing CPU-only torch installation when CUDA is selected. Keep an environment override `SPEAKER_TORCH_INDEX_URL` for recovery. Set `SPEAKER_DEVICE=auto` only when unset.

- [x] **Step 4: Update README**

  Document the MX450/2GB fallback expectation, the automatic device selection, the 2-hour/1GB limits, the 10-minute chunking, and the estimated processing-time caveat.

- [x] **Step 5: Verify script behavior**

  Run the PowerShell checks and `scripts/start-local-speaker-service.ps1 -WhatIf`-equivalent static checks without starting a second service; expected CUDA detection and explicit override behavior are correct.

### Task 5: Surface chunk progress in the browser

**Files:**
- Modify: `local-audio-service/app/jobs.py`
- Modify: `local-audio-service/app/main.py`
- Modify: `app/speaker-diarization-panel.tsx`
- Test: `local-audio-service/tests/test_jobs.py`
- Test: `tests/rendered-html.test.mjs`

- [x] **Step 1: Write failing tests**

  Add a JobManager test asserting a long job publishes increasing progress after each completed chunk and never publishes partial segments on cancellation. Add a rendered HTML assertion for the “第 N/M 块” progress wording.

- [x] **Step 2: Run tests and verify RED**

  Run the selected Python and Node tests; expected the new progress assertions fail because the current job model only exposes a single diarizing phase.

- [x] **Step 3: Implement progress fields**

  Pass a chunk-aware callback from the engine to JobManager, expose safe `chunkIndex`/`chunkCount` fields, and map them to the existing client polling payload. Keep the existing status values for compatibility.

- [x] **Step 4: Update the UI**

  Display “正在处理第 N/M 块” while diarizing, retain the percentage, and keep the current review/save flow unchanged.

- [x] **Step 5: Run tests and verify GREEN**

  Re-run selected tests; expected progress and cancellation assertions pass.

### Task 6: Install CUDA dependencies and run staged verification

**Files:**
- No production file changes; use the existing local virtual environment and test fixture.

- [ ] **Step 1: Reinstall the virtual environment’s torch packages**

  Run `scripts/setup-local-speaker-service.ps1` after confirming the CUDA wheel index is reachable. Verify with the venv Python that `torch.version.cuda` is non-null and `torch.cuda.is_available()` is true; if the MX450 cannot load the wheel, retain CPU fallback and report the exact reason.

  当前环境已确认存在 MX450，但 CUDA wheel 约 2.75GB 且下载速度过慢，本轮未强制替换稳定的 CPU 环境。服务实际以 `torch 2.11.0+cpu` 启动，并由 `SPEAKER_DEVICE=auto` 安全回退到 CPU。

- [x] **Step 2: Restart the service with the updated startup script**

  Stop only the loopback listener on port 8765, start the script once, and verify `/health` reports `service=ok`, `ffmpegAvailable=true`, and the sanitized device status.

- [x] **Step 3: Run automated verification**

  Run `& .\\local-audio-service\\.venv\\Scripts\\python.exe -m unittest discover -s local-audio-service/tests -p 'test_*.py' -v` and `npm test`; expected zero failures.

- [x] **Step 4: Run real short-audio verification**

  Submit the existing 5-minute fixture through `/jobs`, poll until `ready`, verify non-empty absolute segments and no `DIARIZATION_FAILED`, then leave the local service running for browser testing.

- [x] **Step 5: Record the staged limit decision**

  Do not claim 3-hour support until a 30–60 minute real run completes. Keep the public limit at 2 hours in this phase.
