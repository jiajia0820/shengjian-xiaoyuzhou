import { env } from "cloudflare:workers";

export type AppEnv = {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  TOKEN_ENCRYPTION_KEY: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  TENCENT_CAPTCHA_APP_ID?: string;
  TENCENT_CAPTCHA_APP_SECRET_KEY?: string;
  TENCENT_SECRET_ID?: string;
  TENCENT_SECRET_KEY?: string;
  ORIGIN_GATEWAY_SECRET?: string;
  APP_PUBLIC_HOST?: string;
  /** Local-only host proxy injected by scripts/dev.mjs. */
  XIAOYUZHOU_DEV_PROXY_URL?: string;
  /** Local-only shared secret for the development upstream proxy. */
  XIAOYUZHOU_DEV_PROXY_TOKEN?: string;
};

export function getRuntimeEnv(): AppEnv {
  return env as unknown as AppEnv;
}
