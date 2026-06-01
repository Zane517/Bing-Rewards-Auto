# Bing Rewards 多账号自动化搜索脚本

使用 Playwright 自动完成 Bing 搜索以赚取 Microsoft Rewards 积分。支持多账号、持久化登录、运行时自动抓取热搜关键词。

## 功能

- 多账号配置（`accounts.json`）
- 自动填充邮箱/密码登录，持久化 Edge profile 免重复登录
- 每次运行时自动从 Bing 首页抓取热搜作为搜索关键词
- 支持 PC 搜索 + 移动端搜索
- 日志系统（`logs/YYYY-MM-DD.log`）

## 环境要求

- Node.js >= 18
- 系统已安装 Microsoft Edge 浏览器

## 安装

```bash
git clone https://github.com/yourusername/bing-rewards.git
cd bing-rewards
npm install
```

## 配置

```bash
# 1. 复制账号配置模板
cp accounts.example.json accounts.json

# 2. 编辑 accounts.json，填入你的账号信息
# 多个账号可一次配置，脚本会依次处理
```

`accounts.json` 格式：

```json
[
  {
    "name": "主号",
    "email": "your@outlook.com",
    "password": "your-password",
    "enabled": true,
    "pcSearchCount": 30,
    "mobileSearchCount": 20
  }
]
```

## 使用

```bash
# 运行所有启用的账号
node index.js

# 只运行指定账号
node index.js --account 主号

# 无头模式（不显示浏览器窗口）
node index.js --headless

# 测试模式（只搜索 2 次）
node index.js --dry-run
```

## 首次运行

首次运行会弹出 Edge 浏览器窗口。你需要手动完成登录（包括 2FA 验证）。脚本会将 cookie 持久化到 `edge-profile/` 目录，之后无需再次登录。

## 注意事项

- 请勿频繁运行，Microsoft 有速率限制
- 建议每天运行一次
- 遵守 Microsoft Rewards 服务条款
- 本脚本仅供学习研究使用

## License

MIT
