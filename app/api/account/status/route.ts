import { getConnection } from "@/lib/db";
import { apiError, requireApiUser } from "@/lib/user";

export async function GET() {
  try {
    const user = await requireApiUser();
    const connection = await getConnection(user.userId);
    return Response.json({
      connected: Boolean(connection),
      phoneHint: connection?.phone_hint ?? null,
      connectedAt: connection?.connected_at ?? null,
      displayName: user.displayName,
    });
  } catch (error) {
    return apiError(error);
  }
}
