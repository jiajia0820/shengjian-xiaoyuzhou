"use client";

export type AuthConfig = {
  csrfToken: string;
};

export type Viewer = {
  id: string;
  email: string | null;
  displayName: string;
  role: "admin" | "member";
  authMode: "supabase" | "legacy" | "anonymous";
  bootstrapEligible: boolean;
  usage?: {
    date: string;
    imports: { used: number; limit: number };
    ai: { used: number; limit: number };
  };
};

let csrfToken = "";

export function configureAuthClient(config: AuthConfig): void {
  csrfToken = config.csrfToken;
}

function withSecurity(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  return { ...init, credentials: "same-origin", headers };
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, withSecurity(init));
}

export async function downloadWithAuth(url: string, filename: string): Promise<void> {
  const response = await apiFetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message || "下载失败，请稍后重试");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
