import { deleteAllUserRecords } from "@/lib/db";
import { deleteUserDocuments } from "@/lib/documents";
import { clearSessionCookies, requestUsesHttps } from "@/lib/request-security";
import { deleteSupabaseAuthUser } from "@/lib/supabase-auth";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

export async function DELETE() {
  try {
    const user = await requireApiUser({ mutation: true });
    if (user.authMode === "legacy") {
      throw new HttpError(409, "ACCOUNT_MANAGEMENT_UNAVAILABLE", "当前管理员身份不能在这里删除");
    }
    if (user.authMode === "supabase" && user.providerSubject) {
      await deleteSupabaseAuthUser(user.providerSubject);
    }
    await deleteUserDocuments(user.userId);
    await deleteAllUserRecords(user.userId);
    return clearSessionCookies(Response.json({ deleted: true }), await requestUsesHttps());
  } catch (error) {
    return apiError(error);
  }
}
