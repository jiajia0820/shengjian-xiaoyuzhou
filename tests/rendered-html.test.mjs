import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the 声笺 product surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /声笺/);
  assert.match(html, /正在打开声笺/);
  assert.doesNotMatch(html, /登录配置中|独立邮箱登录即将开放/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("packages Sites persistence metadata and migration", async () => {
  const hosting = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, "DOCUMENTS");
  await access(new URL("../dist/.openai/drizzle/0000_spooky_zarek.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0001_outstanding_lord_hawal.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0002_charming_edwin_jarvis.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0003_neat_chronomancer.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0004_quick_madame_web.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0005_amused_speedball.sql", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("stores a transcript.json sidecar beside each episode document", async () => {
  const documents = await readFile(new URL("../lib/documents.ts", import.meta.url), "utf8");
  assert.match(documents, /transcriptKey: `\$\{base\}\/transcript\.json`/);
});

test("wires a local-only speaker review panel into the transcript toolbar", async () => {
  const [workspace, panel, client, styles] = await Promise.all([
    readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/speaker-diarization-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-speaker-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /SpeakerDiarizationPanel/);
  assert.match(panel, /从本地音频识别说话人/);
  assert.match(panel, /aria-label="选择本地音频"/);
  assert.match(panel, /\/speakers\/preview/);
  assert.match(panel, /\/speakers`/);
  assert.match(panel, /const \[turns, setTurns\] = useState<LocalSpeakerTurn\[\]>\(\[\]\)/);
  assert.match(panel, /setTurns\(current\.segments\)/);
  assert.match(panel, /JSON\.stringify\(\{ turns, labels, overrides/);
  assert.match(panel, /音频不会上传/);
  assert.match(panel, /取消本地任务/);
  assert.match(styles, /\.speaker-diarization-modal\s*\{[^}]*max-height:/);
  assert.match(styles, /\.speaker-review-list\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.speaker-label-grid/);
  assert.match(panel, /aria-live="polite"/);
  assert.doesNotMatch(panel, /apiFetch\(LOCAL_SPEAKER/);
  assert.doesNotMatch(client, /credentials:\s*["']include["']/);
});

test("shows chunk progress for long local speaker jobs", async () => {
  const panel = await readFile(new URL("../app/speaker-diarization-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /第 \$\{chunkIndex\}\/\$\{chunkCount\} 块/);
});

test("selects CUDA packages when an NVIDIA GPU is available", async () => {
  const [setup, start] = await Promise.all([
    readFile(new URL("../scripts/setup-local-speaker-service.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-local-speaker-service.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(setup, /nvidia-smi/);
  assert.match(setup, /SPEAKER_TORCH_INDEX_URL/);
  assert.match(setup, /cu128/);
  assert.match(setup, /download\.pytorch\.org\/whl\/cpu/);
  assert.match(start, /SPEAKER_DEVICE/);
  assert.match(start, /auto/);
});

test("keeps browser auth same-origin and packages the Hong Kong gateway", async () => {
  const authShell = await readFile(new URL("../app/auth-shell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(authShell, /supabase\.co|challenges\.cloudflare\.com|turnstile/i);
  assert.doesNotMatch(authShell, /TencentCaptcha|turing\.captcha|auth\/otp|绑定管理员邮箱|邮箱登录/i);
  await assert.rejects(access(new URL("../app/api/auth/otp/send/route.ts", import.meta.url)));
  await assert.rejects(access(new URL("../app/api/auth/otp/verify/route.ts", import.meta.url)));
  await assert.rejects(access(new URL("../app/api/auth/refresh/route.ts", import.meta.url)));
  await assert.rejects(access(new URL("../app/api/auth/bootstrap/route.ts", import.meta.url)));

  const caddyfile = await readFile(new URL("../deploy/tencent-hk/Caddyfile", import.meta.url), "utf8");
  assert.match(caddyfile, /X-Origin-Gateway-Token/);
  assert.match(caddyfile, /health_uri \/api\/health/);
  assert.doesNotMatch(caddyfile, /^\s*log\s*\{/m);
  await access(new URL("../deploy/tencent-hk/compose.yaml", import.meta.url));
  await access(new URL("../deploy/tencent-hk/env.example", import.meta.url));
});

test("rejects direct origin requests after gateway protection is enabled", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("gateway-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = {
    ORIGIN_GATEWAY_SECRET: "gateway-test-secret",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const denied = await worker.fetch(new Request("http://localhost/"), env, context);
  assert.equal(denied.status, 403);
  const allowed = await worker.fetch(new Request("http://localhost/", {
    headers: { "x-origin-gateway-token": "gateway-test-secret", accept: "text/html" },
  }), env, context);
  assert.equal(allowed.status, 200);
});
test("supports permanent episode deletion and inventory release", async () => {
  const route = await readFile(new URL("../app/api/episodes/[eid]/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function DELETE/);
  assert.match(route, /requireApiUser\(\{ mutation: true \}\)/);
  assert.match(route, /deleteEpisodeDocuments\(user\.userId, record\.eid\)/);
  assert.match(route, /deleteEpisodeRecords\(user\.userId, record\.eid\)/);
  assert.match(route, /inventoryReleased: true/);

  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /删除文稿/);
  assert.match(workspace, /释放 1 个文稿库存名额/);
});

test("keeps the provider-neutral two-step setup guide and safe dual-provider settings", async () => {
  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /进入声笺前，确认两项连接/);
  assert.match(workspace, /<h3>连接小宇宙<\/h3>/);
  assert.match(workspace, /<h3>设置 AI 提供商<\/h3>/);
  assert.match(workspace, /AI 提供商设置/);
  assert.match(workspace, /自定义 API/);
  assert.match(workspace, /Codex 中转预设/);
  assert.match(workspace, /gpt-5\.6-luna/);
  assert.match(workspace, /Base URL 与 Key 仍须手动填写/);
  const preset = workspace.match(/function applyCodexPreset\(\) \{([\s\S]*?)\n {2}\}/)?.[1];
  assert.ok(preset, "Codex 中转预设必须由受限函数实现");
  assert.match(preset, /^\s*setCustomModel\("gpt-5\.6-luna"\);\s*setCustomApiFormat\("responses"\);\s*setCustomReasoningEffort\("medium"\);\s*$/);
  assert.doesNotMatch(preset, /setCustomBaseUrl|https?:\/\//);
  assert.match(workspace, /const \[setupGuideOpen, setSetupGuideOpen\] = useState\(true\)/);
  assert.doesNotMatch(workspace, /setSetupGuideOpen\(!status\.connected \|\| !aiStatus\.connected\)/);
  assert.doesNotMatch(workspace, /邮箱登录待配置|绑定独立邮箱/);
});

function functionBody(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `${name} must be a named function`);
  return match[1];
}

test("keeps server status refreshes from partially rolling back custom provider drafts", async () => {
  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  const refresh = workspace.match(/const applyAiSettings = useCallback\(\(status: AiSettingsStatus\) => \{([\s\S]*?)\n {2}\}, \[\]\);/)?.[1];
  assert.ok(refresh, "AI status refresh must remain a separate callback");
  assert.match(refresh, /^\s*setAiSettings\(status\);\s*$/);
  assert.doesNotMatch(refresh, /setCustom(BaseUrl|ApiKey|Model|ApiFormat|ReasoningEffort)/);

  const load = workspace.match(/const loadAiSettings = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[applyAiSettings, syncCustomDraft\]\);/)?.[1];
  assert.ok(load, "initial load must explicitly initialize the custom draft");
  assert.match(load, /applyAiSettings\(data\);\s*syncCustomDraft\(data\.providers\.custom\);/);

  const customSave = functionBody(workspace, "saveCustomSettings");
  assert.match(customSave, /applyAiSettings\(status\);\s*syncCustomDraft\(status\.providers\.custom\);/);
  for (const mutation of ["setDefaultAiProvider", "disconnectAi"]) {
    assert.doesNotMatch(functionBody(workspace, mutation), /syncCustomDraft|setCustom(BaseUrl|ApiKey|Model|ApiFormat|ReasoningEffort)/);
  }
});

test("keeps custom Responses reasoning optional while presets and Chat remain strict", async () => {
  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /const \[customReasoningEffort, setCustomReasoningEffort\] = useState<ReasoningEffort \| null>\(null\)/);

  const sync = workspace.match(/const syncCustomDraft = useCallback\(\(custom: AiSettingsStatus\["providers"\]\["custom"\]\) => \{([\s\S]*?)\n {2}\}, \[\]\);/)?.[1];
  assert.ok(sync, "custom draft sync must be explicit");
  assert.match(sync, /setCustomReasoningEffort\(custom\.reasoningEffort\);/);
  assert.doesNotMatch(sync, /reasoningEffort \?\? "medium"/);

  assert.match(workspace, /\{customApiFormat === "responses" && \([\s\S]*?<select value=\{customReasoningEffort \?\? ""\}/);
  assert.match(workspace, /<option value="">不发送推理强度<\/option>/);
  assert.match(workspace, /setCustomReasoningEffort\(event\.target\.value \? event\.target\.value as ReasoningEffort : null\)/);

  const save = functionBody(workspace, "saveCustomSettings");
  assert.match(save, /reasoningEffort: customApiFormat === "responses" \? customReasoningEffort : null/);
  const preset = functionBody(workspace, "applyCodexPreset");
  assert.match(preset, /setCustomApiFormat\("responses"\);\s*setCustomReasoningEffort\("medium"\);/);
});

test("clears unsubmitted keys on every AI modal close path", async () => {
  const workspace = await readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8");
  const close = functionBody(workspace, "closeAiModal");
  assert.match(close, /^\s*setDeepseekApiKey\(""\);\s*setCustomApiKey\(""\);\s*setAiModalOpen\(false\);\s*$/);
  assert.equal((workspace.match(/setAiModalOpen\(false\)/g) ?? []).length, 1);
  assert.match(workspace, /onMouseDown=\{\(event\) => event\.target === event\.currentTarget && closeAiModal\(\)\}/);
  assert.match(workspace, /onClick=\{closeAiModal\} aria-label="关闭"/);
  assert.match(functionBody(workspace, "saveDeepseekSettings"), /closeAiModal\(\);/);
  assert.match(functionBody(workspace, "saveCustomSettings"), /closeAiModal\(\);/);
});

test("keeps the long provider modal operable and provider names contained", async () => {
  const [workspace, styles] = await Promise.all([
    readFile(new URL("../app/workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const aiCloseRules = styles.match(/\.ai-modal \.modal-close \{[^}]*\}/g) ?? [];
  assert.equal(aiCloseRules.length, 2);
  for (const rule of aiCloseRules) assert.doesNotMatch(rule, /top:\s*-/);
  assert.match(styles, /\.ai-provider-card > div \{[^}]*min-width:\s*0/);
  assert.match(styles, /\.ai-provider-card small \{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.ai-chip \{[^}]*max-width:/);
  assert.match(styles, /\.ai-chip-label \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(workspace, /const aiChipLabel =/);
  assert.match(workspace, /title=\{aiChipLabel\} aria-label=\{aiChipLabel\}/);
});

test("automatically creates secure isolated anonymous browser accounts", async () => {
  const authShell = await readFile(new URL("../app/auth-shell.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/auth/anonymous/route.ts", import.meta.url), "utf8");
  const meRoute = await readFile(new URL("../app/api/auth/me/route.ts", import.meta.url), "utf8");
  const user = await readFile(new URL("../lib/user.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

  assert.match(authShell, /\/api\/auth\/anonymous[\s\S]*method: "POST"/);
  assert.match(authShell, /await initialize\(\)/);
  assert.doesNotMatch(authShell, />登录配置中</);
  assert.match(route, /requireMutationSecurity\(\)/);
  assert.match(route, /appendAnonymousCookie/);
  assert.match(meRoute, /appendAnonymousCookie/);
  assert.match(route, /"device"[\s\S]*3[\s\S]*24 \* 60 \* 60/);
  assert.match(route, /"ip"[\s\S]*20[\s\S]*60 \* 60/);
  assert.match(user, /authMode: "supabase" \| "legacy" \| "anonymous"/);
  assert.match(user, /resolveAnonymousToken/);
  assert.match(schema, /sqliteTable\("anonymous_sessions"/);
});

test("generates staged podcast-host learning prompts", async () => {
  const analysis = await readFile(new URL("../lib/analysis.ts", import.meta.url), "utf8");

  assert.match(analysis, /播客听后深度对谈 Prompt/);
  assert.match(analysis, /最高优先级：对话启动协议/);
  assert.match(analysis, /正式提问前先完整展示本期学习地图/);
  assert.match(analysis, /想先就本期播客自由提问，还是现在开始正式学习/);
  assert.match(analysis, /根据节目时长、内容长度、概念数量、观点分歧和知识密度/);
  assert.match(analysis, /进入下一阶段条件/);
  assert.match(analysis, /默认 2–4 轮/);
  assert.match(analysis, /最多进行两次有针对性的补问/);
  assert.match(analysis, /不要求每轮机械点名/);
  assert.match(analysis, /多人节目分别列出每位可可靠识别人物/);
  assert.match(analysis, /回答记录与阶段总结/);
  assert.match(analysis, /用户在该阶段的真实回答/);
  assert.match(analysis, /具体可执行的实践方案/);
  assert.match(analysis, /本期播客的学习对话已结束/);
  assert.match(analysis, /单集时长/);
  assert.match(analysis, /不得声称自己是真人/);
});
