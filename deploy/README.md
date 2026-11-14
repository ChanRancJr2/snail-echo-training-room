# 动态 Demo 部署

同一镜像运行 API 和 Worker。准备 PostgreSQL、Redis、S3 兼容对象存储和 HTTPS 反向代理。正式配置使用独立的数据库账号和私有音频桶。

从仓库根目录构建。

```sh
docker build -t snail-echo:local product
```

在部署主机安全创建 `runtime.env`。下面列出配置变量。

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_ORIGIN` | H5 的完整 HTTPS 源，例如 `https://echo.example.com`，结尾不加斜杠 |
| `DATABASE_URL`、`REDIS_URL` | 容器可访问的 PostgreSQL 和 Redis 地址 |
| `ENCRYPTION_MASTER_KEY` | 32 字节随机值的 Base64 表示，持久保管 |
| `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET` | 内网对象存储地址、区域、已创建的私有桶 |
| `S3_ACCESS_KEY`、`S3_SECRET_KEY` | 仅访问指定存储桶的凭据 |
| `S3_PUBLIC_ENDPOINT` | 浏览器与火山 ASR 可访问的 HTTPS 签名入口 |
| `AI_MODE` | 生产填 `real` |
| `SPEECH_API_KEY`、`SPEECH_FILE_RESOURCE_ID` | 火山录音文件识别的凭据和资源 ID |
| `ARK_API_KEY`、`ARK_MODEL_ID` | 方舟凭据与模型或接入点 ID |
| `TRUSTED_PROXY` | 如果需要转发客户端 IP，仅填写受控代理的 IP 或网络段 |
| `COMPARISON_CONCURRENCY` | Worker 并发数，默认 2，可按资源与供应商额度调整 |

在对象存储为 H5 域配置 CORS，允许 `PUT`、`GET`、`HEAD` 及上传的 `Content-Type` 请求头。签名入口应原样传递请求方法、路径与查询参数。反向代理把 H5 的 HTTPS 请求转发到 API。数据库、Redis 和对象存储管理端口应在私有网络中。

以下示例使用名为 `echo-net` 的 Docker 网络。数据库、Redis 与对象存储也可托管，只要容器可访问；使用外部托管服务时可按部署环境调整网络选项。

```sh
docker network create echo-net
docker run --rm --network echo-net --env-file runtime.env snail-echo:local npm run db:migrate:built
docker run -d --restart unless-stopped --name snail-echo-api --network echo-net --env-file runtime.env -p 127.0.0.1:3100:3000 snail-echo:local
docker run -d --restart unless-stopped --name snail-echo-worker --network echo-net --env-file runtime.env snail-echo:local npm run start:worker
curl -fsS http://127.0.0.1:3100/health/ready
```

正式接口连通后，可在测试环境使用仓库自带样本，在仓库根目录执行以下验收。该脚本会创建测试房间并实际调用供应商。

```sh
node deploy/fullstack-smoke.mjs https://echo.example.com https://echo.example.com sync
```

数据迁移和应用启动使用同一份运行配置。升级前备份数据库并保管对应密钥。回放依赖原始音频对象，备份及清理策略需一并覆盖对象存储。
