# Warcon QQ 管理机器人

通过 QQ 官方机器人或 NapCat / OneBot 11 提供中文自助操作，独立运行于 Bun，数据存储在 SQLite。可直接连接 WARDOGS RCON，也可通过 Warcon 的受限 API key 接入。管理界面提供服务器连接、群组、积分账户与换边记录。

## 命令

| 命令                            | 行为                                                  |
| ------------------------------- | ----------------------------------------------------- |
| `/使用帮助`、`/帮助`            | 当前群的命令、签到额度和换边费用                      |
| `/绑定 7656119…`                | 向在线游戏角色发送验证码，不能仅凭 SteamID 冒领账号   |
| `/验证 123456`                  | 验证游戏内收到的验证码，5 分钟内有效                  |
| `/签到`                         | 每个社区每日一次，默认 10 积分                        |
| `/积分`                         | 可用余额、待核对扣款、免排队名单状态                  |
| `/服务器`、`/查对局`            | 当前地图、人数、比分；绑定后显示自己的战绩            |
| `/换边蓝`、`/换边红`、`/换边绿` | 查看换边费用和后果；也支持 `/换边 蓝`                 |
| `/取消`                         | 取消自己的待验证绑定和未确认换边，不撤销已执行订单    |
| `/确认 123456`                  | 2 分钟内确认自己的换边请求，默认 20 积分、冷却 300 秒 |

支持直接发送斜杠命令，或 @机器人 后输入命令；支持全角 `／`，也支持回复机器人消息后发送命令。只处理当前消息正文，不执行转发、图片或引用内容里的命令。高延迟白名单暂不实现。

绑定和积分以 `communityId` 为范围，同一社区的多个群共享。所有游戏操作的 SteamID 都来自本人已验证的绑定，不接受代替他人操作的参数。阵营颜色必须映射到当前游戏实际返回的名称，配置错误时拒绝换边。

## 管理界面部署

需要 Bun 1.4.4 或更新版本。运行 `bun install --frozen-lockfile` 安装依赖；官方接入使用固定版本的腾讯 SDK `@tencent-connect/qqbot-nodejs@1.0.5`。使用 NapCat 接入时，还需要已登录的 NapCat。

```sh
cp bot/.env.example bot/.env
bun run bot
```

在 `bot/.env` 中启用 `QQ_BOT_MANAGED=true` 和 `QQ_BOT_AUTO_SELF_ID=true`，配置 NapCat HTTP 地址和两个独立密钥。机器人会自动识别 NapCat 当前登录的 QQ，无需填写固定 QQ 号。设置 `QQ_ADMIN_USER`、`QQ_ADMIN_PASSWORD`（首次启动创建管理员，至少 12 个字符）和 `QQ_BOT_MASTER_KEY`（32 随机字节的 Base64，例如 `openssl rand -base64 32`）。管理入口为 `http://127.0.0.1:3100/admin`。局域网访问时设置 `QQ_BOT_HOST=0.0.0.0`；跨公网使用 HTTPS 反向代理。

使用 Docker Compose 时，在仓库根目录执行：

```sh
docker compose --env-file bot/.env -f bot/compose.yml up --build -d
```

Compose 默认启用网页管理，不需要创建或挂载 `groups.json`。配置、积分与绑定保存在 `qq-bot-data` 持久卷中，管理入口为 `http://127.0.0.1:3100/admin`。容器内监听地址固定为 `0.0.0.0:3100`；宿主机默认仅发布到本机。需要局域网访问时，在 `bot/.env` 增加 `QQ_BOT_PUBLISH_HOST=0.0.0.0`，随后通过 `http://宿主机IP:3100/admin` 访问；可用 `QQ_BOT_PUBLISH_PORT` 修改宿主机端口。

密钥支持同名 `_FILE` 环境变量，如 `QQ_ADMIN_PASSWORD_FILE`、`QQ_BOT_MASTER_KEY_FILE`、`NAPCAT_API_TOKEN_FILE`，文件与环境变量同时存在时读取文件。主密钥由部署者保管，不包含在数据库备份中。

经 HTTPS 反向代理访问管理后台时，设置 `QQ_ADMIN_ORIGIN=https://你的域名`（可含非默认端口，不含 `/admin`、其他路径或查询参数），然后重启。该固定地址用于来源校验和 Secure 会话 Cookie，不信任 `X-Forwarded-*`。直接 HTTP 访问可留空。其他页面已更新配置时，保存会提示版本冲突；请核对最新配置并重新打开编辑。

登录后先添加服务器：

- **WARDOGS API**：输入服务器名称、IP/主机名、端口、HTTP/HTTPS 和 RCON 密码，保存后测试连接。测试只读取状态、玩家和能力，不发送游戏指令。
- **Warcon API**：填写 Warcon URL、服务器 ID 与受限 API key。key 仅需要目标服务器的 `server.view`、`chat.send`、`players.move`，不需要封禁、原始 RCON 或服务器配置权限。

然后添加群，选择服务器、设置社区标识、时区、积分及蓝/红/绿对应的阵营名。只有配置过的群可使用机器人。相同社区的积分、时区和冷却配置必须一致。保存配置会使尚未执行的换边确认失效。

选择服务器后会自动读取阵营，使用下拉框配置蓝、红、绿。同一服务器已有群组且颜色映射一致时，会预填现有映射；没有可靠映射时需自行选择，不按 API 返回顺序推断颜色。编辑已有群组会保留原设置。读取失败可手动填写，点击“重新读取”可刷新选项；切换服务器后返回会保留尚未保存的选择。

直接 RCON 模式只持有原生 API 能提供的信息；原生免排队名单不提供到期时间，机器人不会据此显示“永久”。通过 Warcon 接入可读取托管名单的到期信息，但同步记录过期或状态不明时会显示待核实。需要 Warcon 的集中审计和自动化协作时，使用 Warcon API 模式。

## QQ 官方机器人配置

1. 在“机器人接入 → 配置接入”选择 **QQ 官方机器人**，填写 AppID、AppSecret 并保存。AppSecret 加密存储，不在读取接口或页面中回显。更换 AppID 时不会沿用旧 AppSecret。
2. 本机主动建立 WebSocket 连接，不需要公网回调地址；需要能出站访问 `https://api.bot.qq.com` 和平台返回的 WSS 网关。在开放平台开通群聊能力，并确认机器人可用于目标群（未发布时按平台要求设置测试范围）。后台的“已连接”表示已收到官方 READY / RESUMED。
3. 将官方机器人加入目标群，在群内 **@机器人 /帮助**。后台“已识别的官方群”会显示该群 OpenID。点击“关联群组”，选择现有 QQ 群。只关联确认过的群；QQ 群号不能当成 OpenID，切换 AppID 后需重新关联。然后重新发送帮助验证回复。
4. 常规命令在群内 @机器人 使用；已获全量群消息权限时也支持直接发送 `/命令`，普通聊天不会执行命令。普通私聊默认不执行命令；可按下节授权私聊测试。频道、图片、语音和引用正文不用于游戏操作。
5. 快捷按钮只为当前发起者填入命令；群内仍由本人发送，换边必须经过报价和确认。按钮权限明确被拒绝时自动退回纯文字；也可在后台关闭按钮。网络超时不会触发重复发送或重复游戏操作。

官方身份使用 AppID + 群 OpenID + 成员 OpenID 隔离。原 NapCat 的 QQ 身份、积分和历史记录保留。玩家通过官方机器人重新 `/绑定 原SteamID` 并完成游戏内验证码后，关联原积分账户，签到、冷却和待核实操作继续共用；不会合并未经验证的身份。不同群中的官方成员标识也需要分别验证。

NapCat 容器、登录卷和环境配置可继续保留。在后台将当前接入切回 **NapCat（备用）** 即可恢复其消息处理；官方模式会确认接收但忽略 OneBot 上报，不会双重执行。切换接入、AppID 或服务器配置时，尚未执行的命令和待确认请求会作废；已经发出的游戏操作仍按结果记账。

官方接入仅要求管理模式和后台凭据，不强制要求 NapCat 配置。现有 NapCat 环境变量可保留作回退；缺少其密钥时不会启用 OneBot 消息处理。文件配置模式仍为 NapCat 专用。

后台“近期群事件”显示本次进程观察到的最近 30 条入群、退群及群消息接收开关通知；容器日志只记录事件类型、AppID、群 OpenID 和接收时间。入群通知可以帮助发现群，但不会自动授权游戏操作，也不代表收到了待批准的群邀请。未记录历史事件时，空列表不能证明机器人未在群内。

### 私聊测试

官方机器人暂时无法加群时，可以先测试单聊（C2C），不依赖机器人已入群：

1. 使用有权限与机器人单聊的 QQ 打开机器人资料卡，点击“发消息”，发送 `/帮助`。如果平台未允许该账号使用，在官方平台“服务范围”或“内部体验号码”中配置。
2. 在本管理页“机器人接入 → 私聊测试”找到刚刚发送消息的用户 OpenID，点击“允许测试”，选择现有群组对应的服务器与积分规则。首次未授权消息仅用于发现账号，不执行命令。账号仅管理员可授权，最多 20 个，可随时停用。
3. 重新私聊发送 `/帮助`，无需 @。可测试查对局、绑定/验证、签到、积分、换边/确认、取消。回复会标明服务器与“私聊测试”。**测试使用真实的服务器、积分与操作记录**；换边仍要求游戏内验证本人身份、余额与冷却检查及二次确认。

单聊身份按 AppID + 用户 OpenID 独立保存，与群成员 OpenID 分开；只有重新完成同一 Steam 身份验证后，才关联原账户的积分和每日签到限制。单聊回复只发送给发起者，不发送到关联群。关联群组在此只提供服务器及积分策略，不会开放该群的官方入口。修改授权、切换应用或停用接入时，旧命令和待确认请求失效。

对照官方 [单聊消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html) 与 [单聊回复](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)：使用 `C2C_MESSAGE_CREATE`、`author.user_openid`、原始 `d.id`，通过 `/v2/users/{user_openid}/messages` 被动回复；有消息索引时按索引去重，无索引时按消息 ID 去重。两分钟内处理，单条正常回复一次，不使用主动推送额度。

### 文档核对与边界

核对日期：2026-10-23。以 [QQ 官方文档](https://bot.q.qq.com/wiki/develop/api-v2/) 为准：

| 文档要求                                                                                                                                            | 本项目行为                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)：AppID + AppSecret 换取 Access Token                             | 服务端腾讯 SDK 管理凭据刷新；Token 不进入管理页面                                   |
| [API 调用](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)：统一 `api.bot.qq.com`、业务错误码、AppID 身份隔离             | 覆盖 SDK 旧域名默认值；检测 `code/err_code`，不把 2xx 当作送达证据                  |
| [事件订阅](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)：WebSocket、心跳、RESUME、`1 << 25`            | SDK 维护连接，只订阅群聊/单聊事件类，仅群命令进入业务层                             |
| [群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)：`group_openid/member_openid/d.id`                    | 显式群映射、持久去重；只使用当前消息文本                                            |
| [群回复](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)：5 分钟、每条最多 5 次、`msg_id + msg_seq` | 使用原消息 `d.id`，固定序号 1；两分钟内处理、正常仅一条回复；明确按钮拒绝可回退文字 |
| 快捷按钮 `type=2`、指定用户权限                                                                                                                     | 帮助、签到、积分、查对局、换边、取消和专属确认按钮；保留命令文本入口                |

本次适配保留全部已实现自助功能。官方主动通知受平台权限和额度影响，当前业务只被动回复；Watch → QQ 告警、规则自动处罚和战术地图仍未实现，不能由切换接入自动获得。按钮、富媒体和主动推送也不等于拥有群管理员权限。

## NapCat 配置

在 NapCat 网络配置中启用以下两项，消息格式选 `array`：

1. **HTTP 服务端**：供机器人调用发送群消息；设置端口（例如 3000）和 token，与 `NAPCAT_API_URL` / `NAPCAT_API_TOKEN` 对应。
2. **HTTP 客户端**：URL 指向 `http://机器人主机:3100/onebot/events`，它的 **token** 填 `NAPCAT_WEBHOOK_SECRET`，关闭上报自身消息。NapCat 使用这个 token 对原始请求体生成 `X-Signature`，机器人同时检查签名、QQ 号、群白名单和时间。

容器内的 `127.0.0.1` 只指向容器自身；同一容器网络应填写服务名。切换旧机器人时保留 NapCat 登录卷，只替换网络上报配置并停用旧机器人。

### 换号与自动重连

启用 `QQ_BOT_AUTO_SELF_ID=true` 后，在 NapCat 界面登录新 QQ 即可，机器人每 5 秒检查一次在线状态和账号。管理页的连接栏每 5 秒刷新，显示当前 QQ、昵称、检查时间和最近一次已验证的消息上报时间。新 QQ 必须已加入后台配置的群，并保留上述 HTTP 服务端/客户端配置及密钥；某些 NapCat 部署为不同账号保存独立网络配置，需要在新账号下确认它们仍已启用。HTTP 客户端不定时发送心跳，群里暂时没有消息时，“最近上报”可以为空；QQ 连接状态来自受认证的 HTTP API 检查。

QQ 离线或切换时暂停接收和执行命令，作废原会话中排队的命令、未发送的回复和待确认的换边请求；重连后请重新发送命令。已经发往游戏的操作仍按实际结果记账，不会因 QQ 掉线而自动重放或退款。Steam 绑定、积分、服务器和群组配置保留，只处理后台允许的群。OneBot 的发送接口不支持按预期 QQ 号锁定账号，因此正好在切换瞬间已经发出的请求仍需以实际结果为准。

若需要固定账号，设置 `QQ_BOT_AUTO_SELF_ID=false` 并填写 `QQ_BOT_SELF_ID`。未配置自动识别开关的旧部署仍使用固定账号模式。

依据：[NapCat HTTP 客户端源码](https://github.com/NapNeko/NapCatQQ/blob/3420f0b76d7dc0ac92cde1663f21ea27f61e13bb/packages/napcat-onebot/network/http-client.ts)、[OneBot HTTP 上报协议](https://github.com/botuniverse/onebot-11/blob/master/communication/http-post.md)。

## 积分和异常处理

签到、扣款、退款和订单状态由 SQLite 事务维护，积分账本只能追加。QQ 重复回调不会重复执行。换边先暂扣积分，再调用游戏；明确拒绝会退还积分，超时、断线或含糊响应会进入“待核对”，阻止同一玩家继续换边。进程中断后也不会自动重放正在执行的游戏指令。

管理员可在操作记录中核对游戏/Warcon 审计，确认成功或退款，并填写理由。游戏已经换边但重生失败时，换边仍已发生，不能当作未执行自动退款。QQ 回复发送结果不明时，也不会通过重发原命令来重试游戏操作。

需要停服操作时可使用本地命令：

```sh
bun run bot:admin unknown
bun run bot:admin resolve <操作ID> succeeded "已核对游戏审计"
bun run bot:admin resolve <操作ID> refunded "确认没有执行"
```

## 备份与恢复

管理界面的“下载备份”或以下命令使用 SQLite `VACUUM INTO`，可在服务运行时获得一致性快照，包括 WAL 中已提交的数据。不要只复制正在运行的 `.sqlite` 文件。

```sh
bun run bot:admin backup /安全目录/qq-bot-2026-10-23.sqlite
```

恢复时停止机器人，用备份替换数据库，清理旧数据库对应的 `-wal`、`-shm` 文件，再使用原来的主密钥启动。仅在确定所有使用该数据库的进程已停止后替换文件。备份包含 QQ/Steam 绑定、积分和管理信息，应限制文件访问权限；主密钥和 NapCat 密钥单独备份。

只部署一个机器人实例使用同一数据库，放在本地持久卷上。独立的 SQLite 运行锁在进程崩溃时由操作系统释放，不依赖容易失效的 PID 文件。

## 文件配置模式

不启用管理界面时，可沿用 `WARCON_URL`、`WARCON_API_TOKEN` 和 `bot/groups.json`，格式见 `groups.example.json`。这个模式只通过 Warcon API 接入，修改文件后重启。启用管理界面后，服务器与群组以数据库配置为准。

使用 Compose 的文件模式时，先创建 `bot/groups.json`，然后新建可选的 `bot/compose.file.yml`：

```yaml
services:
  qq-bot:
    environment:
      QQ_BOT_MANAGED: 'false'
      QQ_BOT_GROUPS: /app/config/groups.json
    volumes:
      - ./groups.json:/app/config/groups.json:ro
```

在 `bot/.env` 配置 `WARCON_URL` 和 `WARCON_API_TOKEN` 后执行：

```sh
docker compose --env-file bot/.env -f bot/compose.yml -f bot/compose.file.yml up --build -d
```

文件模式不提供 `/admin` 管理入口。切回网页管理时移除第二个 `-f` 参数，并将 `bot/.env` 中的 `QQ_BOT_MANAGED` 设为 `true`。

## 开发

```sh
bun run bot:check
bun run bot:test
docker build -f bot/Dockerfile -t warcon-qq-bot .
```

`contracts.ts` 定义游戏端口，`commands.ts` 的命令注册表负责别名、帮助与分发，`store.ts` 负责积分和订单，`napcat.ts` 负责 OneBot 接入，`official.ts` 负责官方消息、快捷按钮与生命周期。新增命令时复用身份验证和订单事务，不直接在消息回调中拼接 RCON 请求。
