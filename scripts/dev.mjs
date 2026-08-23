import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startXiaoyuzhouDevProxy } from "./dev-upstream-proxy.mjs";

const vinextCli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));

const proxy = await startXiaoyuzhouDevProxy();
const child = spawn(process.execPath, [vinextCli, "dev", ...process.argv.slice(2)], {
  env: {
    ...process.env,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || "1",
    XIAOYUZHOU_DEV_PROXY_URL: proxy.url,
    XIAOYUZHOU_DEV_PROXY_TOKEN: proxy.token,
  },
  stdio: "inherit",
});

let shuttingDown = false;
const closeProxy = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await proxy.close();
};

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
  void closeProxy();
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("error", (error) => {
  console.error(`无法启动本地开发服务器：${error.message}`);
  void closeProxy();
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  void closeProxy().finally(() => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
});
