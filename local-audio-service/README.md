# 本地音频说话人识别服务（实验性）

此目录提供一个只监听 `127.0.0.1:8765` 的本机服务。网页把你选择的音频直接交给这个服务；音频不会经过本项目的 Worker、R2 或任何第三方推理接口。服务只返回匿名时间区间（`speaker_0`、`speaker_1` 等），网页再把已保存的小宇宙官方文稿按说话人轮次分段。

## 使用前提

- Windows、Python 3.12 和 FFmpeg（含 `ffprobe`）已安装并在 PATH 中；
- 你的音频不超过 2 小时、文件不超过 1GB；
- 你有权在本机处理该音频。节目内容的版权与本仓库代码许可彼此独立；
- 接受 [pyannote speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) 的模型使用条件。

代码使用 `pyannote.audio`；模型本身的条款以 Hugging Face 模型页为准。

## 安装与启动

在项目根目录的 PowerShell 中依次执行：

```powershell
./scripts/setup-local-speaker-service.ps1
./local-audio-service/.venv/Scripts/hf.exe auth login
./scripts/start-local-speaker-service.ps1
```

安装脚本检测到 NVIDIA GPU 时会优先安装 CUDA 12.8 版 PyTorch；没有 NVIDIA GPU 时安装 CPU 版。可用 `SPEAKER_TORCH_INDEX_URL` 临时覆盖 wheel 地址。`.venv/Scripts/hf.exe auth login` 会在本机保存 Hugging Face 凭据；首次运行需要联网下载 pyannote 模型。模型缓存完成后，音频推理在本机执行。请不要把 token 写入 `.env`、仓库、浏览器配置或截图；服务会从本机 Hugging Face 登录状态读取它，也可读取你临时设置的 `HF_TOKEN` 环境变量。

若网页部署在非 `localhost:3000` 的地址，启动服务前只需在当前 PowerShell 会话设置受信任网页 Origin，例如：

```powershell
$env:SPEAKER_ALLOWED_ORIGINS = "https://your-app.example"
./scripts/start-local-speaker-service.ps1
```

不要使用 `*`；服务只接受明确列出的 Origin、`X-Speaker-Client-Version: 1` 请求头和回环地址的连接。

## 资源、取消与隐私

- 默认使用 `SPEAKER_DEVICE=auto`：CUDA 可用时优先使用 GPU，CUDA 不可用或模型无法移入显存时回退 CPU。可显式设置 `SPEAKER_DEVICE=cpu` 强制 CPU。
- MX450 只有 2GB 显存，部分阶段可能因显存不足回退 CPU；健康接口会报告本次服务实际使用的 `cuda` 或 `cpu`。
- 最长 2 小时、最大 1GB。音频按 10 分钟核心窗口和 15 秒重叠分块处理，每完成一块更新进度。
- 超过 2 小时或 1GB 的音频会在页面和服务端拒绝，不会开始识别。
- 取消任务后，正在执行的模型调用可能需要自然结束，但它的结果不会发布；临时音频和中间目录会在任务结束后的自动清理周期内删除。服务重启时会清理遗留任务目录。
- 服务不记录音频内容、完整文件名、文稿正文、说话人结果或 Hugging Face token。
- 此端口仅用于回环地址。不要改为 `0.0.0.0`，也不要通过端口转发暴露它。
