# 蜗牛回声训练室V1.2

Vue 与 Spring Boot 的本地验收入口是 [http://localhost:3121/](http://localhost:3121/)。首页提供双人同步练、双座位自练、亲子同机练、异步留言练和单人练习。

- 双人同步练沿用邀请、准备、观察和同房换位流程。
- 双座位自练与亲子同机练复用录音、转写、八步核对和报告流程。亲子同机练支持留空昵称建房，下一轮交换孩子与家长的角色。
- 异步留言练允许表达者直接开局。复述者提前加入时看到等待提示，表达者确认要点后才能打开留言并访问录音。
- 单人练习在浏览器录音，以示例或手填复述文本作关键词对照。Spring Boot 将练习摘要按登录会话归档到 MySQL。复述文本、澄清内容和未经素材提交授权的录音留在浏览器。

## V1.2 五种玩法定版流程

| 玩法 | 开始与复述 | 核对、报告与下一轮 |
| --- | --- | --- |
| 双人同步练 | 表达者邀请复述者，双方准备后开始。表达者录音并确认重点，复述者听录音后提交复述。 | 逐条标注与确认，查看各自建议，表达者归档。再开一轮时交换表达者和复述者。 |
| 双座位自练 | 同一人在两个座位交棒，先表达，再复述。 | 标注确认后直接查看建议和报告，可再练一轮。 |
| 亲子同机练 | 选择孩子本轮角色，在同一设备交棒。 | 与双座位自练共用八步流程。再练一轮时孩子和家长交换角色。 |
| 异步留言练 | 开局前显示邀请链接，开始本轮后收起邀请。复述者可提前加入等待，或在表达者确认重点后打开留言。 | 双方逐条核对、查看建议，由表达者归档。 |
| 单人练习 | 选择素材、听原录音并录制自己的复述。 | 对照并确认差异，建议可接纳一次。报告提供原录音与复述回放，可再练一轮或结束练习。 |

报告中的「上传素材库」按录音独立确认。双人同步和异步留言只能确认自己的录音。双座位自练和亲子同机共用登录，每一段都要由录音者自行确认。单人练习仅可提交本人的复述录音。房间录音记录授权，单人复述经授权后存为私有候选。候选材料留待后续处理和发布。

双人同步练第 4 步按复述者每次访问记录实际播放时长、成功开始录音的次数、页面可见停留时长。相同访问的网络重试更新同一条记录。数据保存在 MySQL，仅供内部分析，报告不包含这些字段。

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
$env:VITE_ECHO_TARGET = 'java'
npm run dev:web
```

在两个独立浏览器会话打开 `http://localhost:3100/`。输入昵称登录后选择双人同步练，由表达者创建房间并分享复述者邀请。双方准备后，表达者点击开始，进入「先定这轮任务」。

首次提交昵称后，同一浏览器会话可保留 30 天。原有的访客会话有效期为 12 小时。清除会话 Cookie、切换浏览器或会话到期后，再次填写同一昵称会建立独立会话。

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

本地对照使用预置转写和文字匹配。对照结果、标注、澄清和观察建议加密保存。同一条可以陆续提交多次澄清或观察建议。修改结论或提交新澄清会清除该条旧确认。表达者确认全部差异条目即可提交，复述者未确认的差异从结果分子和分母中扣除。复述转写失败或超过生成期限时，房间会回到待准备状态。

在 `product/` 下设置 `$env:ECHO_JAVA_TEST_PROCESSING = '1'` 后运行 `node tests/java-lobby.browser.mjs`，可经同一个 H5 地址验证从录音上传到双方确认、匿名报告导出和同房再开一轮的完整流程。

验收预览运行时，在 `product/` 下执行以下命令，可复测全部五种玩法。浏览器使用独立会话和模拟麦克风，录音走实际对象存储，转写使用 Mock。

```powershell
$env:ECHO_PRODUCT_ORIGIN = 'http://localhost:3121'
$env:ECHO_JAVA_TEST_PROCESSING = '1'
node tests/java-lobby.browser.mjs
node tests/java-modes.browser.mjs
node tests/solo-practice.browser.mjs
```

## 火山录音文件识别

为 Java 进程启用 `JAVA_PROCESSING_ENABLED=true` 和 `JAVA_TRANSCRIPTION_MODE=volc`，保留 `JAVA_TEXT_MASTER_KEY` 和对象存储配置。通过运行环境注入 `SPEECH_API_KEY` 和已开通的 `SPEECH_RESOURCE_ID`，例如 `volc.seedasr.auc`。通过 `JAVA_FFMPEG_PATH` 指定含 `libmp3lame` 的 FFmpeg 可执行文件。对象存储保持私有，`JAVA_STORAGE_PUBLIC_ENDPOINT` 提供火山可从公网访问的 HTTPS 地址，代理须保留签名使用的 Host、路径和查询参数。签名链接有效期为 3 分钟。

开发测试和火山联调使用不同数据库与桶。入队时固定使用的供应商。若在同一环境切换运行模式，先排空原模式的任务。Worker 将已确认录音转成单声道 MP3，再按房间时间上限截断。首次提交记录意图，后续轮询复用返回的任务 ID。提交结果不明确时尝试查询原请求 UUID，查不到可用结果则结束任务，避免再次发送录音。火山排队超过本应用 3 分钟预算时，本轮按转写失败处理。

完成、失败或取消的任务会定期删除 `asr/` 下的临时转码副本。原始录音由训练室的独立数据保留流程管理。部署时为 `asr/` 配置对象生命周期清理，并为 JVM 的 `java.io.tmpdir` 使用受限的临时卷，覆盖进程崩溃等异常。

要运行真实 FFmpeg 和本地模拟火山的验收测试，设置 `ECHO_TEST_FFMPEG` 为本机 FFmpeg 绝对路径，再运行 Maven `verify`。测试不会调用真实火山。火山联调用单独测试房间和合成短音频，先验证 HTTPS 签名可抓取，再核对任务返回文字。

[火山任务提交](https://docs.volcengine.com/docs/doubao-voice/task-submission-http-1?lang=zh) · [查询结果](https://docs.volcengine.com/docs/doubao-voice/result-query-http-1?lang=zh) · [状态码](https://docs.volcengine.com/docs/doubao-voice/error-code-query?lang=zh)

## 方舟语义对照

在火山转写环境中设定 `JAVA_COMPARISON_MODE=ark`，通过运行环境注入 `ARK_API_KEY` 和 `ARK_MODEL_ID`。接入点需支持 Chat Completions JSON 输出及关闭思考模式。默认模式是 `rules`。Mock 转写不调用方舟。调用只发送表达者确认的要点和复述者的转写，不发送原始音频、签名链接及会话资料。

对照任务用数据库租约保护，网络调用位于事务外。每实例最多同时调用 4 次，每次最多等待 12 秒，可重试错误最多再试一次，且须留足轮次时间。本地回退在独立调度中处理。结果通过字段、标记和引文校验后落库。缺失或无有效引文的要点回退到字面匹配，整次调用失败时全轮使用字面匹配。界面标明回退结果，双方可以继续逐条确认。

[方舟 Chat Completions API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh) · [方舟结构化输出](https://docs.volcengine.com/docs/ark/structured-output-beta?lang=zh)

## V1.2 上线阶段

| 阶段 | 完成条件 |
| --- | --- |
| 冻结版本 | 以本页五种玩法作为 V1.2 验收基线。Maven 版本为 1.2.0。将经过本地验收的发布分支推送到 GitHub，通过 PR 审查并保留可追溯提交。 |
| CI 与镜像 | 本地覆盖五种玩法的浏览器回归和镜像冷启动。GitHub Actions 执行 TypeScript 检查、项目测试、Maven verify 和 Linux 镜像构建。记录发布提交与镜像摘要，预发布和生产使用同一镜像。 |
| VPS 预发布 | 用独立 Compose 项目、数据库和存储桶。验证 HTTPS、跨设备邀请、iOS Safari 和 Android Chrome 的麦克风、录音与回放、真实转写与语义对照，以及五种玩法完整流程。 |
| 数据和恢复 | 备份旧数据库、对象存储和加密密钥并验证恢复。确认上线是使用独立的 Java 数据库，还是需要迁移旧版历史记录。演练镜像回滚和必要时恢复数据库。 |
| 生产启用 | 配置正式域名、TLS 和反向代理，切换到验证过的镜像。验证首页、会话、录音及转写任务，观察错误率和任务积压，必要时恢复旧入口。 |
| 上线后运维 | 定期检查证书、数据库备份、对象存储生命周期、转写失败率和磁盘使用。建立告警并检查日志不收集录音、转写正文、密钥或签名链接。 |

发布主线使用 VPS 上的 Docker Compose。Vue 由 Spring Boot 同源提供，使用现有的会话 Cookie、邀请链接和音频接口。MySQL 保留在私有网络，应用使用可独立升级的 S3 兼容存储。Vercel 可供后续评估前端预览，使用外部 Java 服务时需另测代理、Cookie 和上传链路。

[Docker Compose 生产部署](https://docs.docker.com/compose/how-tos/production/) · [Vercel 外部重写](https://vercel.com/docs/routing)

## VPS HTTPS 部署

从仓库根目录构建同源的 H5 与 Java 应用。镜像首页提供五种玩法。

```sh
docker build -f server-java/Dockerfile -t echo-java:1.2.0 .
docker compose --env-file /path/to/java-runtime.env -f server-java/compose.release.yml config --quiet
docker compose --env-file /path/to/java-runtime.env -f server-java/compose.release.yml up -d --wait
```

部署机的环境文件需包含 `ECHO_JAVA_IMAGE`、指向该文件绝对路径的 `ECHO_JAVA_ENV_FILE`、`JAVA_DB_PASSWORD`，以及本节前述的对象存储、文本密钥、运行模式和供应商配置。用权限为 600 的文件存放这些值。设置 `JAVA_PUBLIC_ORIGIN` 为演示站点的完整 HTTPS 源，设置 `JAVA_STORAGE_PUBLIC_ENDPOINT` 为浏览器和转写服务可达的签名入口。应用端口默认仅监听 `127.0.0.1:3102`，MySQL 仅在 Compose 网络中可见。

在独立 HTTPS 域名下代理到应用端口，保持对象存储签名所需的 Host、请求路径与查询字符串。先检查 `/health/live` 和页面，再运行三会话浏览器验收。生产使用独立数据库卷、私有桶和正式供应商凭据。轮换版本前备份数据库及密钥，并保留上一个镜像标签；应用回退通过切回旧镜像标签完成。
