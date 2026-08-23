"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
} from "react";
import { withTimeout } from "@/lib/xiaoyuzhou-auth";

export type XiaoyuzhouCaptchaScene = "web" | "h5";

export type XiaoyuzhouCaptchaToken = {
  scene: XiaoyuzhouCaptchaScene;
  verifyParam: string;
};

export type XiaoyuzhouCaptchaHandle = {
  requestToken: () => Promise<XiaoyuzhouCaptchaToken>;
};

type AliyunCaptchaResult = { captchaResult: boolean; bizResult: boolean };
type AliyunCaptchaInstance = { destroy?: () => void };
type AliyunCaptchaOptions = {
  SceneId: string;
  mode: "embed";
  immediate: boolean;
  element: string;
  button: string;
  language: "cn";
  slideStyle: { width: number; height: number };
  captchaVerifyCallback: (verifyParam: string) => Promise<AliyunCaptchaResult>;
  onBizResultCallback: (result: unknown) => void;
  getInstance: (instance: AliyunCaptchaInstance) => void;
};

declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: "cn"; prefix: "kn7vz1" };
    initAliyunCaptcha?: (options: AliyunCaptchaOptions) => void;
  }
}

const ALIYUN_SCRIPT_ID = "aliyun-captcha-script";
const ALIYUN_SCRIPT_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const ALIYUN_SCENE_IDS = {
  web: "80c00qbb",
  h5: "kz7w3toc",
  betaWeb: "hdb4s8qu",
  betaH5: "gxjhswe1",
} as const;

let scriptPromise: Promise<void> | null = null;
const ALIYUN_SCRIPT_TIMEOUT_MS = 10_000;

function loadAliyunCaptchaScript(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("安全验证只能在浏览器中使用"));
  }
  window.AliyunCaptchaConfig = { region: "cn", prefix: "kn7vz1" };
  if (typeof window.initAliyunCaptcha === "function") return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = withTimeout(new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(ALIYUN_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const onLoad = () => {
      if (typeof window.initAliyunCaptcha !== "function") {
        scriptPromise = null;
        reject(new Error("安全验证组件初始化失败"));
        return;
      }
      resolve();
    };
    const onError = () => {
      scriptPromise = null;
      reject(new Error("安全验证组件加载失败，请检查网络后重试"));
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if ((existing as (HTMLScriptElement & { readyState?: string }) | null)?.readyState === "complete") {
      onLoad();
      return;
    }
    if (!existing) {
      script.id = ALIYUN_SCRIPT_ID;
      script.async = true;
      script.src = ALIYUN_SCRIPT_URL;
      document.head.appendChild(script);
    }
  }), ALIYUN_SCRIPT_TIMEOUT_MS, "安全验证组件加载超时，请检查浏览器是否拦截了阿里云验证码").catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

function sceneForBrowser(): XiaoyuzhouCaptchaScene {
  return window.matchMedia("(max-width: 768px)").matches ? "h5" : "web";
}

function sceneIdForBrowser(scene: XiaoyuzhouCaptchaScene): string {
  const isBeta = window.location.hostname.includes("-beta.");
  if (isBeta) return scene === "h5" ? ALIYUN_SCENE_IDS.betaH5 : ALIYUN_SCENE_IDS.betaWeb;
  return scene === "h5" ? ALIYUN_SCENE_IDS.h5 : ALIYUN_SCENE_IDS.web;
}

const XiaoyuzhouCaptcha = forwardRef<XiaoyuzhouCaptchaHandle>(function XiaoyuzhouCaptcha(_props, ref) {
  const elementId = `xiaoyuzhou-captcha-${useId().replace(/:/g, "")}`;
  const buttonId = `${elementId}-trigger`;
  const instanceRef = useRef<AliyunCaptchaInstance | null>(null);
  const pendingRef = useRef<{
    scene: XiaoyuzhouCaptchaScene;
    resolve: (token: XiaoyuzhouCaptchaToken) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const readyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rejectPending = useCallback((message: string) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    if (pending) pending.reject(new Error(message));
  }, []);

  const captchaVerifyCallback = useCallback(async (verifyParam: string): Promise<AliyunCaptchaResult> => {
    const pending = pendingRef.current;
    if (!pending || !verifyParam.trim()) return { captchaResult: false, bizResult: false };
    pendingRef.current = null;
    setOpen(false);
    pending.resolve({ scene: pending.scene, verifyParam: verifyParam.trim() });
    return { captchaResult: true, bizResult: true };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const scene = sceneForBrowser();
    void loadAliyunCaptchaScript().then(() => {
      if (cancelled || typeof window.initAliyunCaptcha !== "function") return;
      try {
        window.initAliyunCaptcha({
          SceneId: sceneIdForBrowser(scene),
          mode: "embed",
          immediate: true,
          element: `#${elementId}`,
          button: `#${buttonId}`,
          language: "cn",
          slideStyle: { width: 320, height: 51 },
          captchaVerifyCallback,
          onBizResultCallback: () => undefined,
          getInstance: (instance) => { instanceRef.current = instance; },
        });
        readyRef.current = true;
        setError(null);
      } catch {
        setError("安全验证组件初始化失败，请刷新页面后重试");
      }
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : "安全验证组件加载失败，请稍后重试");
    });
    return () => {
      cancelled = true;
      readyRef.current = false;
      instanceRef.current?.destroy?.();
      instanceRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) pending.reject(new Error("安全验证已取消"));
    };
  }, [buttonId, captchaVerifyCallback, elementId]);

  useImperativeHandle(ref, () => ({
    requestToken: () => new Promise<XiaoyuzhouCaptchaToken>((resolve, reject) => {
      if (!readyRef.current) {
        reject(new Error(error ?? "安全验证组件加载中，请稍后重试"));
        return;
      }
      if (pendingRef.current) {
        reject(new Error("安全验证正在进行，请完成当前验证"));
        return;
      }
      pendingRef.current = { scene: sceneForBrowser(), resolve, reject };
      setError(null);
      setOpen(true);
      window.requestAnimationFrame(() => {
        document.getElementById(buttonId)?.click();
      });
    }),
  }), [buttonId, error]);

  return (
    <div className={`xiaoyuzhou-captcha-layer${open ? " is-open" : ""}${error ? " has-error" : ""}`} aria-hidden={!open && !error}>
      <div className="xiaoyuzhou-captcha-panel" role="dialog" aria-modal="true" aria-label="安全验证">
        <div id={elementId} className="xiaoyuzhou-captcha-widget" />
        <button
          id={buttonId}
          className="xiaoyuzhou-captcha-trigger"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
        />
        {error && <p className="xiaoyuzhou-captcha-error">{error}</p>}
        {open && <button className="text-action" type="button" onClick={() => rejectPending("安全验证已取消")}>取消验证</button>}
      </div>
    </div>
  );
});

XiaoyuzhouCaptcha.displayName = "XiaoyuzhouCaptcha";

export default XiaoyuzhouCaptcha;
