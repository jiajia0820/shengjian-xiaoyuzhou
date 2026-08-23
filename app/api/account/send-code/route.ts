import { apiError, HttpError, requireApiUser } from "@/lib/user";
import { normalizeXiaoyuzhouCaptcha, type XiaoyuzhouCaptcha } from "@/lib/xiaoyuzhou-auth";
import { sendSmsCode } from "@/lib/xiaoyuzhou";

function validate(body: unknown): { phone: string; areaCode: string; captcha: XiaoyuzhouCaptcha } {
  const value = body as Record<string, unknown>;
  const phone = String(value?.phone ?? "").replace(/[\s-]/g, "");
  const areaCode = String(value?.areaCode ?? "+86").trim();
  if (!/^\d{6,20}$/.test(phone)) throw new HttpError(400, "INVALID_PHONE", "请输入有效手机号");
  if (!/^\+\d{1,4}$/.test(areaCode)) throw new HttpError(400, "INVALID_AREA_CODE", "请输入有效国际区号");
  const captcha = normalizeXiaoyuzhouCaptcha(value?.captcha);
  if (!captcha) throw new HttpError(400, "INVALID_CAPTCHA", "请先完成安全验证");
  return { phone, areaCode, captcha };
}

export async function POST(request: Request) {
  try {
    await requireApiUser({ mutation: true });
    const input = validate(await request.json());
    await sendSmsCode(input.phone, input.areaCode, input.captcha);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
