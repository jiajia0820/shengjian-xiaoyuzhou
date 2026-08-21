import { AI_MODEL, AI_PROVIDER, persistDeepseekApiKey } from "@/lib/ai-settings";
import { deleteAiSetting, getAiSetting } from "@/lib/db";
import { apiError, requireApiUser } from "@/lib/user";

export async function GET() {
  try {
    const user = await requireApiUser();
    const setting = await getAiSetting(user.userId);
    return Response.json({
      connected: Boolean(setting),
      provider: AI_PROVIDER,
      model: AI_MODEL,
      keyHint: setting?.key_hint ?? null,
      connectedAt: setting?.connected_at ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireApiUser({ mutation: true });
    const body = await request.json() as Record<string, unknown>;
    await persistDeepseekApiKey(user.userId, String(body.apiKey ?? ""));
    const setting = await getAiSetting(user.userId);
    return Response.json({
      connected: true,
      provider: AI_PROVIDER,
      model: AI_MODEL,
      keyHint: setting?.key_hint ?? null,
      connectedAt: setting?.connected_at ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE() {
  try {
    const user = await requireApiUser({ mutation: true });
    await deleteAiSetting(user.userId);
    return Response.json({
      connected: false,
      provider: AI_PROVIDER,
      model: AI_MODEL,
      keyHint: null,
      connectedAt: null,
    });
  } catch (error) {
    return apiError(error);
  }
}
