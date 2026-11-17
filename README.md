# 蜗牛回声训练室V1.2.1

移动优先的语音复述训练室。V1.2.1 使用 Vue 3 + TypeScript 前端、Java 21 + Spring Boot 后端、MySQL 和私有 S3 兼容对象存储。五种玩法为双人同步练、双座位自练、亲子同机练、异步留言练和单人练习。跨设备参与者通过邀请链接加入。

- [V1.2.1 本地运行、五种玩法验收和上线步骤](server-java/README.md)
- [V1.2.1 本地验收入口](http://localhost:3121/)

## 旧版 Node.js Demo 本地运行

需要 Node.js 24、npm 和 Docker Compose。以下命令在仓库根目录执行。

```sh
cd product
npm ci
docker compose -f compose.dev.yml up -d --wait
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Windows PowerShell 可用 `Copy-Item .env.example .env`。将上一步生成的值填入本地 `.env` 的 `ENCRYPTION_MASTER_KEY`。同一数据库应一直使用同一把密钥，否则已有转写无法解密。

```sh
npm run db:migrate
```

各开一个终端，在 `product/` 中分别运行以下命令。

```text
npm run dev:api
npm run dev:worker
npm run dev:web
```

打开 [本地动态 Demo](http://127.0.0.1:3100/)。默认使用模拟 AI，无需供应商账号。可以用两个独立浏览器会话测试邀请、录音、上传和复盘。跨手机访问时，需配置可访问的 HTTPS 服务和对象存储地址。

## 验证

在 `product/` 中运行。

```sh
npm test
npx playwright install chromium
npm run test:e2e
```

Windows 默认使用本机 Microsoft Edge。使用其他 Chromium 浏览器时将 `BROWSER_EXECUTABLE` 设为其可执行文件路径。端到端测试会临时使用 3100 端口，运行前请停止本地开发前端。它使用独立的临时密钥，建议只在测试数据库上运行。集成测试读取进程环境中的 PostgreSQL、Redis 和 S3 配置，导入测试环境变量后执行 `npm run test:integration`。

## 项目目录

V1.2.1 的 Spring Boot API、数据库迁移和镜像配置在 server-java 下。

- `product/apps/web` 是 Vue 3 + TypeScript 的 H5 前端，使用 Vite 构建。
- `product/apps/api` 包含 Fastify API、数据库迁移、对象存储和转写 Worker。
- `product/packages/core` 是共享的状态机和录音格式校验。
- `product/tests` 包含五种练法的浏览器回归测试。
- [用户手册](回声训练室-用户手册.docx) 是产品需求参考。 [部署说明](deploy/README.md) 包含独立镜像和真实服务配置。

## 协作方式

从 `main` 创建分支，通过 Pull Request 提交。PR 写明影响的练法和测试结果。数据库变更新增顺序迁移文件。涉及房间、录音或回合状态的变更应跑端到端回归。服务密钥只通过本地环境变量或部署平台的密钥配置注入。
