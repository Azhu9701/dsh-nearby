# 邻座 · NextSeat

**同一物理空间里的临时分享房间。** 在 DSH 里开一间房，对方扫个码、用浏览器就能把文件、提示词卡片、技能包递过来——不装 App、不加好友、不经过任何账号体系；关房即散，什么都不留在云端。

> 适合：沙龙、课堂、会议、上门交付这种「人就在旁边，但传个文件还得先加微信」的场合。

## 功能

- **一对多房间**：宿主开房得到 4 位房间码 + 二维码 + 带 token 的链接；同一 Wi-Fi 下的人用手机浏览器直接进，无需安装。
- **文件互传**：访客上传、宿主投放，落盘到宿主收件箱并记录 SHA-256；单文件上限 2 GiB，大文件自动按 32 MB 分片上传，跨公网隧道也稳。
- **提示词卡片**：纯 JSON 卡片（标题 / 标签 / 正文 / 作者），只渲染不执行；宿主可一键导入本地提示词库。
- **技能包分享**：把本机技能目录打包成 zip 放进房间，访客下载；宿主也能一键把别人递来的 zip 装进 `~/.dsh/skills`（校验路径穿越与符号链接）。
- **房间留言**：访客和宿主都能留一句话，像白板一样即时可见。
- **就近自动发现**：同一 Wi-Fi 下开着邻座的其他实例会自动出现在面板「附近的人」里，一键进对方的房间，不用扫码。
- **远程宿主模式**：人不在现场时，可让房间挂一条 Cloudflare quick tunnel 出公网，现场的人打开 https 链接即可进入（单请求限制由分片上传绕过）。
- **Agent 工具**：`nearby_room` / `nearby_share` / `nearby_inbox`，模型可以自己开房、递东西、读收件箱。

## 安装

插件市场上架后可直接搜索「邻座 / NextSeat」安装。手动安装：

```sh
dsh plugin --profile web add github:Azhu9701/dsh-nearby
```

装好后按提示重载（或点侧栏刷新）即可在侧栏看到「邻座」面板。

## 用法

1. 打开侧栏「邻座」，填一个称呼、选时长，点「开一间房」。
2. 把二维码或链接给身边的人，对方用手机浏览器打开（不用装任何东西）。
3. 对方上传文件 / 递卡片 / 留言；宿主在面板里实时看到，「保存」到本机或「导入提示词库」。
4. 事情办完点「关房」：端口回收，房间不存在了。

远程场景：勾选「让外网的人也能进」，等隧道起来后把 https 链接或二维码发给现场的人。注意这条链接在房间存续期间任何拿到它的人都能进，别往公开群里发。

## 安全与隐私

- 默认只接受**私有网段来源**的访客请求（127/10/172.16-31/192.168/169.254/ULA/链路本地），公网 IP 一律拒绝。
- 房间用 32 字节随机 token 鉴权；宿主侧变更接口还要求自定义请求头，防跨站简单请求。
- 上传文件名会净化；zip 技能包安装前检查绝对路径、`..` 和符号链接。
- 数据只落在宿主本机 `~/.dsh/storages/dsh_nearby/`，关房后房间目录可自行清理；不经过任何第三方服务器（Cloudflare 隧道只是 TCP 转发，不解密业务内容之外的东西，但 HTTPS 终止在 Cloudflare 边缘）。
- 本插件不提供端到端加密：局域网内是明文 HTTP，仅适合可信网络。

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

## 开发

```sh
node --check index.js
node --check client.js
```

插件结构：`index.js`（Host：路由 / 房间 / 隧道 / Agent 工具）、`client.js`（DSH 侧栏面板）、`guest.html`（手机访客页，零安装）、`cordis.patch.yml`（bundle 挂载）。

## License

MIT
