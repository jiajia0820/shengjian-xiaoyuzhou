"use client";

import { FormEvent, type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
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
  assistantWidth?: number | null;
  onWidthChange?: (width: number) => void;
  onWidthReset?: () => void;
};

const STORAGE_PREFIX = "shengjian:analysis-assistant:v1:";
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8_000;
const MIN_ASSISTANT_WIDTH = 320;
const MAX_ASSISTANT_WIDTH = 720;

function assistantDefaultWidth(viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth): number {
  return viewportWidth <= 720 ? Math.min(430, Math.max(240, viewportWidth * 0.5)) : 430;
}

function assistantWidthBounds(): { min: number; max: number } {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  const min = viewportWidth <= 720
    ? Math.min(MIN_ASSISTANT_WIDTH, Math.max(240, viewportWidth * 0.5))
    : MIN_ASSISTANT_WIDTH;
  const max = Math.max(min, Math.min(MAX_ASSISTANT_WIDTH, viewportWidth - 280));
  return { min, max };
}

function clampAssistantWidth(width: number): number {
  const bounds = assistantWidthBounds();
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

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

export function AnalysisAssistant({ eid, slot, selectedText, defaultRole, onClose, onCollapsedChange, assistantWidth, onWidthChange, onWidthReset }: Props) {
  const initialSession = useMemo(() => readSession(eid, defaultRole), [eid, defaultRole]);
  const [role, setRole] = useState(initialSession.role);
  const [messages, setMessages] = useState<Message[]>(initialSession.messages);
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const assistantRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey(eid), JSON.stringify({ role, messages: messages.slice(-MAX_MESSAGES) }));
    } catch {
      // 浏览器禁用本地存储时仍可继续当前会话。
    }
  }, [eid, messages, role]);

  useEffect(() => {
    if (assistantWidth == null) return;
    const width = assistantWidth;
    function syncAssistantWidth() {
      if (window.innerWidth <= 560) return;
      const next = clampAssistantWidth(width);
      if (next !== width) onWidthChange?.(next);
    }
    window.addEventListener("resize", syncAssistantWidth);
    return () => window.removeEventListener("resize", syncAssistantWidth);
  }, [assistantWidth, onWidthChange]);

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

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (typeof window !== "undefined" && window.innerWidth <= 560) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: assistantRef.current?.getBoundingClientRect().width ?? assistantWidth ?? assistantDefaultWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
    event.preventDefault();
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    onWidthChange?.(clampAssistantWidth(resize.startWidth + resize.startX - event.clientX));
    event.preventDefault();
  }

  function finishResize(event: PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
    setIsResizing(false);
  }

  function adjustResize(event: KeyboardEvent<HTMLDivElement>) {
    if (typeof window !== "undefined" && window.innerWidth <= 560) return;
    const bounds = assistantWidthBounds();
    const current = clampAssistantWidth(assistantRef.current?.getBoundingClientRect().width ?? assistantWidth ?? 430);
    let next = current;
    if (event.key === "ArrowLeft") next += 24;
    else if (event.key === "ArrowRight") next -= 24;
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = bounds.max;
    else return;
    event.preventDefault();
    onWidthChange?.(clampAssistantWidth(next));
  }

  const resizeBounds = assistantWidthBounds();
  const resizeValue = Math.round(clampAssistantWidth(assistantWidth ?? assistantDefaultWidth()));

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <aside ref={assistantRef} className={`analysis-assistant${isCollapsed ? " is-collapsed" : ""}`} aria-label="AI 助手">
      <button
        className="analysis-assistant-collapsed-icon"
        type="button"
        hidden={!isCollapsed}
        onClick={toggleCollapsed}
        aria-label="展开 AI 助手"
        title="展开 AI 助手"
      >AI</button>
      <div
        className={`analysis-assistant-resize-handle${isResizing ? " is-active" : ""}`}
        role="separator"
        tabIndex={0}
        aria-label="调整 AI 助手宽度"
        aria-orientation="vertical"
        aria-valuemin={resizeBounds.min}
        aria-valuemax={resizeBounds.max}
        aria-valuenow={resizeValue}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onDoubleClick={() => onWidthReset?.()}
        onKeyDown={adjustResize}
      />
      <header className="analysis-assistant-header">
        <div className="analysis-assistant-header-copy">
          <div className="analysis-assistant-title-row">
            <h3>AI 助手</h3>
            <details className="analysis-assistant-identity">
              <summary><span>{role}</span></summary>
              <div className="analysis-assistant-identity-body">
                <label htmlFor="analysis-assistant-role">身份</label>
                <input id="analysis-assistant-role" value={role} maxLength={160} onChange={(event) => setRole(event.target.value)} />
                <small>只决定解释角度，事实以本期文稿为准。</small>
              </div>
            </details>
          </div>
        </div>
        <div className="analysis-assistant-header-actions">
          <button className="analysis-assistant-close" type="button" onClick={onClose} aria-label="关闭 AI 助手">×</button>
        </div>
      </header>

      <div className="analysis-assistant-content" hidden={isCollapsed}>
        <details className="analysis-assistant-details">
          <summary><span>本次引用</span><small>{context ? contextLabel(context) : "梳理小节 + 官方原文片段"}</small></summary>
          <blockquote className="analysis-assistant-details-quote" role="status" aria-live="polite">{selectedText || "未选中文字，将结合整份内容梳理。"}</blockquote>
        </details>

        <div className="analysis-assistant-messages" aria-live="polite">
          {!messages.length && <p className="analysis-assistant-empty">{selectedText ? "围绕选中的内容提问。" : "可以先提问整份内容梳理，选中文字后会优先结合该段原文。"}助手会优先给出原文依据，没有证据时会标明不确定。</p>}
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
          <textarea id="analysis-assistant-question" value={question} maxLength={2_000} rows={2} placeholder="例如：这段判断的原文依据是什么？" onChange={(event) => setQuestion(event.target.value)} onKeyDown={handleQuestionKeyDown} disabled={loading} />
          <div className="analysis-assistant-form-footer"><small>{question.length}/2000</small><button className="save-button" type="submit" disabled={loading || !question.trim()}>{loading ? "回答中…" : "发送"}</button></div>
        </form>
      </div>
    </aside>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
