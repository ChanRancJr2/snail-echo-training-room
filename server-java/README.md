# Java API 本地开发

Java 版支持双人同步练，涵盖匿名会话、邀请、录音直传、Mock 转写与对照、双方逐条确认、观察者建议、归档和报告导出。表达者归档后，双方重新准备即可在同一房间开始新一轮，也可以先交换角色。真实转写、语义对照及其他练法仍由 Node.js 版提供。

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

`mvn -f server-java/pom.xml verify` 使用 Testcontainers 启动独立 MySQL 8.4 和 SeaweedFS，覆盖 HTTP、数据库事务和实际对象存储。Java API 和开发依赖端口仅监听本机。

两个服务启动后，在 `product/` 下运行 `node tests/java-lobby.browser.mjs`，可用三个独立浏览器会话复现邀请、准备、开局、录音计时、重录、关房和换人建房。测试使用模拟麦克风。Windows 默认使用 Edge，其余环境先执行 `npx playwright install chromium`。

## 本地录音上传

启动应用前在同一终端设置开发配置。每个项目使用独立的数据库和私有存储桶，生产凭据由运行环境注入。

```powershell
$env:JAVA_STORAGE_ACCESS_KEY = 'java-local'
$env:JAVA_STORAGE_SECRET_KEY = [guid]::NewGuid().ToString('N')
$env:JAVA_STORAGE_BUCKET = 'echo-java-private'
$env:JAVA_STORAGE_ENABLED = 'true'
$env:JAVA_STORAGE_ENDPOINT = 'http://127.0.0.1:18334'
docker compose -f server-java/compose.yml --profile media up -d --wait
```

应用容器和浏览器使用不同存储地址时，设置 `JAVA_STORAGE_PUBLIC_ENDPOINT` 为浏览器可达的签名地址。预发布使用 HTTPS，S3 CORS 需允许 H5 的确定来源和所需的 PUT、GET、HEAD。录音签名响应不应进入日志或缓存。

- `POST /api/rounds/{roundId}/uploads` 按轮次、席位、幂等键申请上传。响应含 `audioId`、`status` 和 5 分钟有效的 `uploadUrl`，已确认时链接为空。
- 浏览器 PUT 到临时对象，再调用 `POST /api/rounds/{roundId}/uploads/{audioId}/commit`，提交录音轮次版本。复述必须明确同意转写。服务端校验对象大小和文件头，随后关联独立私有对象。去重和阶段推进同事务完成。
- `GET /api/rounds/{roundId}/audio/{audioId}/access` 在允许的阶段向成员返回 60 秒播放链接。对象存储提供 Range 读取。

可用 `$env:ECHO_JAVA_TEST_UPLOAD = '1'` 打开浏览器脚本的真实直传和 Range 回放断言。当前切片需要为 `pending/` 配置短期生命周期。提交结果不明确时保留最终对象以避免误删，生产前需补齐数据库引用对账与删除任务。

## 本地 Mock 转写与重点确认

启用录音后，在 Java 启动终端设置以下变量。同一数据库的后续启动需沿用同一文本密钥。本地测试可生成独立密钥，共享环境从机密配置注入。

```powershell
$env:JAVA_PROCESSING_ENABLED = 'true'
$env:JAVA_TRANSCRIPTION_MODE = 'mock'
$env:JAVA_TEXT_MASTER_KEY = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

上传确认事务会为每份录音登记一个转写任务。Worker 领取租约，成功后保存加密文本。已过期的租约和已关闭房间的晚到结果均不会写入文本。最多尝试三次。Mock 不对真实录音做识别，界面会将其标为演示转写。失败时表达者仍可手动确认要点。

本地对照使用预置转写和文字匹配。对照结果、双方标注和澄清加密保存。复述转写失败或超过生成期限时，房间会回到待准备状态。确认只能由该轮的表达者和复述者分别提交，修改结论或澄清会清除该条原有的双方确认。

在 `product/` 下设置 `$env:ECHO_JAVA_TEST_PROCESSING = '1'` 后运行 `node tests/java-lobby.browser.mjs`，可经同一个 H5 地址验证从录音上传到双方确认、匿名报告导出和同房再开一轮的完整流程。
