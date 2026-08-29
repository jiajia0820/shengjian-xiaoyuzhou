"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, downloadWithAuth, type Viewer } from "@/lib/auth-client";
import XiaoyuzhouCaptcha, {
  type XiaoyuzhouCaptchaHandle,
  type XiaoyuzhouCaptchaToken,
} from "@/app/xiaoyuzhou-captcha";
import { SpeakerDiarizationPanel } from "@/app/speaker-diarization-panel";
import { stripRedundantAnalysisHeading } from "@/lib/analysis-format";
import {
  cleanupProgressLabel,
  consumeCleanupResponse,
  sha256Hex,
  type CleanupProgress,
  type CleanupStats,
} from "@/lib/transcript-cleanup-client";

type AccountStatus = { connected: boolean; phoneHint: string | null; connectedAt: string | null; displayName: string };
type AiProvider = "deepseek" | "custom";
type ReasoningEffort = "low" | "medium" | "high";
type AiSettingsStatus = {
  defaultProvider: AiProvider | null;
  providers: {
    deepseek: {
      provider: "deepseek"; connected: boolean; model: "deepseek-v4-flash"; apiFormat: "chat_completions";
      keyHint: string | null; connectedAt: string | null;
    };
    custom: {
      provider: "custom"; connected: boolean; baseUrl: string | null; model: string | null;
      apiFormat: "responses" | "chat_completions" | null; reasoningEffort: ReasoningEffort | null;
      keyHint: string | null; connectedAt: string | null;
    };
  };
};
type Episode = {
  eid: string; sourceUrl: string; title: string; podcastTitle: string; publishedAt: string | null;
  durationSeconds: number | null; segmentCount: number; createdAt: string; updatedAt: string;
};
type Framework = {
  id: string; name: string; instructions: string; isSystem: boolean; createdAt: string | null;
  updatedAt: string | null; isDeleted?: boolean;
};
type AnalysisResult = {
  slot: string; kind: "summary" | "learning_prompt"; frameworkId: string | null;
  frameworkName: string | null; sourceType: "original" | "current"; sourceHash: string;
  model: string; generatedAt: string; stale: boolean;
};
type Notice = { kind: "success" | "error" | "info"; text: string } | null;
type DocumentTab = "transcript" | "summary" | "learning_prompt";

const FALLBACK_SYSTEM_FRAMEWORK: Framework = {
  id: "system-brief-v1", name: "通用内容梳理", isSystem: true, createdAt: null, updatedAt: null,
  instructions: "# 内容梳理目标\n\n把播客整理成可快速复习、可追溯原文的简要笔记。\n\n## 输出结构\n\n一句话主旨、核心问题与结论、关键论据与时间戳、重要概念和方法、可执行建议、值得继续追问的问题。",
};

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || "请求失败，请稍后重试");
  return data;
}

function durationLabel(seconds: number | null): string {
  return seconds ? `${Math.max(1, Math.round(seconds / 60))} 分钟` : "时长未知";
}

function dateLabel(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(value)).replaceAll("/", ".");
}

function stripEpisodeMetaFromPreview(lines: string[]): string[] {
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (titleIndex < 0) return lines;
  let cursor = titleIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  if (!/^>\s*节目：/.test(lines[cursor] ?? "")) return lines;
  cursor += 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  if (!/^>\s*原始单集：/.test(lines[cursor] ?? "")) return lines;
  cursor += 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  return [...lines.slice(0, titleIndex + 1), "", ...lines.slice(cursor)];
}

function MarkdownPreview({
  markdown,
  hideEpisodeMeta = false,
  analysisPreview = false,
}: { markdown: string; hideEpisodeMeta?: boolean; analysisPreview?: boolean }) {
  const body = useMemo(() => markdown.replace(/^---[\s\S]*?---\s*/, ""), [markdown]);
  const lines = useMemo(() => {
    let nextLines = body.split(/\r?\n/);
    if (hideEpisodeMeta) nextLines = stripEpisodeMetaFromPreview(nextLines);
    if (analysisPreview) nextLines = stripRedundantAnalysisHeading(nextLines);
    return nextLines;
  }, [body, hideEpisodeMeta, analysisPreview]);
  return (
    <div className={analysisPreview ? "markdown-preview analysis-preview" : "markdown-preview"}>
      {lines.map((line, index) => {
        if (line.startsWith("# ")) return <h1 key={index}>{line.slice(2)}</h1>;
        if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>;
        if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>;
        if (line.startsWith("> ")) return <blockquote key={index}>{line.slice(2).trimEnd()}</blockquote>;
        if (/^[-*] /.test(line)) return <p className="markdown-list" key={index}>• {line.slice(2)}</p>;
        if (/^\d+\. /.test(line)) return <p className="markdown-list" key={index}>{line}</p>;
        if (/^\[\d{2}:\d{2}:\d{2}\]/.test(line)) {
          return <p className="transcript-line" key={index}><time>{line.slice(0, 10)}</time>{line.slice(11)}</p>;
        }
        if (!line.trim()) return <div className="markdown-space" key={index} />;
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

export default function Workspace({
  viewer, onSignOut, onDeleteAccount,
}: {
  viewer: Viewer;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}) {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettingsStatus>({
    defaultProvider: null,
    providers: {
      deepseek: { provider: "deepseek", connected: false, model: "deepseek-v4-flash", apiFormat: "chat_completions", keyHint: null, connectedAt: null },
      custom: { provider: "custom", connected: false, baseUrl: null, model: null, apiFormat: null, reasoningEffort: null, keyHint: null, connectedAt: null },
    },
  });
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [systemFramework, setSystemFramework] = useState<Framework>(FALLBACK_SYSTEM_FRAMEWORK);
  const [frameworks, setFrameworks] = useState<Framework[]>([]);
  const [episodeUrl, setEpisodeUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [areaCode, setAreaCode] = useState("+86");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const captchaRef = useRef<XiaoyuzhouCaptchaHandle>(null);
  const [selected, setSelected] = useState<Episode | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [editorMode, setEditorMode] = useState<"preview" | "edit">("preview");
  const [documentTab, setDocumentTab] = useState<DocumentTab>("transcript");
  const [documentLoading, setDocumentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleanupProcessing, setCleanupProcessing] = useState(false);
  const [cleanupProgress, setCleanupProgress] = useState("准备处理文稿…");
  const [cleanupStats, setCleanupStats] = useState<CleanupStats | null>(null);
  const [cleanupUndoAvailable, setCleanupUndoAvailable] = useState(false);
  const [speakerLayoutStale, setSpeakerLayoutStale] = useState(false);
  const [speakerProcessing, setSpeakerProcessing] = useState(false);
  const [deletingEid, setDeletingEid] = useState<string | null>(null);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>([]);
  const [analysisMarkdown, setAnalysisMarkdown] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [analysisSource, setAnalysisSource] = useState<"original" | "current">("current");
  const [selectedFrameworkId, setSelectedFrameworkId] = useState(FALLBACK_SYSTEM_FRAMEWORK.id);
  const [frameworkModalOpen, setFrameworkModalOpen] = useState(false);
  const [editingFrameworkId, setEditingFrameworkId] = useState<string | null>(null);
  const [frameworkName, setFrameworkName] = useState("");
  const [frameworkInstructions, setFrameworkInstructions] = useState("");
  const [frameworkSaving, setFrameworkSaving] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [setupGuideOpen, setSetupGuideOpen] = useState(true);
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customApiFormat, setCustomApiFormat] = useState<"responses" | "chat_completions">("responses");
  const [customReasoningEffort, setCustomReasoningEffort] = useState<ReasoningEffort | null>(null);
  const [aiSaving, setAiSaving] = useState(false);

  const applyAiSettings = useCallback((status: AiSettingsStatus) => {
    setAiSettings(status);
  }, []);

  const syncCustomDraft = useCallback((custom: AiSettingsStatus["providers"]["custom"]) => {
    setCustomBaseUrl(custom.baseUrl ?? "");
    setCustomModel(custom.model ?? "");
    setCustomApiFormat(custom.apiFormat ?? "responses");
    setCustomReasoningEffort(custom.reasoningEffort);
  }, []);

  const loadEpisodes = useCallback(async () => {
    const data = await responseJson<{ episodes: Episode[] }>(await apiFetch("/api/episodes", { cache: "no-store" }));
    setEpisodes(data.episodes);
  }, []);

  const loadFrameworks = useCallback(async () => {
    const data = await responseJson<{ systemFramework: Framework; frameworks: Framework[] }>(
      await apiFetch("/api/frameworks", { cache: "no-store" }),
    );
    setSystemFramework(data.systemFramework);
    setFrameworks(data.frameworks);
  }, []);

  const loadAiSettings = useCallback(async () => {
    const data = await responseJson<AiSettingsStatus>(await apiFetch("/api/ai-settings", { cache: "no-store" }));
    applyAiSettings(data);
    syncCustomDraft(data.providers.custom);
    return data;
  }, [applyAiSettings, syncCustomDraft]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const status = await responseJson<AccountStatus>(await apiFetch("/api/account/status", { cache: "no-store" }));
      setAccount(status);
      await Promise.all([loadEpisodes(), loadFrameworks(), loadAiSettings()]);
    } catch (error) {
      setAccount({ connected: false, phoneHint: null, connectedAt: null, displayName: "私有用户" });
      setNotice({ kind: "info", text: error instanceof Error ? error.message : "请登录后使用" });
    } finally {
      setLoading(false);
    }
  }, [loadAiSettings, loadEpisodes, loadFrameworks]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadInitial(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadInitial]);

  const frameworkOptions = useMemo(() => {
    const available = [systemFramework, ...frameworks];
    const known = new Set(available.map((item) => item.id));
    const deleted = analysisResults
      .filter((result) => result.kind === "summary" && result.frameworkId && !known.has(result.frameworkId))
      .map((result) => ({
        id: result.frameworkId as string, name: result.frameworkName ?? "已删除框架", instructions: "",
        isSystem: false, isDeleted: true, createdAt: null, updatedAt: null,
      }));
    return [...available, ...deleted];
  }, [analysisResults, frameworks, systemFramework]);

  const selectedSlot = documentTab === "summary" ? `summary:${selectedFrameworkId}`
    : documentTab === "learning_prompt" ? "learning_prompt" : "";
  const selectedAnalysis = analysisResults.find((result) => result.slot === selectedSlot) ?? null;
  const selectedFramework = frameworkOptions.find((item) => item.id === selectedFrameworkId) ?? null;

  async function sendCode() {
    if (!phone.trim()) {
      setNotice({ kind: "error", text: "请输入手机号" });
      return;
    }
    setConnecting(true);
    try {
      const captcha: XiaoyuzhouCaptchaToken | undefined = await captchaRef.current?.requestToken();
      if (!captcha) throw new Error("请先完成安全验证");
      const { scene: captchaScene, verifyParam: captchaVerifyParam } = captcha;
      await responseJson(await apiFetch("/api/account/send-code", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          areaCode,
          phone: phone.trim(),
          captcha: { scene: captchaScene, verifyParam: captchaVerifyParam },
        }),
      }));
      setCodeSent(true);
      setNotice({ kind: "success", text: "验证码已发送，请查看手机" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "发送失败" });
    } finally {
      setConnecting(false);
    }
  }

  async function connectAccount(event: FormEvent) {
    event.preventDefault();
    setConnecting(true);
    try {
      const status = await responseJson<AccountStatus>(await apiFetch("/api/account/connect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areaCode, phone: phone.trim(), code: code.trim() }),
      }));
      setAccount(status);
      setConnectOpen(false);
      setCode("");
      if (!aiSettings.defaultProvider) setSetupGuideOpen(true);
      setNotice({ kind: "success", text: "小宇宙账号已连接" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "连接失败" });
    } finally {
      setConnecting(false);
    }
  }

  async function disconnectAccount() {
    if (!window.confirm("确认断开小宇宙账号？已保存的文稿不会删除。")) return;
    try {
      await responseJson(await apiFetch("/api/account/connect", { method: "DELETE" }));
      setAccount((current) => current ? { ...current, connected: false, phoneHint: null, connectedAt: null } : current);
      setNotice({ kind: "success", text: "已断开连接" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "断开失败" });
    }
  }

  async function openEpisode(episode: Episode) {
    setSelected(episode);
    setDocumentTab("transcript");
    setEditorMode("preview");
    setDocumentLoading(true);
    setAnalysisMarkdown("");
    setCleanupStats(null);
    setCleanupUndoAvailable(false);
    setSpeakerLayoutStale(false);
    try {
      const [documentData, analysisData] = await Promise.all([
        responseJson<{ markdown: string }>(await apiFetch(`/api/episodes/${episode.eid}`, { cache: "no-store" })),
        responseJson<{ results: AnalysisResult[] }>(await apiFetch(`/api/episodes/${episode.eid}/analyses`, { cache: "no-store" })),
      ]);
      setMarkdown(documentData.markdown);
      try {
        const cleanupStatus = await responseJson<{ undoAvailable: boolean }>(
          await apiFetch(`/api/episodes/${episode.eid}/cleanup`, { cache: "no-store" }),
        );
        setCleanupUndoAvailable(Boolean(cleanupStatus.undoAvailable));
      } catch {
        setCleanupUndoAvailable(false);
      }
      setAnalysisResults(analysisData.results);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "读取文稿失败" });
    } finally {
      setDocumentLoading(false);
    }
  }

  async function importEpisode(event?: FormEvent, refresh = false) {
    event?.preventDefault();
    if (cleanupProcessing) return;
    if (!account?.connected) {
      setConnectOpen(true);
      return;
    }
    const sourceUrl = refresh ? selected?.sourceUrl : episodeUrl.trim();
    if (!sourceUrl) return;
    setImporting(true);
    try {
      const data = await responseJson<{ episode: Episode; markdown: string; existing: boolean; refreshed: boolean }>(
        await apiFetch("/api/episodes/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: sourceUrl, refresh }),
        }),
      );
      await loadEpisodes();
      if (!refresh) setEpisodeUrl("");
      setSelected(data.episode);
      setMarkdown(data.markdown);
      setCleanupStats(null);
      setCleanupUndoAvailable(false);
      setSpeakerLayoutStale(false);
      setDocumentTab("transcript");
      setEditorMode("preview");
      const analysisData = await responseJson<{ results: AnalysisResult[] }>(
        await apiFetch(`/api/episodes/${data.episode.eid}/analyses`, { cache: "no-store" }),
      );
      setAnalysisResults(analysisData.results);
      setNotice({
        kind: "success",
        text: data.refreshed ? "官方原稿已重新获取，相关分析可能需要重新生成"
          : data.existing ? "已打开文稿库中的现有记录" : "官方文稿已保存为 Markdown",
      });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "提取失败" });
    } finally {
      setImporting(false);
    }
  }

  async function saveDocument() {
    if (!selected || cleanupProcessing) return;
    setSaving(true);
    try {
      await responseJson(await apiFetch(`/api/episodes/${selected.eid}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown }),
      }));
      await loadEpisodes();
      setAnalysisResults((results) => results.map((result) => result.sourceType === "current" ? { ...result, stale: true } : result));
      setEditorMode("preview");
      setNotice({ kind: "success", text: "当前编辑稿已保存；基于旧编辑稿的分析已标记为过期" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  async function cleanupTranscript() {
    if (!selected || cleanupProcessing) return;
    if (!aiSettings.defaultProvider) {
      setAiModalOpen(true);
      setNotice({ kind: "info", text: "请先在 AI 设置中连接可用的 AI 服务" });
      return;
    }
    const episodeId = selected.eid;
    const sourceMarkdown = markdown;
    setCleanupProcessing(true);
    setCleanupProgress("准备处理文稿…");
    try {
      const currentHash = await sha256Hex(sourceMarkdown);
      const response = await apiFetch(`/api/episodes/${episodeId}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ currentHash }),
      });
      const result = await consumeCleanupResponse(response, (progress: CleanupProgress) => {
        setCleanupProgress(cleanupProgressLabel(progress));
      });
      setMarkdown(result.markdown);
      setCleanupStats(result.stats);
      setCleanupUndoAvailable(result.undoAvailable !== false);
      setSpeakerLayoutStale(Boolean(result.speakerLayoutStale));
      try { await loadEpisodes(); } catch { /* 尽力刷新列表；不影响已成功的清理结果 */ }
      setNotice({ kind: "success", text: "AI 整理完成，已保留撤销快照" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 整理失败，当前文稿未改变";
      if (message.includes("AI 设置") || message.includes("AI 服务")) {
        setAiModalOpen(true);
        setNotice({ kind: "info", text: message });
      } else {
        setNotice({ kind: "error", text: message });
      }
    } finally {
      setCleanupProcessing(false);
    }
  }

  async function undoCleanup() {
    if (!selected || cleanupProcessing || !cleanupUndoAvailable) return;
    setCleanupProcessing(true);
    setCleanupProgress("正在撤销 AI 整理…");
    try {
      const currentHash = await sha256Hex(markdown);
      const response = await apiFetch(`/api/episodes/${selected.eid}/cleanup/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentHash }),
      });
      if (response.status === 409) {
        const data = await response.json().catch(() => ({})) as { message?: string };
        setNotice({ kind: "info", text: data.message || "当前文稿已被修改，请刷新后重试" });
        return;
      }
      const data = await responseJson<{ markdown: string }>(response);
      setMarkdown(data.markdown);
      setCleanupStats(null);
      setCleanupUndoAvailable(false);
      setSpeakerLayoutStale(false);
      try { await loadEpisodes(); } catch { /* 尽力刷新列表；不影响已成功的撤销结果 */ }
      setNotice({ kind: "success", text: "已撤销 AI 整理，恢复整理前的编辑稿" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "撤销 AI 整理失败" });
    } finally {
      setCleanupProcessing(false);
    }
  }

  async function deleteEpisode() {
    const episode = selected;
    if (!episode || cleanupProcessing) return;
    const confirmed = window.confirm(
      `永久删除“${episode.title}”？官方原稿、编辑稿、内容梳理和学习 Prompt 都会删除，且无法恢复。`,
    );
    if (!confirmed) return;
    setDeletingEid(episode.eid);
    try {
      await responseJson<{ deleted: boolean; inventoryReleased: boolean }>(
        await apiFetch(`/api/episodes/${episode.eid}`, { method: "DELETE" }),
      );
      setEpisodes((current) => current.filter((item) => item.eid !== episode.eid));
      setSelected(null);
      setMarkdown("");
      setAnalysisResults([]);
      setAnalysisMarkdown("");
      setNotice({ kind: "success", text: "文稿已永久删除，并释放 1 个文稿库存名额" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "删除文稿失败" });
    } finally {
      setDeletingEid(null);
    }
  }

  async function copyText(value: string, successText: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ kind: "success", text: successText });
    } catch {
      setNotice({ kind: "error", text: "浏览器未允许复制，请手动选择文本" });
    }
  }

  async function downloadFile(url: string, filename: string) {
    if (cleanupProcessing) return;
    try {
      await downloadWithAuth(url, filename.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120));
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "下载失败" });
    }
  }

  async function loadAnalysis(slot: string) {
    if (!selected) return;
    setAnalysisLoading(true);
    setAnalysisMarkdown("");
    try {
      const data = await responseJson<{ result: AnalysisResult; markdown: string }>(
        await apiFetch(`/api/episodes/${selected.eid}/analyses?slot=${encodeURIComponent(slot)}`, { cache: "no-store" }),
      );
      setAnalysisMarkdown(data.markdown);
      setAnalysisResults((results) => {
        const rest = results.filter((item) => item.slot !== slot);
        return [data.result, ...rest];
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("还没有生成")) {
        setAnalysisMarkdown("");
      } else {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "读取分析失败" });
      }
    } finally {
      setAnalysisLoading(false);
    }
  }

  function switchDocumentTab(tab: DocumentTab) {
    if (cleanupProcessing) return;
    setDocumentTab(tab);
    setEditorMode("preview");
    if (tab === "summary") void loadAnalysis(`summary:${selectedFrameworkId}`);
    if (tab === "learning_prompt") void loadAnalysis("learning_prompt");
  }

  function changeFramework(id: string) {
    setSelectedFrameworkId(id);
    if (documentTab === "summary") void loadAnalysis(`summary:${id}`);
  }

  async function generateAnalysis() {
    if (!selected || documentTab === "transcript" || cleanupProcessing) return;
    if (!aiSettings.defaultProvider) {
      setAiModalOpen(true);
      setNotice({ kind: "info", text: "请先设置 AI 提供商" });
      return;
    }
    if (selectedAnalysis && !window.confirm("重新生成会覆盖这份旧结果，确定继续吗？")) return;
    if (documentTab === "summary" && selectedFramework?.isDeleted) {
      setNotice({ kind: "error", text: "该框架已删除，旧结果仍可查看；请选择现有框架重新生成" });
      return;
    }
    setGenerating(true);
    try {
      const data = await responseJson<{ result: AnalysisResult; markdown: string }>(
        await apiFetch(`/api/episodes/${selected.eid}/analyses/generate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: documentTab === "summary" ? "summary" : "learning_prompt",
            source: analysisSource,
            frameworkId: documentTab === "summary" ? selectedFrameworkId : undefined,
          }),
        }),
      );
      setAnalysisMarkdown(data.markdown);
      setAnalysisResults((results) => [data.result, ...results.filter((item) => item.slot !== data.result.slot)]);
      setNotice({ kind: "success", text: documentTab === "summary" ? "内容梳理已生成" : "学习 Prompt 已生成" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "AI 生成失败，旧结果已保留" });
    } finally {
      setGenerating(false);
    }
  }

  function openFrameworkEditor(framework?: Framework) {
    setEditingFrameworkId(framework?.id ?? null);
    setFrameworkName(framework?.name ?? "");
    setFrameworkInstructions(framework?.instructions ?? systemFramework.instructions);
    setFrameworkModalOpen(true);
  }

  async function saveFramework(event: FormEvent) {
    event.preventDefault();
    setFrameworkSaving(true);
    try {
      const path = editingFrameworkId ? `/api/frameworks/${editingFrameworkId}` : "/api/frameworks";
      const data = await responseJson<{ framework: Framework }>(await apiFetch(path, {
        method: editingFrameworkId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: frameworkName, instructions: frameworkInstructions }),
      }));
      await loadFrameworks();
      setSelectedFrameworkId(data.framework.id);
      setFrameworkModalOpen(false);
      setNotice({ kind: "success", text: editingFrameworkId ? "框架已更新" : "个性化框架已创建" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "保存框架失败" });
    } finally {
      setFrameworkSaving(false);
    }
  }

  async function deleteFramework(framework: Framework) {
    if (!window.confirm(`删除“${framework.name}”？历史分析结果仍会保留。`)) return;
    try {
      await responseJson(await apiFetch(`/api/frameworks/${framework.id}`, { method: "DELETE" }));
      if (selectedFrameworkId === framework.id) setSelectedFrameworkId(systemFramework.id);
      await loadFrameworks();
      setNotice({ kind: "success", text: "框架已删除，历史结果仍可查看" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "删除框架失败" });
    }
  }

  async function saveDeepseekSettings(event: FormEvent) {
    event.preventDefault();
    setAiSaving(true);
    try {
      const status = await responseJson<AiSettingsStatus>(await apiFetch("/api/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", apiKey: deepseekApiKey }),
      }));
      applyAiSettings(status);
      closeAiModal();
      if (!account?.connected) setSetupGuideOpen(true);
      setNotice({ kind: "success", text: "DeepSeek 已连接，可以开始生成内容梳理和学习 Prompt" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "DeepSeek 设置保存失败" });
    } finally {
      setAiSaving(false);
    }
  }

  async function saveCustomSettings(event: FormEvent) {
    event.preventDefault();
    setAiSaving(true);
    try {
      const status = await responseJson<AiSettingsStatus>(await apiFetch("/api/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom", apiKey: customApiKey, baseUrl: customBaseUrl, model: customModel,
          apiFormat: customApiFormat, reasoningEffort: customApiFormat === "responses" ? customReasoningEffort : null,
        }),
      }));
      applyAiSettings(status);
      syncCustomDraft(status.providers.custom);
      closeAiModal();
      if (!account?.connected) setSetupGuideOpen(true);
      setNotice({ kind: "success", text: "自定义 API 已连接，可以开始生成内容梳理和学习 Prompt" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "自定义 API 设置保存失败" });
    } finally {
      setAiSaving(false);
    }
  }

  async function setDefaultAiProvider(provider: AiProvider) {
    setAiSaving(true);
    try {
      const status = await responseJson<AiSettingsStatus>(await apiFetch("/api/ai-settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }),
      }));
      applyAiSettings(status);
      setNotice({ kind: "success", text: `${provider === "deepseek" ? "DeepSeek" : "自定义 API"} 已设为默认提供商` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "设置默认 AI 提供商失败" });
    } finally {
      setAiSaving(false);
    }
  }

  async function disconnectAi(provider: AiProvider) {
    const providerName = provider === "deepseek" ? "DeepSeek" : "自定义 API";
    if (!window.confirm(`确认删除已保存的 ${providerName} 配置？历史分析结果不会删除。`)) return;
    setAiSaving(true);
    try {
      const status = await responseJson<AiSettingsStatus>(await apiFetch(`/api/ai-settings?provider=${provider}`, { method: "DELETE" }));
      applyAiSettings(status);
      setNotice({ kind: "success", text: `已删除 ${providerName} 配置` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : `删除 ${providerName} 设置失败` });
    } finally {
      setAiSaving(false);
    }
  }

  function applyCodexPreset() {
    setCustomModel("gpt-5.6-luna");
    setCustomApiFormat("responses");
    setCustomReasoningEffort("medium");
  }

  function closeAiModal() {
    setDeepseekApiKey("");
    setCustomApiKey("");
    setAiModalOpen(false);
  }

  const defaultProviderStatus = aiSettings.defaultProvider ? aiSettings.providers[aiSettings.defaultProvider] : null;
  const defaultProviderName = aiSettings.defaultProvider === "deepseek" ? "DeepSeek" : "自定义 API";
  const aiChipLabel = defaultProviderStatus
    ? `${defaultProviderName} · ${defaultProviderStatus.model} · ${defaultProviderStatus.keyHint ?? "已连接"}`
    : "设置 AI 提供商";

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="声笺首页">
          <span className="brand-mark">声</span><span>声笺</span><span className="brand-en">SONIC NOTES</span>
        </a>
        <div className="header-actions">
          <button className="account-chip ai-chip" type="button" onClick={() => setAiModalOpen(true)} title={aiChipLabel} aria-label={aiChipLabel}>
            <span className={defaultProviderStatus ? "online-dot" : "offline-dot"} />
            <span className="ai-chip-label">{aiChipLabel}</span>
          </button>
          {account?.connected ? (
            <button className="account-chip" type="button" onClick={() => void disconnectAccount()} title="点击断开账号">
              <span className="online-dot" /> {account.phoneHint}
            </button>
          ) : (
            <button className="account-chip" type="button" onClick={() => setConnectOpen(true)}>
              <span className="offline-dot" /> 连接小宇宙
            </button>
          )}
          {viewer.authMode === "supabase" && (
            <button className="status-pill user-session" type="button" onClick={onSignOut} title="点击退出登录">
              <span /> {viewer.email} · 退出
            </button>
          )}
          {viewer.authMode === "anonymous" && (
            <span className="status-pill anonymous-session" title="资料仅保存在当前浏览器账户中">
              <span /> 匿名使用中
            </span>
          )}
        </div>
      </header>

      {notice && (
        <button className={`notice ${notice.kind}`} type="button" onClick={() => setNotice(null)}>
          {notice.text}<span>×</span>
        </button>
      )}

      <section className="hero" id="top">
        <div className="eyebrow"><span>01</span> PODCAST → MARKDOWN</div>
        <h1>声音落成文字，<br /><em>思考继续发生。</em></h1>
        <p className="hero-copy">粘贴小宇宙单集链接，提取官方文稿，<br />转写为 Markdown 格式。</p>
        <form className="import-form" onSubmit={(event) => void importEpisode(event)}>
          <label htmlFor="episode-url">小宇宙单集链接</label>
          <div className="input-row">
            <input id="episode-url" type="url" value={episodeUrl} onChange={(event) => setEpisodeUrl(event.target.value)}
              placeholder="https://www.xiaoyuzhoufm.com/episode/..." aria-describedby="import-note" />
            <button type="submit" disabled={!episodeUrl || importing}>
              {importing ? "正在提取…" : "提取文稿"} <span>↗</span>
            </button>
          </div>
          <div className="form-note" id="import-note">
            <span>仅支持已有官方文稿的公开单集</span>
            <button className="connection" type="button" onClick={() => !account?.connected && setConnectOpen(true)}>
              <i className={account?.connected ? "is-online" : ""} />
              {loading ? "正在确认连接…" : account?.connected ? `已安全连接 ${account.phoneHint}` : "小宇宙账号待连接"}
            </button>
          </div>
        </form>
      </section>

      <section className="library" aria-labelledby="library-title">
        <div className="section-heading">
          <div><span className="section-no">02 / LIBRARY</span><h2 id="library-title">文稿库</h2></div>
          <span className="library-count">{episodes.length.toString().padStart(2, "0")} 篇文稿</span>
        </div>
        {loading ? (
          <div className="empty-library"><span>···</span><h3>正在打开你的文稿库</h3></div>
        ) : episodes.length === 0 ? (
          <div className="empty-library">
            <span>∿</span><h3>这里还很安静</h3><p>连接小宇宙账号，再粘贴一条有官方文稿的单集链接。</p>
          </div>
        ) : (
          <div className="episode-list">
            {episodes.map((episode, index) => (
              <article className="episode-card" key={episode.eid}>
                <div className="episode-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="episode-main">
                  <p>{episode.podcastTitle}</p><h3>{episode.title}</h3>
                  <span>{durationLabel(episode.durationSeconds)} · {episode.segmentCount.toLocaleString("zh-CN")} 个字幕片段</span>
                </div>
                <time>{dateLabel(episode.updatedAt)}</time>
                <button aria-label={`打开 ${episode.title}`} type="button" onClick={() => void openEpisode(episode)}>↗</button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="frameworks-section" aria-labelledby="frameworks-title">
        <div className="section-heading">
          <div><span className="section-no">03 / FRAMEWORKS</span><h2 id="frameworks-title">梳理框架</h2></div>
          <button className="outline-action" type="button" onClick={() => openFrameworkEditor()}>＋ 新建框架</button>
        </div>
        <p className="framework-intro">用 Markdown 写下你希望 AI 如何阅读与整理全文。每次生成前都可以临时选择框架和文稿版本。</p>
        <div className="framework-grid">
          <article className="framework-card system">
            <div className="framework-card-top"><span>系统样本</span><i>只读</i></div>
            <h3>{systemFramework.name}</h3>
            <p>从主旨、问题、论据、概念到行动建议，明确区分原文事实、AI 归纳与不确定内容。</p>
            <button type="button" onClick={() => openFrameworkEditor({ ...systemFramework, name: `${systemFramework.name}副本`, id: "" })}>
              复制为自定义框架 ↗
            </button>
          </article>
          {frameworks.map((framework) => (
            <article className="framework-card" key={framework.id}>
              <div className="framework-card-top"><span>自定义</span><i>{framework.instructions.length.toLocaleString("zh-CN")} 字</i></div>
              <h3>{framework.name}</h3>
              <p>{framework.instructions.replace(/[#>*_\n]/g, " ").trim().slice(0, 92)}{framework.instructions.length > 92 ? "…" : ""}</p>
              <div className="framework-card-actions">
                <button type="button" onClick={() => openFrameworkEditor(framework)}>编辑</button>
                <button type="button" onClick={() => void deleteFramework(framework)}>删除</button>
              </div>
            </article>
          ))}
          {frameworks.length === 0 && (
            <button className="framework-empty" type="button" onClick={() => openFrameworkEditor()}>
              <span>＋</span><strong>写第一份个性化框架</strong><small>最多保存 50 份</small>
            </button>
          )}
        </div>
      </section>

      <footer>
        <p>忠于原声 · 私有保存 · AI 辅助梳理</p>
        <div className="footer-account">
          <span>今日：导入 {viewer.usage?.imports.used ?? 0}/{viewer.usage?.imports.limit ?? 30} · AI {viewer.usage?.ai.used ?? 0}/{viewer.usage?.ai.limit ?? 20}</span>
          {(viewer.authMode === "supabase" || viewer.authMode === "anonymous") && (
            <button type="button" onClick={onDeleteAccount}>删除当前账户与全部资料</button>
          )}
        </div>
      </footer>

      {setupGuideOpen && !connectOpen && !aiModalOpen && (
        <div className="modal-backdrop setup-guide-backdrop" role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setSetupGuideOpen(false)}>
          <section className="connect-modal setup-guide" role="dialog" aria-modal="true" aria-labelledby="setup-guide-title">
            <button className="modal-close" type="button" onClick={() => setSetupGuideOpen(false)} aria-label="关闭">×</button>
            <span className="modal-kicker">START HERE</span>
            <h2 id="setup-guide-title">进入声笺前，确认两项连接</h2>
            <p>连接后即可提取官方文稿，并使用 AI 生成内容梳理与学习 Prompt。</p>
            <div className="setup-steps">
              <article className={account?.connected ? "complete" : ""}>
                <span className="setup-step-no">01</span>
                <div><h3>连接小宇宙</h3><p>登录你的账号，用于读取主动提交单集的官方文稿。</p></div>
                <button type="button" disabled={loading || Boolean(account?.connected)} onClick={() => {
                  setSetupGuideOpen(false);
                  setConnectOpen(true);
                }}>{loading ? "检查中…" : account?.connected ? "已连接" : "连接账号"}</button>
              </article>
              <article className={aiSettings.defaultProvider ? "complete" : ""}>
                <span className="setup-step-no">02</span>
                <div><h3>设置 AI 提供商</h3><p>连接 DeepSeek 或自定义 API，用于生成内容梳理和学习 Prompt。</p></div>
                <button type="button" disabled={loading || Boolean(aiSettings.defaultProvider)} onClick={() => {
                  setSetupGuideOpen(false);
                  setAiModalOpen(true);
                }}>{loading ? "检查中…" : aiSettings.defaultProvider ? "已连接" : "去设置"}</button>
              </article>
            </div>
            <button className="text-action setup-later" type="button" onClick={() => setSetupGuideOpen(false)}>稍后再设置</button>
          </section>
        </div>
      )}

      {connectOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConnectOpen(false)}>
          <form className="connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" onSubmit={(event) => void connectAccount(event)}>
            <button className="modal-close" type="button" onClick={() => setConnectOpen(false)} aria-label="关闭">×</button>
            <span className="modal-kicker">PRIVATE CONNECTION</span>
            <h2 id="connect-title">连接小宇宙账号</h2>
            <p>官方文稿接口需要账号授权。发送短信前会进行一次安全验证，令牌仅在服务端加密保存。</p>
            <div className="phone-row">
              <label><span>区号</span><input value={areaCode} onChange={(event) => setAreaCode(event.target.value)} /></label>
              <label className="phone-input"><span>手机号</span><input inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="请输入手机号" /></label>
            </div>
            {codeSent && <label className="code-input"><span>短信验证码</span><input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} placeholder="输入验证码" /></label>}
            {codeSent ? (
              <button className="primary-action" type="submit" disabled={connecting || !phone || !code}>
                {connecting ? "请稍候…" : "完成连接"}
              </button>
            ) : (
              <button className="primary-action" type="button" disabled={connecting || !phone} onClick={() => void sendCode()}>
                {connecting ? "请稍候…" : "发送验证码"}
              </button>
            )}
            {codeSent && <button className="text-action" type="button" disabled={connecting} onClick={() => void sendCode()}>重新发送验证码</button>}
            <small>继续即表示仅授权本网站读取你主动提交的单集官方文稿。</small>
            <XiaoyuzhouCaptcha ref={captchaRef} />
          </form>
        </div>
      )}

      {aiModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeAiModal()}>
          <section className="connect-modal ai-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
            <button className="modal-close" type="button" onClick={closeAiModal} aria-label="关闭">×</button>
            <span className="modal-kicker">AI PROVIDER</span>
            <h2 id="ai-settings-title">AI 提供商设置</h2>
            <p>生成时，所选文稿和梳理框架会发送给默认提供商。Key 仅提交一次，并在服务端使用 AES-GCM 加密保存。</p>
            <div className="ai-provider-grid">
              <form className="ai-provider-form" onSubmit={(event) => void saveDeepseekSettings(event)}>
                <div className="ai-provider-card">
                  <div><strong>DeepSeek</strong><small>{aiSettings.providers.deepseek.model} · 固定模型</small></div>
                  <span className={aiSettings.providers.deepseek.connected ? "connected" : ""}>
                    {aiSettings.providers.deepseek.connected ? `已连接 ${aiSettings.providers.deepseek.keyHint}` : "未连接"}
                  </span>
                </div>
                {aiSettings.defaultProvider === "deepseek" && <span className="provider-default-chip">默认</span>}
                <label className="code-input">
                  <span>{aiSettings.providers.deepseek.connected ? "替换 API Key" : "DeepSeek API Key"}</span>
                  <input type="password" autoComplete="new-password" value={deepseekApiKey}
                    onChange={(event) => setDeepseekApiKey(event.target.value)} placeholder="sk-…" />
                </label>
                <button className="primary-action" type="submit" disabled={aiSaving || !deepseekApiKey.trim()}>
                  {aiSaving ? "保存中…" : aiSettings.providers.deepseek.connected ? "保存新 Key" : "加密保存并连接"}
                </button>
                {aiSettings.providers.deepseek.connected && (
                  <div className="provider-default-action">
                    <button type="button" disabled={aiSaving || aiSettings.defaultProvider === "deepseek"}
                      onClick={() => void setDefaultAiProvider("deepseek")}>
                      {aiSettings.defaultProvider === "deepseek" ? "当前默认提供商" : "设为默认"}
                    </button>
                    <button className="danger-text-action" type="button" disabled={aiSaving} onClick={() => void disconnectAi("deepseek")}>
                      删除已保存的 Key
                    </button>
                  </div>
                )}
                <small>网站不会显示、下载或记录完整 Key。请确认 DeepSeek 账户余额充足后再生成。</small>
              </form>

              <form className="ai-provider-form" onSubmit={(event) => void saveCustomSettings(event)}>
                <div className="ai-provider-card">
                  <div><strong>自定义 API</strong><small>{aiSettings.providers.custom.model ?? "填写模型 ID 后连接"}</small></div>
                  <span className={aiSettings.providers.custom.connected ? "connected" : ""}>
                    {aiSettings.providers.custom.connected ? `已连接 ${aiSettings.providers.custom.keyHint}` : "未连接"}
                  </span>
                </div>
                {aiSettings.defaultProvider === "custom" && <span className="provider-default-chip">默认</span>}
                <button className="preset-action" type="button" onClick={applyCodexPreset}>Codex 中转预设</button>
                <small className="preset-note">Base URL 与 Key 仍须手动填写。</small>
                <div className="provider-field-row">
                  <label>
                    <span>Base URL</span>
                    <input type="url" autoComplete="url" value={customBaseUrl} onChange={(event) => setCustomBaseUrl(event.target.value)} placeholder="输入服务地址" />
                  </label>
                  <label>
                    <span>模型 ID</span>
                    <input autoComplete="off" value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="例如：your-model" />
                  </label>
                </div>
                <label className="code-input">
                  <span>{aiSettings.providers.custom.connected ? "替换 API Key" : "API Key"}</span>
                  <input type="password" autoComplete="new-password" value={customApiKey}
                    onChange={(event) => setCustomApiKey(event.target.value)} placeholder="输入 API Key" />
                </label>
                <div className="provider-field-row">
                  <label>
                    <span>接口格式</span>
                    <select value={customApiFormat} onChange={(event) => setCustomApiFormat(event.target.value as "responses" | "chat_completions")}>
                      <option value="responses">Responses（支持推理强度）</option>
                      <option value="chat_completions">Chat Completions（兼容格式）</option>
                    </select>
                  </label>
                  {customApiFormat === "responses" && (
                    <label>
                      <span>推理强度</span>
                      <select value={customReasoningEffort ?? ""} onChange={(event) => setCustomReasoningEffort(event.target.value ? event.target.value as ReasoningEffort : null)}>
                        <option value="">不发送推理强度</option>
                        <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
                      </select>
                    </label>
                  )}
                </div>
                <button className="primary-action" type="submit" disabled={aiSaving || !customApiKey.trim() || !customBaseUrl.trim() || !customModel.trim()}>
                  {aiSaving ? "保存中…" : aiSettings.providers.custom.connected ? "保存并替换配置" : "加密保存并连接"}
                </button>
                {aiSettings.providers.custom.connected && (
                  <div className="provider-default-action">
                    <button type="button" disabled={aiSaving || aiSettings.defaultProvider === "custom"}
                      onClick={() => void setDefaultAiProvider("custom")}>
                      {aiSettings.defaultProvider === "custom" ? "当前默认提供商" : "设为默认"}
                    </button>
                    <button className="danger-text-action" type="button" disabled={aiSaving} onClick={() => void disconnectAi("custom")}>
                      删除自定义 API
                    </button>
                  </div>
                )}
                <small>请使用你有权访问的服务地址与 Key；网站不会显示、下载或记录完整 Key。</small>
              </form>
            </div>
          </section>
        </div>
      )}

      {frameworkModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setFrameworkModalOpen(false)}>
          <form className="framework-modal" role="dialog" aria-modal="true" aria-labelledby="framework-modal-title" onSubmit={(event) => void saveFramework(event)}>
            <button className="modal-close" type="button" onClick={() => setFrameworkModalOpen(false)} aria-label="关闭">×</button>
            <span className="modal-kicker">MARKDOWN INSTRUCTIONS</span>
            <h2 id="framework-modal-title">{editingFrameworkId ? "编辑梳理框架" : "新建梳理框架"}</h2>
            <label><span>框架名称</span><input value={frameworkName} onChange={(event) => setFrameworkName(event.target.value)} maxLength={60} placeholder="例如：投资研究笔记" /></label>
            <label className="framework-editor-label">
              <span>Markdown 指令</span>
              <textarea value={frameworkInstructions} onChange={(event) => setFrameworkInstructions(event.target.value)}
                minLength={100} maxLength={20000} spellCheck={false} />
            </label>
            <div className="framework-modal-meta"><span>100–20,000 字</span><span>{frameworkInstructions.length.toLocaleString("zh-CN")} 字</span></div>
            <button className="primary-action" type="submit" disabled={frameworkSaving || !frameworkName.trim() || frameworkInstructions.length < 100}>
              {frameworkSaving ? "保存中…" : "保存框架"}
            </button>
          </form>
        </div>
      )}

      {selected && (
        <div className="document-drawer" role="dialog" aria-modal="true" aria-labelledby="document-title">
          <div className="drawer-header">
            <div><span>{selected.podcastTitle}</span><h2 id="document-title">{selected.title}</h2></div>
            <button className="drawer-close" type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => setSelected(null)} aria-label="关闭文稿">×</button>
          </div>
          <nav className="document-tabs" aria-label="文稿内容">
            <button className={documentTab === "transcript" ? "active" : ""} type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => switchDocumentTab("transcript")}>文稿</button>
            <button className={documentTab === "summary" ? "active" : ""} type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => switchDocumentTab("summary")}>内容梳理</button>
            <button className={documentTab === "learning_prompt" ? "active" : ""} type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => switchDocumentTab("learning_prompt")}>学习 Prompt</button>
          </nav>

          {documentTab === "transcript" ? (
            <div className="document-toolbar">
              <div className="mode-switch">
                <button className={editorMode === "preview" ? "active" : ""} type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => setEditorMode("preview")}>阅读</button>
                <button className={editorMode === "edit" ? "active" : ""} type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => setEditorMode("edit")}>编辑 Markdown</button>
              </div>
              <div className="document-actions">
                <div className="document-action-scroll">
                  <button type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => void copyText(markdown, "Markdown 已复制")}>复制</button>
                  <button type="button" disabled={speakerProcessing || cleanupProcessing} onClick={() => void downloadFile(`/api/episodes/${selected.eid}/download`, `${selected.title}.md`)}>下载 .md</button>
                  <button type="button" disabled={cleanupProcessing || speakerProcessing} onClick={() => void cleanupTranscript()}>AI 整理</button>
                  {cleanupUndoAvailable && <button type="button" disabled={cleanupProcessing || speakerProcessing} onClick={() => void undoCleanup()}>撤销 AI 整理</button>}
                  <SpeakerDiarizationPanel
                    episode={selected}
                    onSaved={(nextMarkdown) => { setMarkdown(nextMarkdown); setEditorMode("preview"); void loadEpisodes(); }}
                    reportNotice={setNotice}
                    onBusyChange={setSpeakerProcessing}
                    disabled={cleanupProcessing}
                  />
                  {editorMode === "edit" && <button className="save-button" type="button" disabled={saving || speakerProcessing || cleanupProcessing} onClick={() => void saveDocument()}>{saving ? "保存中…" : "保存编辑"}</button>}
                </div>
                <details className="document-more-actions">
                  <summary>更多</summary>
                  <div className="document-more-menu">
                    <button type="button" disabled={importing || speakerProcessing || cleanupProcessing} onClick={() => void importEpisode(undefined, true)}>重新获取原稿</button>
                    <button className="danger-button" type="button"
                      disabled={deletingEid === selected.eid || saving || generating || importing || speakerProcessing || cleanupProcessing}
                      onClick={() => void deleteEpisode()}>{deletingEid === selected.eid ? "删除中…" : "删除文稿"}</button>
                  </div>
                </details>
              </div>
            </div>
          ) : (
            <div className="analysis-toolbar">
              <div className="analysis-selects">
                {documentTab === "summary" && (
                    <label><span>梳理框架</span><select disabled={cleanupProcessing} value={selectedFrameworkId} onChange={(event) => changeFramework(event.target.value)}>
                    {frameworkOptions.map((framework) => <option key={framework.id} value={framework.id}>{framework.name}{framework.isDeleted ? "（已删除）" : ""}</option>)}
                  </select></label>
                )}
                <label><span>分析来源</span><select disabled={cleanupProcessing} value={analysisSource} onChange={(event) => setAnalysisSource(event.target.value as "original" | "current")}>
                  <option value="current">当前编辑稿</option><option value="original">官方原稿</option>
                </select></label>
              </div>
              <div className="analysis-actions">
                {selectedAnalysis?.stale && <span className="stale-badge">分析已过期</span>}
                {selectedAnalysis && <span className="analysis-meta">{selectedAnalysis.sourceType === "current" ? "编辑稿" : "原稿"} · {dateLabel(selectedAnalysis.generatedAt)}</span>}
                {analysisMarkdown && <button type="button" disabled={cleanupProcessing} onClick={() => void copyText(analysisMarkdown, "分析 Markdown 已复制")}>复制</button>}
                {selectedAnalysis && <button type="button" disabled={cleanupProcessing} onClick={() => void downloadFile(`/api/episodes/${selected.eid}/analyses/download?slot=${encodeURIComponent(selectedSlot)}`, `${selected.title}-${documentTab === "summary" ? "内容梳理" : "学习Prompt"}.md`)}>下载 .md</button>}
                <button className="save-button" type="button" disabled={generating || cleanupProcessing || Boolean(selectedFramework?.isDeleted)} onClick={() => void generateAnalysis()}>
                  {generating ? "AI 正在阅读全文…" : selectedAnalysis ? "重新生成" : "开始生成"}
                </button>
              </div>
            </div>
          )}

          <div className="document-body">
            {documentTab === "transcript" ? (
              documentLoading ? <div className="document-loading">正在读取 Markdown…</div>
                : cleanupProcessing ? <div className="cleanup-status" role="status" aria-live="polite"><strong>{cleanupProgress}</strong><span>请保持页面打开，当前文稿会在完成后更新。</span></div>
                : editorMode === "edit" ? <textarea aria-label="Markdown 编辑器" disabled={cleanupProcessing} value={markdown} onChange={(event) => setMarkdown(event.target.value)} spellCheck={false} />
                  : <>
                    {cleanupStats && <div className="cleanup-summary" role="status" aria-live="polite">
                      <strong>AI 整理统计</strong>
                      <span>处理 {cleanupStats.processedBlocks} 段 · 变更 {cleanupStats.changedBlocks} 段</span>
                      <span>删除语气词 {cleanupStats.fillerRemoved} · 合并重复 {cleanupStats.repetitionsMerged} · 修正错字 {cleanupStats.typosFixed}</span>
                      <span>未处理 {cleanupStats.unprocessedBlocks} 段{speakerLayoutStale ? " · 说话人布局需重新生成" : ""}</span>
                    </div>}
                    <MarkdownPreview markdown={markdown} hideEpisodeMeta />
                  </>
            ) : analysisLoading ? (
              <div className="document-loading">正在读取分析结果…</div>
            ) : generating ? (
              <div className="analysis-empty"><span>AI</span><h3>正在覆盖全文并生成 Markdown</h3><p>长文稿会先分段提炼，再统一汇总。请保持页面打开。</p></div>
            ) : analysisMarkdown ? (
              <MarkdownPreview markdown={analysisMarkdown} analysisPreview={documentTab === "summary"} />
            ) : (
              <div className="analysis-empty">
                <span>{documentTab === "summary" ? "纲" : "问"}</span>
                <h3>{documentTab === "summary" ? "用你的框架梳理全文" : "生成一份播客专属学习 Prompt"}</h3>
                <p>{documentTab === "summary" ? "选择框架与文稿版本后手动生成。AI 会保留时间戳，并区分事实、归纳和不确定内容。"
                  : "AI 会提炼知识背景、追问流程、案例、实践任务和自测方式，可直接转发给另一个 AI。"}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
