# 蜗牛回声训练室 V1.2.1 发布入口

发布使用 [Vue 与 Spring Boot 部署说明](../server-java/README.md) 中的同源 Docker 镜像、MySQL 和私有对象存储。构建、预发布、真机验收和切换条件见 [整机验证清单](../server-java/PRE-DEVICE-VERIFICATION.md)。

正式地址为 [蜗牛回声训练室 V1.2.1](https://47.239.63.61.sslip.io/)，使用的入口配置见 `Caddyfile.v1.2.1`。实际发布、恢复及清理记录见 [V1.2.1 执行记录](V1.2.1-CUTOVER-REVIEW.md)。

CI 的镜像构建通过 BuildKit 命名上下文复用前一阶段 Maven 测试已解析的依赖，并在 Maven 阶段使用离线模式。仅传入 `.m2/repository`，不包含 Maven 凭据配置；依赖缓存不会进入最终运行镜像。普通本地构建保持可联网解析依赖。相关机制见 [Docker 命名上下文](https://docs.docker.com/build/ci/github-actions/named-contexts/) 与 [缓存挂载](https://docs.docker.com/reference/dockerfile/#run---mounttypecache)。

主机测试和镜像打包都显式使用 `server-java/maven-settings.xml` 中相同的 Maven Central 仓库标识，避免不同 Maven 版本对缓存来源的判定不一致。该文件只有公共仓库地址，没有凭据；不删除缓存来源元数据或关闭校验。Ubuntu 运行镜像也通过官方 HTTPS 软件源安装依赖。

## 五种玩法真实服务联调

在独立的预发布环境启用火山文件转写与方舟，使用 HTTPS 签名入口传递临时音频。应用验收可在 HTTPS 预发布域名或通过 SSH 转发的本机入口执行。准备一段 30 秒以内、包含可核对短语且刻意遗漏至少一项家庭示例信息的合成中文复述录音。从仓库根目录运行：

```sh
node deploy/solo-live-smoke.mjs https://staging.example.com /path/to/retell.wav '录音中的可核对短语'
node deploy/solo-live-smoke.mjs https://staging.example.com /path/to/silence.wav --no-speech
node deploy/room-live-smoke.mjs https://staging.example.com product/apps/web/public/practice-audio/family.mp3 /path/to/retell.mp3
```

脚本使用正式音频接口验证火山转写、方舟对照、按角色展示的方舟建议、报告和访问隔离。房间脚本使用家庭原录音和省略“早点回来”的 MP3 复述，检查四种房间玩法。静音检查要求分析失败且归档被拒绝。脚本输出只包含检查结果，结束后撤销测试会话。

旧版 Node 联调脚本 `fullstack-smoke.mjs` 保留供历史回查。V1.2.1 的发布构建使用 `server-java/Dockerfile`。
