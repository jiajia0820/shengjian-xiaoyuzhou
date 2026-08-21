import type { AiProvider } from "@/lib/ai-provider";
import {
  getAiSettingsStatus,
  removeAiProvider,
  saveAiProvider,
  setDefaultAiProvider,
} from "@/lib/ai-settings";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireProvider(value: unknown): AiProvider {
  if (value === "deepseek" || value === "custom") return value;
  throw new HttpError(400, "INVALID_AI_PROVIDER", "请选择有效的 AI 服务");
}

async function readRequestBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (isRecord(body)) return body;
  } catch {
    // Keep malformed request details out of API responses.
  }
  throw new HttpError(400, "INVALID_REQUEST", "请求格式无效");
}

export async function GET() {
  try {
    const user = await requireApiUser();
    return Response.json(await getAiSettingsStatus(user.userId));
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireApiUser({ mutation: true });
    const body = await readRequestBody(request);
    return Response.json(await saveAiProvider(user.userId, body));
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireApiUser({ mutation: true });
    const body = await readRequestBody(request);
    const provider = requireProvider(body.provider);
    return Response.json(await setDefaultAiProvider(user.userId, provider));
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireApiUser({ mutation: true });
    const provider = requireProvider(new URL(request.url).searchParams.get("provider"));
    return Response.json(await removeAiProvider(user.userId, provider));
  } catch (error) {
    return apiError(error);
  }
}
