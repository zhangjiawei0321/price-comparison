# JD / 淘宝 / 拼多多 价格监控（本地）

**完整特性与行为说明见 [特性说明.md](./特性说明.md)。**
**登录态落地方案见 [登录态管理方案.md](./登录态管理方案.md)。**

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

更推荐使用独立目录并按文档执行初始化、续期与排障流程：[登录态管理方案.md](./登录态管理方案.md)。

### 一次初始化登录（推荐先执行）

```powershell
npm.cmd run login:init -- --site jd --waitSeconds 180   
```

可选站点：`jd` / `taobao` / `pdd`，也可传 `--url "https://..."` 指定页面。

### 登录态快速自检

```powershell
npm.cmd run login:check -- --limit 5
```

会检查前 N 个监控链接，输出 `ok=yes/no`，用于快速判断是否需要重新 `--headful` 登录。

按监控 ID 定点自检（支持多个）：

```powershell
npm.cmd run login:check -- --id 3
npm.cmd run login:check -- --id 3,8,15
```

### 改造后推荐流程（每日可照抄）

1. 准备好 `.env` 的 `PRICE_USER_DATA_DIR`（固定目录，建议和日常 Chrome 隔离）。
2. 首次运行或登录疑似失效时，先执行初始化登录：

```powershell
npm.cmd run login:init -- --site jd --waitSeconds 180
```

3. 做一次快速自检：

```powershell
npm.cmd run login:check -- --limit 5
```

4. 通过后启动监控：

```powershell
npm.cmd run run
```

或：

```powershell
npm.cmd run web:mon
```

### 遇到风控时的处理步骤

出现以下任一情况，视为风控/登录态异常：

- 控制台出现 `maybe blocked/captcha`
- `login:check` 输出 `ok=no`
- 风控提醒提示“本次未写入新价格”

处理顺序：

1. 停止当前监控进程（避免持续触发）。
2. 重新做一次有头登录/验证（必要时延长等待）：

```powershell
npm run login:init -- --site jd --waitSeconds 240
```

淘宝/天猫可改为：

```powershell
npm run login:init -- --site taobao --waitSeconds 240
```

3. 重新自检，确认大多数链接恢复 `ok=yes`：

```powershell
npm run login:check -- --limit 5
```

4. 再恢复 `run` 或 `web:mon` 监控。

实用建议：

- 同一时刻只保留一个监控实例，避免抢占同一 profile。
- 不要并发运行多个命令使用同一个 `PRICE_USER_DATA_DIR`。
- 默认保留 `JD_MONITOR_GAP_SECONDS=30`、`RISK_WEBHOOK_COOLDOWN_SECONDS=3600`。



浏览器打开：`http://localhost:8000`

## 说明

- 价格解析依赖页面结构，站点改版后可能需在 `src/scraper.js` 中调整。
- **降价告警**对比的是「数据库里**相邻上一条**价格」与「当前抓取」。网页表格另有 **历史最低** 与相对「上次低价」的 **降幅** 列，口径见 `特性说明.md`。



## 调试
### 京东调试方法
```
node index.js debug-jd "https://item.jd.com/xxx.html" --headful
```
使用这条命令可以调试京东链接价格的正确性。

### 淘宝调试方法
```
node index.js debug-tb "https://detail.tmall.com/xxx.html" --headful
```

##提交日志
2026-04-05
1.添加调试方法
2.修改读取价格错误及添加优惠价和正常价
3.当被风控时读取到的价格不计入，因此可以从波动图中看到有没有被风控。
2026-04-05
1.添加登录管理，使用 登录态 / 验证码 这一节的方法