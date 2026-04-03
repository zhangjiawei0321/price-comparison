# JD / 淘宝 / 拼多多 价格监控（本地）

**完整特性与行为说明见 [特性说明.md](./特性说明.md)。**

## 功能

1. 录入商品链接，自动抓商品名与价格（Playwright + 页面解析）。
2. 按间隔（默认 1 小时）记录价格到本地 SQLite（`prices.db`）。
3. 相对**上一次记录**的降幅 ≥ 5% 时告警：
   - **默认**：写入数据库，在本地网页顶部红色「降价告警」面板展示（无需企业微信）。
   - **可选**：钉钉 / 飞书 群机器人、企业微信机器人、Windows 桌面通知。

## 环境

- Node.js 18+（建议 22）
- 已安装 Playwright Chromium：`npx playwright install chromium`
- 将.env.example改名为.env，并填充其中的信息

## 安装

```powershell
cd <你的项目目录>
npm install
npx playwright install chromium
```

## 告警配置（任选，可都不配）

项目启动时会自动加载当前目录下的 `.env`（若存在）。

### 1. 仅网页提醒（零配置）

不配任何 Webhook 即可：运行 `node index.js run ...` 后，用 `node index.js web` 打开 `http://localhost:8000`，降幅达标时顶部会出现告警列表。

### 2. 钉钉群机器人

在钉钉群里添加「自定义机器人」，复制 Webhook，例如：

```env
ALERT_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxxx
ALERT_WEBHOOK_FORMAT=dingtalk
```

### 3. 飞书 / Lark 群机器人

```env
ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
ALERT_WEBHOOK_FORMAT=feishu
```

### 4. 企业微信机器人（若你有权限）

```env
WECHAT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
```

可同时配置 `WECHAT_WEBHOOK_URL` 与 `ALERT_WEBHOOK_URL`（两个不同地址时会各推一次）。

### 5. Windows 桌面弹窗

```env
ALERT_DESKTOP=1
```

需本机已安装依赖（`npm install` 含 `node-notifier`）。

### 6. 自定义 POST（纯文本）

若你的服务接收 `text/plain`：

```env
ALERT_WEBHOOK_URL=https://你的服务/ingest
ALERT_WEBHOOK_FORMAT=plain
```

## 登录态 / 验证码

若商品页需要登录或易触发风控，请使用 Chrome 用户目录复用登录（与原先一致）：

```powershell
--userDataDir "C:\Users\你的用户名\AppData\Local\Google\Chrome\User Data\Default"
```

## 常用命令

### CLI 添加链接

```powershell
node index.js add "https://..." --userDataDir "...\User Data\Default"
```

### 定时轮询（默认 3600 秒、降幅 5%）

```powershell
node index.js run --userDataDir "...\User Data\Default" --intervalSeconds 3600 --dropPercent 5
```

### 本地网页：录入链接 + 看曲线 + 看告警

```powershell
node index.js web --port 8000 --userDataDir "...\User Data\Default"
```

### 启动本地网页：录入链接 + 看曲线 + 看告警 + 有头模式 + 定时轮询
```
node index.js web --port 8000 --userDataDir "...\User Data\Default" --headful --monitor
```

浏览器打开：`http://localhost:8000`

## 说明

- 价格解析依赖页面结构，站点改版后可能需在 `src/scraper.js` 中调整。
- **降价告警**对比的是「数据库里**相邻上一条**价格」与「当前抓取」。网页表格另有 **历史最低** 与相对「上次低价」的 **降幅** 列，口径见 `特性说明.md`。
