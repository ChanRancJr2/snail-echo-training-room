# Java API 本地开发

当前切片支持双人同步练的匿名会话、创建房间、角色邀请、准备、开局、快照和离开。开局进入 `TASK`，截止时间为 `null`，待后续录音接口启动计时。请用原本的 Node.js 服务体验完整训练流程。

## 启动与验证

需要 Java 21、Maven、Docker Compose，以及现有前端使用的 Node.js 24。在仓库根目录用 PowerShell 执行，输入仅用于此开发数据库的密码。已有数据库卷应沿用初始化时的密码。

```powershell
$env:JAVA_DB_PASSWORD = Read-Host '本地 MySQL 密码' -MaskInput
docker compose -f server-java/compose.yml up -d --wait
$env:JAVA_DB_URL = 'jdbc:mysql://127.0.0.1:13306/echo_java'
$env:JAVA_DB_USER = 'echo'
mvn -f server-java/pom.xml spring-boot:run
```

另开一个终端启动现有 H5。

```powershell
cd product
npm ci
$env:ECHO_DEV_API_TARGET = 'http://127.0.0.1:3001'
npm run dev:web
```

在两个独立浏览器会话打开 `http://localhost:3100/`。选择双人同步练，由表达者创建房间并分享复述者邀请。双方准备后，表达者点击开始，进入「先定这轮任务」。

`mvn -f server-java/pom.xml verify` 使用 Testcontainers 启动独立的 MySQL 8.4，覆盖 HTTP 和数据库事务。Java API 和开发数据库端口仅监听本机。

两个服务启动后，在 `product/` 下运行 `node tests/java-lobby.browser.mjs`，可用三个独立浏览器会话复现邀请、准备、开局、关房和换人建房。Windows 默认使用 Edge，其余环境先执行 `npx playwright install chromium`。
