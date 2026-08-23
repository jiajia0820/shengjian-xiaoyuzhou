export type XiaoyuzhouCaptchaScene = "web" | "h5";

export type XiaoyuzhouCaptcha = {
  scene: XiaoyuzhouCaptchaScene;
  verifyParam: string;
};

const MAX_VERIFY_PARAM_LENGTH = 4096;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function normalizeXiaoyuzhouCaptcha(value: unknown): XiaoyuzhouCaptcha | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scene = candidate.scene;
  const verifyParam = typeof candidate.verifyParam === "string" ? candidate.verifyParam.trim() : "";
  if ((scene !== "web" && scene !== "h5") || !verifyParam || verifyParam.length > MAX_VERIFY_PARAM_LENGTH) {
    return null;
  }
  return { scene, verifyParam };
}

export function buildSmsCodeRequestBody(
  phone: string,
  areaCode: string,
  captcha: XiaoyuzhouCaptcha,
): { mobilePhoneNumber: string; areaCode: string; captcha: XiaoyuzhouCaptcha } {
  return {
    mobilePhoneNumber: phone,
    areaCode,
    captcha,
  };
}
