# 两人声纹 5 秒参考片段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将两人声纹参考片段的最低长度从 10 秒统一调整为 5 秒，同时保留 30 秒上限和低置信度人工复核。

**Architecture:** 浏览器端和本地 FastAPI 服务继续共享同一时间区间契约，只改变最小持续时间常量和用户提示。声纹模型、任务协议、存储格式和识别链路保持不变。

**Tech Stack:** React/TypeScript、Python/FastAPI、Node test runner、Python unittest、Markdown 文档。

---

### Task 1: 先写 5 秒边界回归测试

**Files:**
- Modify: `tests/voiceprint.test.ts`
- Modify: `local-audio-service/tests/test_voiceprint.py`

- [ ] **Step 1: 将最小有效案例改为 5 秒，并把过短案例改为 4.999 秒。**

- [ ] **Step 2: 运行两份边界测试，确认当前 10 秒实现失败。**

```powershell
node --experimental-strip-types --test tests/voiceprint.test.ts
& 'E:\vibe-coding\小宇宙-逐字稿\shengjian-xiaoyuzhou-main\.worktrees\audio-speaker-diarization\local-audio-service\.venv\Scripts\python.exe' -m unittest local-audio-service/tests/test_voiceprint.py -v
```

Expected: 新增的 5 秒有效案例在旧实现下失败，失败原因是仍要求至少 10 秒。

### Task 2: 同步实现、提示和文档

**Files:**
- Modify: `lib/voiceprint.ts`
- Modify: `local-audio-service/app/voiceprint.py`
- Modify: `app/speaker-diarization-panel.tsx`
- Modify: `lib/local-speaker-client.ts`
- Modify: `README.md`
- Modify: `local-audio-service/README.md`
- Modify: `docs/superpowers/specs/2026-08-26-two-speaker-voiceprint-design.md`
- Modify: `docs/superpowers/plans/2026-08-27-two-speaker-voiceprint-implementation.md`

- [ ] **Step 1: 把 TypeScript 和 Python 最小常量统一设为 5,000ms。**
- [ ] **Step 2: 将浏览器、客户端错误和两个 README 的范围提示统一改为 5–30 秒，并说明 8–10 秒更稳妥。**
- [ ] **Step 3: 同步规格和实现计划中的契约描述，避免后续文档回退到 10 秒。**

### Task 3: 验证并提交

- [ ] **Step 1: 重跑边界测试，确认 5 秒通过且小于 5 秒仍拒绝。**
- [ ] **Step 2: 运行 `npm test`、`npm run lint`、`npx tsc --noEmit` 和完整 Python 测试。**
- [ ] **Step 3: 检查 `git diff --check`，确认未纳入 `.env.local` 或凭据。**
- [ ] **Step 4: 提交修改并重载正在运行的本地网页。**

