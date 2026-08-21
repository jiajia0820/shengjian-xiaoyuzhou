# 声笺香港访问网关

这套配置只负责 HTTPS 入口和反向代理，不保存文稿、账号、邮箱或 API Key。D1 与 R2 仍由现有 Sites 项目管理。

## 上线前准备

1. 在腾讯云购买一个可用的 .com 域名，并完成实名认证。
2. 购买香港地域的 Ubuntu 24.04 轻量应用服务器，建议首期 2 核 2 GB。
3. 将域名的 A 记录解析到服务器公网 IPv4。
4. 安装 Docker Engine 与 Docker Compose 插件。
5. 复制本目录到服务器，将 env.example 复制为 .env。
6. 生成至少 32 字节随机值，同时填写：
   - 网关 .env 的 ORIGIN_GATEWAY_SECRET。
   - Sites Secret 的 ORIGIN_GATEWAY_SECRET。
7. 在 Sites 环境设置 APP_PUBLIC_HOST 为新域名，不包含协议和路径。
8. 防火墙只开放 TCP 22、80、443 和 UDP 443；SSH 建议限制为管理员 IP。

## 启动与检查

运行 docker compose up -d 后，Caddy 会自动申请 HTTPS 证书。确认以下检查全部通过：

- https://新域名/api/health 返回 {"ok":true}。
- 新域名首页、登录、下载和长时间 AI 生成均可用。
- 直接访问原 chatgpt.site 地址返回 403。
- docker compose logs 中不出现邮箱、Cookie、JWT、文稿或 API Key。

不要在网关验证完成前设置 Sites 的 ORIGIN_GATEWAY_SECRET，否则现有私有网址会立即被拒绝。

## 认证服务配置

Sites 需要以下运行时配置：

- SUPABASE_URL
- SUPABASE_PUBLISHABLE_KEY
- SUPABASE_SERVICE_ROLE_KEY
- TENCENT_CAPTCHA_APP_ID
- TENCENT_CAPTCHA_APP_SECRET_KEY
- TENCENT_SECRET_ID
- TENCENT_SECRET_KEY
- APP_PUBLIC_HOST
- ORIGIN_GATEWAY_SECRET

腾讯云访问密钥应使用仅授予验证码票据校验权限的子账号，不使用主账号永久密钥。Resend、Supabase SMTP、SPF、DKIM 和 DMARC 在各自控制台配置，不写入本目录。

## 安全切换顺序

1. 保持 Sites 私有，先配置 Supabase、Resend 和腾讯验证码。
2. 由现有所有者完成管理员邮箱认领。
3. 部署本版本并确认新域名可访问。
4. 在 Sites 设置 APP_PUBLIC_HOST 和 ORIGIN_GATEWAY_SECRET。
5. 将 Sites 访问策略切换为 Public。
6. 用第二个邮箱完成注册、数据隔离和删除账号测试。
7. 使用中国移动、联通、电信网络分别完成完整流程。

如香港服务器到 Sites 的健康检查持续失败，不要开放注册；恢复 Sites 私有策略，并进入完整香港迁移方案。
