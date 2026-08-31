"use client";

import { FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/auth-client";

type Message = { role: "user" | "assistant"; content: string; createdAt: string };
type AssistantContext = {
  source: "official_timestamp" | "official_keyword" | "summary_only";
  timestamps: string[];
  summarySection: string | null;
};

type Props = {
  eid: string;
  episodeTitle: string;
  podcastTitle: string;
  slot: string;
  selectedText: string;
  defaultRole: string;
  onClose: () => void;
  onCollapsedChange?: (collapsed: boolean) => void;
};

const STORAGE_PREFIX = "shengjian:analysis-assistant:v1:";
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8_000;

function storageKey(eid: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(eid)}`;
}

function readSession(eid: string, defaultRole: string): { role: string; messages: Message[] } {
  if (typeof window === "undefined") return { role: defaultRole, messages: [] };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(eid)) ?? "null") as { role?: unknown; messages?: unknown } | null;
    const messages = Array.isArray(parsed?.messages) ? parsed.messages.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return [];
      const content = value.content.trim();
      return content ? [{ role: value.role, content: Array.from(content).slice(0, MAX_MESSAGE_CHARS).join(""), createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString() } as Message] : [];
    }).slice(-MAX_MESSAGES) : [];
    const role = typeof parsed?.role === "string" && parsed.role.trim() ? parsed.role.trim().slice(0, 160) : defaultRole;
    return { role, messages };
  } catch {
    return { role: defaultRole, messages: [] };
  }
}

function contextLabel(context: AssistantContext): string {
  if (context.source === "official_timestamp") {
    return `官方原文 · ${context.timestamps.length ? context.timestamps.join("、") : "已按时间戳截取"}`;
  }
  if (context.source === "official_keyword") return "官方原文 · 关键词匹配，可能相关";
  return "当前梳理 · 官方原文暂不可用";
}

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || "AI 助手暂时无法回答，请稍后重试");
  return data;
}

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function AnalysisAssistant({ eid, episodeTitle, podcastTitle, slot, selectedText, defaultRole, onClose, onCollapsedChange }: Props) {
  const initialSession = useMemo(() => readSession(eid, defaultRole), [eid, defaultRole]);
  const [role, setRole] = useState(initialSession.role);
  const [messages, setMessages] = useState<Message[]>(initialSession.messages);
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey(eid), JSON.stringify({ role, messages: messages.slice(-MAX_MESSAGES) }));
    } catch {
      // 浏览器禁用本地存储时仍可继续当前会话。
    }
  }, [eid, messages, role]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || loading) return;
    const userMessage: Message = { role: "user", content: text, createdAt: new Date().toISOString() };
    const history = messages.slice(-8).map(({ role: messageRole, content }) => ({ role: messageRole, content }));
    setMessages((current) => [...current, userMessage].slice(-MAX_MESSAGES));
    setQuestion("");
    setError("");
    setLoading(true);
    try {
      const data = await readResponse<{ answer: string; context: AssistantContext }>(await apiFetch(`/api/episodes/${eid}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, selectedText, role, question: text, history }),
      }));
      setContext(data.context);
      setMessages((current) => [...current, { role: "assistant" as const, content: data.answer, createdAt: new Date().toISOString() }].slice(-MAX_MESSAGES));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "AI 助手暂时无法回答，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  function handleQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function toggleCollapsed() {
    const next = !isCollapsed;
    setIsCollapsed(next);
    onCollapsedChange?.(next);
  }

  return (
    <aside className={`analysis-assistant${isCollapsed ? " is-collapsed" : ""}`} aria-label="AI 助手">
      <header className="analysis-assistant-header">
        <div className="analysis-assistant-header-copy">
          <span className="analysis-assistant-kicker">CONTINUE THE THREAD</span>
          <h3>AI 助手</h3>
          <p title={episodeTitle}>{podcastTitle} · {episodeTitle}</p>
        </div>
        <div className="analysis-assistant-header-actions">
          <button
            className="analysis-assistant-toggle"
            type="button"
            onClick={toggleCollapsed}
            aria-label={isCollapsed ? "展开 AI 助手" : "最小化 AI 助手"}
            aria-expanded={!isCollapsed}
          >{isCollapsed ? "＋" : "−"}</button>
          <button className="analysis-assistant-close" type="button" onClick={onClose} aria-label="关闭 AI 助手">×</button>
        </div>
      </header>

      <div className="analysis-assistant-content" hidden={isCollapsed}>
        <div className="analysis-assistant-role">
          <label htmlFor="analysis-assistant-role">回答身份</label>
          <input id="analysis-assistant-role" value={role} maxLength={160} onChange={(event) => setRole(event.target.value)} />
          <small>只决定解释角度，事实以本期文稿为准。</small>
        </div>

        <div className="analysis-assistant-context" role="status" aria-live="polite">
          <strong>本次引用</strong>
          <span>{context ? contextLabel(context) : "当前梳理小节 + 官方原文局部片段"}</span>
          <blockquote>{selectedText}</blockquote>
        </div>

        <div className="analysis-assistant-messages" aria-live="polite">
          {!messages.length && <p className="analysis-assistant-empty">围绕选中的内容提问。助手会优先给出原文依据，没有证据时会标明不确定。</p>}
          {messages.map((message, index) => (
            <article className={`analysis-assistant-message ${message.role}`} key={`${message.createdAt}-${index}`}>
              <div className="analysis-assistant-message-meta">{message.role === "user" ? "你" : "AI"}{messageTime(message.createdAt) ? ` · ${messageTime(message.createdAt)}` : ""}</div>
              <div className="analysis-assistant-message-body">{message.content}</div>
            </article>
          ))}
          {loading && <div className="analysis-assistant-loading" role="status">正在结合原文回答…</div>}
          {error && <div className="analysis-assistant-error" role="alert">{error}</div>}
        </div>

        <form className="analysis-assistant-form" onSubmit={submit}>
          <label htmlFor="analysis-assistant-question">继续提问</label>
          <textarea id="analysis-assistant-question" value={question} maxLength={2_000} rows={3} placeholder="例如：这段判断的原文依据是什么？" onChange={(event) => setQuestion(event.target.value)} onKeyDown={handleQuestionKeyDown} disabled={loading} />
          <div className="analysis-assistant-form-footer"><small>{question.length}/2000</small><button className="save-button" type="submit" disabled={loading || !question.trim()}>{loading ? "回答中…" : "发送"}</button></div>
        </form>
      </div>
    </aside>
  );
}
