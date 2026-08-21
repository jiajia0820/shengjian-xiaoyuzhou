import { deleteConnection } from "@/lib/db";
import { persistTokens } from "@/lib/connection";
import { apiError, HttpError, requireApiUser } from "@/lib/user";
import { loginWithSms } from "@/lib/xiaoyuzhou";

export async function POST(request: Request) {
  try {
    const user = await requireApiUser({ mutation: true });
    const body = await request.json() as Record<string, unknown>;
    const phone = String(body.phone ?? "").replace(/[\s-]/g, "");
    const areaCode = String(body.areaCode ?? "+86").trim();
    const code = String(body.code ?? "").trim();
    if (!/^\d{6,20}$/.test(phone) || !/^\+\d{1,4}$/.test(areaCode)) {
      throw new HttpError(400, "INVALID_PHONE", "请输入有效手机号和国际区号");
    }
    if (!/^\d{4,8}$/.test(code)) throw new HttpError(400, "INVALID_CODE", "请输入短信验证码");
    const tokens = await loginWithSms(phone, areaCode, code);
    await persistTokens(user.userId, phone, tokens);
    return Response.json({ connected: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE() {
  try {
    const user = await requireApiUser({ mutation: true });
    await deleteConnection(user.userId);
    return Response.json({ connected: false });
  } catch (error) {
    return apiError(error);
  }
}
