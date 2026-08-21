"use client";

import { useCallback, useEffect, useState } from "react";
import Workspace from "./workspace";
import {
  apiFetch, configureAuthClient, type AuthConfig, type Viewer,
} from "@/lib/auth-client";

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || "请求失败，请稍后重试");
  return data;
}

export default function AuthShell() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const loadViewer = useCallback(async () => {
    try {
      const data = await readJson<{ user: Viewer }>(await apiFetch("/api/auth/me", { cache: "no-store" }));
      setViewer(data.user);
      return data.user;
    } catch {
      setViewer(null);
      return null;
    }
  }, []);

  const initialize = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const nextConfig = await readJson<AuthConfig>(await fetch("/api/auth/config", {
        cache: "no-store", credentials: "same-origin",
      }));
      configureAuthClient(nextConfig);
      const current = await loadViewer();
      if (!current) {
        const created = await readJson<{ user: Viewer }>(await apiFetch("/api/auth/anonymous", { method: "POST" }));
        setViewer(created.user);
      }
    } catch (error) {
      setViewer(null);
      setMessage(error instanceof Error ? error.message : "暂时无法创建浏览器账户，请重试");
    } finally {
      setLoading(false);
    }
  }, [loadViewer]);

  useEffect(() => {
    const timer = window.setTimeout(() => void initialize(), 0);
    return () => window.clearTimeout(timer);
  }, [initialize]);

  async function signOut() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    await initialize();
  }

  async function deleteAccount() {
    if (!window.confirm("确认永久删除账号、文稿、框架和分析结果？此操作无法撤销。")) return;
    try {
      await readJson(await apiFetch("/api/auth/account", { method: "DELETE" }));
      window.alert("当前浏览器账户及其全部资料已删除");
      await initialize();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "删除账号失败");
    }
  }

  if (loading) return <main className="auth-loading"><span className="brand-mark">声</span><p>正在打开声笺…</p></main>;

  if (viewer) {
    return <>
      <Workspace viewer={viewer} onSignOut={() => void signOut()} onDeleteAccount={() => void deleteAccount()} />
    </>;
  }

  return (
    <main className="auth-loading auth-error">
      <span className="brand-mark">声</span>
      <h1>暂时无法打开声笺</h1>
      <p>{message ?? "浏览器账户创建失败，请检查网络后重试。"}</p>
      <button className="primary-action" type="button" onClick={() => void initialize()}>
        重新进入工作台
      </button>
    </main>
  );
}
