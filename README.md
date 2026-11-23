<div align="center">

<img src="assets/icon-180.png" width="96" alt="NextSeat" />

# 邻座 · NextSeat

**DSH 的面对面分享空间。** 开一间房，把二维码递出去——你刚在 DSH 里做好的文件、提示词、技能包，直接到在场每个人手里。

[![License: MIT](https://img.shields.io/badge/license-MIT-37E3B5.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-0A0F0E.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![Version](https://img.shields.io/badge/version-0.7.0-37E3B5.svg)](https://github.com/Azhu9701/dsh-nearby/releases)

[中文](README.md) · [English](README.en.md)

</div>

![NextSeat](assets/cover.png)

<p align="center"><a href="https://github.com/Azhu9701/dsh-nearby/releases/download/v0.6.0/dsh-nearby-intro.mp4">▶ 看 86 秒介绍视频</a> · <a href="https://github.com/Azhu9701/dsh-nearby/releases">版本说明</a></p>

## 为什么是邻座

在 DSH 里做出来的东西，全都躺在你自己的电脑上。旁边的人说「发我一份」——然后你开始加微信、传网盘、找 U 盘，一次面对面的分享，绕了三个软件。

邻座把这件事缩成一步：**开一间房，把二维码递过去。**

- **对方零安装**：手机浏览器打开就能进，不用装 DSH、不用注册、不用加好友。
- **关房即散**：房间不存在账号和好友关系里，事情办完点关房，端口回收、入口失效。
- **数据不出门**：默认只在局域网内直连，文件落在你自己的机器上，不经过任何第三方服务器。

> 适合：沙龙、课堂、会议、上门交付、展会——任何「人就在旁边」的场合。

## 功能

| 能力 | 说明 |
| --- | --- |
| 一对多房间 | 4 位房间码 + 二维码 + 带 token 的链接；同一 Wi-Fi 下扫码即进 |
| 文件互传 | 单文件最大 2 GiB，大文件按 32 MB 自动分片，SHA-256 校验，流式落盘 |
| 提示词卡片 | 纯 JSON 卡片（标题 / 标签 / 正文 / 作者），只渲染不执行，可一键导入提示词库 |
| 技能包分享 | 本机技能目录打包成 zip 进房间；收到后可一键装进 `~/.dsh/skills`（校验路径穿越与符号链接）|
| 插件包分享 | 勾选本机已装插件，生成一串 `NSP1-…` 插件码（几十个插件也只有几百字符）；对方粘进面板，预览后一键装回 |
| 本地插件分享 | 以目录方式安装（`link:` / `file:`）的插件可以整包放进房间，对方下载后一键装成本地插件 |
| 分享码进房 | 在面板里填 4 位房间码，自动匹配同一 Wi-Fi 下的房间并打开；也可以直接粘完整链接 |
| 房间留言 | 宿主与访客都能留一句话，像白板一样即时可见 |
| 就近发现 | 同一 Wi-Fi 下开着邻座的实例自动出现在「附近的人」，一键进房，连扫码都省了 |
| 远程宿主 | 人不在现场时挂一条 Cloudflare quick tunnel，现场打开 https 链接即可进入 |
| Agent 工具 | `nearby_room` / `nearby_share` / `nearby_inbox`，模型可以自己开房、递东西、读收件箱 |

## 快速开始

环境要求：DeepSeek Harness（桌面端）、Node.js ≥ 20；宿主与访客在同一 Wi-Fi（远程模式除外）。

```sh
# 安装（需要已安装 DeepSeek Harness）
dsh plugin --profile web add dsh-nearby

# 也可以直接从 GitHub 安装
dsh plugin --profile web add github:Azhu9701/dsh-nearby
```

装好后按提示重载（或点侧栏刷新按钮），侧栏出现「邻座」面板。

1. 点开「邻座」，填一个称呼、选时长，点 **开一间房**。
2. 把二维码或链接递给身边的人，对方用手机浏览器打开。
3. 对方上传文件、递提示词卡片或留言；你在面板里实时看到，点「保存」或「导入提示词库」。
4. 事情办完点 **关房**：端口回收，房间不存在了。

<p align="center">
  <img src="assets/screenshot-guest.png" width="300" alt="手机访客页" />
</p>

<p align="center"><sub>手机访客页：扫码即进，无需安装 · 文件 / 提示词 / 技能包 / 留言都在这里</sub></p>

![演示](assets/demo.gif)

### 分享插件：一串码，装回一整套

同一间房里的人，除了文件、提示词、技能，还能把自己调好的**插件组合**递过去：

1. 面板里点 **分享插件**，勾上想给的插件，点 **生成插件码**。本地 `link:`/`file:` 安装的插件没法用插件码，但可以在同一面板的「本机插件」里整包放进房间，对方下载后一键装成本地插件。
2. 得到的是一串 `NSP1-…`：JSON 打包再 deflate + base64url，**31 个插件里挑 2 个只有 136 个字符**，微信里发一句话就能带过去。
3. 对方在邻座面板点 **我要收别人的**，粘进这串码 → **看看要装什么** 先出预览（装 / 启用 / 需手动升级 / 本机已有），确认后才 **装进我的 DSH**。
4. 装完提示「重启 DSH 后生效」；也可以在访客页直接点 **复制插件码**，发给旁边已经装了 DSH 的人。

预览是硬约束：**先看要装什么，再动手装**；DSH 的装包接口不接受「升级」，版本不一致时只提示你去插件页手动升级，不会静默降级。

## 工作方式

```mermaid
flowchart LR
    A["DSH 侧栏面板<br/>client.js"] <-->|"同源 HTTP"| B["Host<br/>index.js"]
    B --> C["局域网 HTTP 服务<br/>随机端口"]
    C <--> D["手机浏览器<br/>guest.html · 零安装"]
    B --> E["~/.dsh/storages/dsh_nearby<br/>文件 / 卡片 / 技能包"]
    B -.- F["Cloudflare quick tunnel<br/>可选 · 远程宿主"]
    G["Agent 工具<br/>nearby_room / share / inbox"] --> B
```

- **Host**：房间生命周期、路由、文件落盘、技能打包、隧道管理、Agent 工具。
- **访客页**：单文件 `guest.html`，无框架、无构建，手机浏览器直接打开。
- **没有服务器**：默认不依赖任何中心服务；可选隧道只是把本机端口暂时映射到公网。

## Agent 工具

| 工具 | 用途 |
| --- | --- |
| `nearby_room` | 查状态 / 开房 / 关房；`status` 会列出手边谁开着房 |
| `nearby_share` | 往房间递文件、提示词卡片、技能包、插件包或留言 |
| `nearby_inbox` | 读房间里的收件（文件、卡片、技能包、留言）|

示例：对 Agent 说「开个房间，把这个技能分享给现场的人」，它会调 `nearby_room` 开房、`nearby_share` 打包技能，并告诉你房间码和链接。

## 安全与隐私

- **宿主接口走 DSH 的访问检查**：`/dsh-nearby/api/*` 每条路由先调 DSH `connection.requestRejection`，与 DSH 自己的页面同级——Host/Origin 栅栏挡 DNS rebinding 与跨站调用，浏览器登录态（或 API 凭据）才算通过。装在缺少该服务的旧宿主上时自动跳过这一层。
- **私网闸门**：访客页默认只接受私有网段来源（127/10/172.16-31/192.168/169.254/ULA/链路本地），公网 IP 一律拒绝。
- **token 鉴权**：房间使用 32 字节随机 token；宿主侧变更接口另要求自定义请求头，作为访问检查之外的第二道。
- **文件名净化**：上传文件名会净化；zip 技能包安装前检查绝对路径、`..` 与符号链接。
- **本地落盘**：数据只落在宿主本机 `~/.dsh/storages/dsh_nearby/`，关房后可自行清理。
- **边界**：局域网内是明文 HTTP，不提供端到端加密，仅适合可信网络；公网模式请勿把链接发到公开群。

## 配置

可选配置文件 `~/.dsh/storages/dsh_nearby/config.json`：

```json
{
  "tunnel": { "kind": "cloudflare", "cloudflared": "/opt/homebrew/bin/cloudflared" },
  "relay": { "sshHost": "", "publicHost": "", "portMin": 39000, "portMax": 39999 }
}
```

- `tunnel.kind`：`cloudflare`（默认，quick tunnel）或 `ssh`（自备 VPS 反向隧道，需要 VPS 放行端口）。
- 环境变量覆盖：`DSH_NEARBY_TUNNEL`、`DSH_NEARBY_RELAY_SSH`、`DSH_NEARBY_RELAY_HOST`、`CLOUDFLARED_BIN`。

## 常见问题

**手机打不开链接？** 先确认手机和电脑在同一个 Wi-Fi，且路由器没有开启 AP 隔离 / 访客网络隔离。可以先用另一台电脑访问面板里显示的 `http://<局域网 IP>:<端口>/` 验证。

**macOS 弹出防火墙提示？** 允许 Node 接受传入连接，否则手机无法访问随机端口。

**开了代理但打不开？** 手机或电脑的系统代理可能把局域网 IP 也代理了；把局域网网段加入 `no_proxy`，或临时关闭代理。

**大文件传一半失败？** 局域网模式单文件上限 2 GiB；公网隧道有单请求大小限制，插件会自动分片，但请保持页面在前台。

**房间关了还能进吗？** 不能。关房后 60 秒内刷新会看到「这个房间已经关了」，之后端口回收、页面无法连接。

## 开发

```sh
node --check index.js
node --check client.js
```

插件结构：`index.js`（Host：路由 / 房间 / 隧道 / Agent 工具）、`client.js`（DSH 侧栏面板）、`guest.html`（手机访客页，零安装）、`cordis.patch.yml`（bundle 挂载）、`vendor/qrcode.cjs`（二维码生成）。


## 赞助

本仓库当前由 [采了么 AI 中转](https://ai.caileme.top) 赞助展示位。

<p align="center">
  <a href="https://ai.caileme.top">
    <img src="assets/sponsors/caileme-banner-github-1200x200-sponsor.png" alt="采了么 AI 中转 · 稳定好用的大模型 API" width="1200">
  </a>
</p>

更多尺寸与深色 / 浅色版本见 [assets/sponsors](assets/sponsors)。

## License

[MIT](LICENSE)
