# 技术细节与踩坑记录

README 只讲「是什么、怎么用」。这里放实现细节——都是实测结论，不是推测。

- [1. 为什么必须是桌面端](#1-为什么必须是桌面端)
- [2. 取流：四个平台各自的坑](#2-取流四个平台各自的坑)
- [3. 清晰度与线路](#3-清晰度与线路)
- [4. 弹幕读取](#4-弹幕读取)
- [5. 弹幕发送](#5-弹幕发送)
- [6. 发言门槛识别](#6-发言门槛识别)
- [7. 通用踩坑清单](#7-通用踩坑清单)

---

## 1. 为什么必须是桌面端

四家平台的房间页都不允许被第三方站点内嵌：

- B 站返回 `X-Frame-Options: SAMEORIGIN`
- 抖音 CSP 有 `frame-ancestors` 白名单

即使绕过（比如改响应头），第三方 Cookie 限制也会让登录态失效，弹幕和清晰度都用不了。

Electron 里用独立窗口加载官方页面，那是**顶层上下文**，上面的限制都不成立。
所以「发弹幕」「读抖音弹幕」这类必须带登录态或页面签名的事情，全部交给桌面端。

这些官方页面只在后台窗口里跑：界面上的视频、弹幕、发送全部走自研播放器，
用户不会看到、也切不到平台官网页面（早期版本里的「平台官方页」页签已移除）。

浏览器版保留纯观看 + 三平台弹幕读取能力，是刻意的降级，不是缺陷。

## 2. 取流：四个平台各自的坑

| 平台 | 协议 | 关键点 |
| --- | --- | --- |
| 哔哩哔哩 | HLS / FLV | `qn` 控档位；未登录请求原画只回超清（`current_qn=250`） |
| 虎牙 | HTTP-FLV | 接口下发的 anticode **缺 `seqid`**，必须本地重算签名（见下） |
| 斗鱼 | HTTP-FLV | `rate` 控档位；未登录只回蓝光 |
| 抖音 | FLV / HLS | 一次下发全部档位，本地切，不重复请求 |

### 虎牙：一次性切片与本地重算签名（2026-10）

**现象**：直接用 mp 接口下发的 `sFlvAntiCode` 拼地址，每次只返回 1~7 秒就断（69~131ms / 400~970KB），
重复请求拿到的是同一段（首帧 timestamp 相同），所以断线重连也接不上；`sHlsUrl` 无论怎么带参数都 403。

**根因**：mp 下发的 anticode 里 **没有 `seqid`**。CDN 靠 `seqid = 主播 uid + 当前毫秒` 判断这是实时请求，
缺了它只给一个固定窗口。不需要换 token，用页面自带的 `fm` / `ctype` / `t` 加上 `lPresenterUid` 本地重算即可：

```text
seqid    = presenterUid + Date.now()
secret   = md5(`${seqid}|${ctype}|${t}`)
calcUid  = rotl32(low32(presenterUid), 8)
fmPrefix = base64decode(fm).split('_')[0]
wsSecret = md5(`${fmPrefix}_${calcUid}_${streamName}_${secret}_${wsTime}`)

最终 URL = {sFlvUrl}/{streamName}.flv
           ?wsSecret=..&wsTime=..&seqid=..&ctype=..&ver=1
           &fs=..&fm=..&t=..&u=..&codec=264[&ratio=N]
```

算法与 [biliup](https://github.com/biliup/biliup/blob/master/crates/biliup/src/downloader/live/huya.rs)、
[yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/huya.py) 一致。
`wsTime` 剩余不足 20 分钟时换成 24 小时后，签名可长期复用。

> 走过的弯路：`wup.huya.com` 的 `getCdnTokenInfoEx` 目前对任何请求都返回 502
> （4 种请求体编码 × 2 个 UA × 2 个 Origin × 4 个 IP × http/https × HTTP/1.1-h2 × 主站/备用端点，全部 502）。
> 这条通道不是必需的，相关代码已移除。

## 3. 清晰度与线路

播放器工具栏把「清晰度」和「线路」拆成两个下拉：

- **清晰度**是平台档位。切换时按平台参数重新取流（B 站 `qn`、斗鱼 `rate`、虎牙 `ratio`）；
  抖音一次下发全部档位，本地切。
- **线路**是同一档位下的不同 CDN（虎牙 4 条、斗鱼 2 条、B 站 HLS/FLV）。
- 选择按平台记在 localStorage，下次进同类房间沿用。

虎牙的 `iBitRate=0` 表示原画——此时**不带 `ratio` 参数**，实测 5 秒 3138KB，比 `ratio=4000` 的 2969KB 还高。

未登录时平台会**降级但不报错**。LiveHub 会比对「请求档位 / 实际下发档位」，在播放器下方明确提示，
不会假装切成功。实测切档后解码分辨率真的会变：

```text
抖音  原画 1920×1080 → 高清 1280×720
虎牙  蓝光4M 1920×1080 → 超清 1280×720
斗鱼  原画 1920×1088 → 高清 960×540
```

## 4. 弹幕读取

`server/danmaku/` 每个平台一个连接器，统一输出 `{ user, content, color, timestamp }`；
`hub.js` 管连接生命周期、退避重连和多端共享（同一房间多个页面只连一条上游）；
前端通过 SSE（`/api/danmaku/stream`）订阅。

| 平台 | 通道 | 要点 |
| --- | --- | --- |
| 哔哩哔哩 | `wss` 长连接 | brotli 分包；`getDanmuInfo` 有 -352 风控，必须带 WBI 的 `w_rid`/`wts`；登录后以账号 uid 认证 |
| 虎牙 | `wss://wsapi.huya.com` | 命令 16 订阅 `chat:<主播 UID>`，命令 7 单条 / 22 批量推送 |
| 斗鱼 | `wss://danmuproxy.douyu.com:8501` | STT 帧格式；匿名即可 `LOGIN OK` |
| 抖音 | 页面旁路 | 影子窗口复制 `im/fetch` 响应体，回灌 `POST /api/danmaku/ingest` 做增量 protobuf 解析 |

几个反直觉的点：

**斗鱼必须走 danmuproxy，不是 wsproxy。**
`wsproxy.douyu.com` 的 6671/6673/6674 现在对**任何** `loginreq` 都回 `401000206`——试着照抄浏览器抓包
（空密码 / auth 密码 × 有无 jwt × 随机 devid / cookie 里的 devid × 多个端口），8 种组合全被拒。
8501 匿名即可登录。另外 **WebSocket 握手成功不代表可用**，要等到 `loginres` 才算成功，否则换下一条线。

**虎牙的 TARS 解析要按 `STRUCT_END` 完整消费嵌套结构体。**
早先那版用「tag 超过上限就回退」的写法，会把内层字段当成外层字段，结果一条都解不出来
（表现为「已连接但零消息」）。修正后实测 14 秒 58 条。

**抖音的签名与登录无关。**
`a_bogus` 是页面 JS 用 `msToken` + 一堆环境参数现算的。与其移植（易碎），不如开一个隐藏、静音的
**影子窗口**加载官方直播间页，用 preload 钩住页面的 `XMLHttpRequest`（`im/fetch` 走 XHR 而非 fetch，
响应体是 `arraybuffer`），把增量字节复制回来解码。所以**匿名房间也能拿到弹幕**。

调试单个平台：

```bash
node server/danmaku/probe.js huya 660000 30    # 平台 房间号 秒数
```

## 5. 弹幕发送

### 为什么不让服务端统一发

三家都试过服务端直发，全部否决，原因各不相同：

| 平台 | 结论 |
| --- | --- |
| 斗鱼 | 发送帧 `chatmessage` 只在 wsproxy 上有效，而 wsproxy 对非浏览器的 TLS 指纹一律回 `401000206`；danmuproxy 能登录、帧也发出去了，但服务端**静默丢弃**（订阅端收不到自己那条） |
| 虎牙 | `speakSendMessage` 是 TAF RPC，实际承载是 `POST cdnws.api.huya.com/?baseinfo=…`，依赖页面登录态与帧编码 |
| 抖音 | 输入框是 Slate 富文本，发送要走页面自己的签名链路 |

### 最终方案：能力分级

```text
sendMode = 'server'   → B 站：服务端直接调 /msg/send
sendMode = 'desktop'  → 其余三家：桌面端在真实页面里「输入 + 点发送」
```

桌面端发送器（`desktop/sender.cjs`）每个平台复用一个隐藏窗口，用 `persist:<platform>` 分区
——和登录窗口同一个分区，用户登录过一次就够。流程：加载房间页 → 填内容 → 点发送按钮 → 校验结果。

**校验不能只看输入框清空。** 斗鱼未登录/被拒时**也会清空输入框**，属于静默失败。
判据是双重的：页面里真的出现了这条内容，或者本地服务的弹幕流收到了平台回推（`/api/danmaku/echo`），
后者返回三态——收到 / 确认没收到 / 判断不了（房间没订阅），避免把正常房间误判成受限。

### 发送通道的小抄

| 平台 | 触发方式 | 注意 |
| --- | --- | --- |
| 虎牙 | 点 `#msg_send_bt` | 输入后按钮才解禁，点了没反应会换回车重试一次 |
| 斗鱼 | 点 `.ChatSend-button` | `.ChatSend-txt` 是 `contenteditable="plaintext-only"` |
| 抖音 | 点 `.webcast-chatroom___send-btn` | 没有独立按钮时回车也能发，但必须 `keyDown` 带 `text:'\r'` |

## 6. 发言门槛识别

有些房间设了粉丝牌/等级/禁言限制，发不出去。提示要准确，否则用户只会觉得「这软件坏了」。

三层判定，从准到保守：

1. **发送前**看输入区常驻提示。但文案必须带「发言/加入/才能/权限」这类规则口吻才认——
   否则页面上随便一个「粉丝团」导航标签就会把能发的房间误判成不能发。
2. **发送期间**每 250ms 采样页面短文案，取「发送前没有、期间出现过」的差集。
   toast 只闪 1~2 秒，等发完再快照必然错过。
3. **平台完全不给提示时**（斗鱼是静默丢弃），查房间设置接口 `betard`：

   | 字段 | 含义 | 实测 |
   | --- | --- | --- |
   | `is_set_fans_badge` | 是否设了粉丝牌门槛 | 实测：设了门槛的直播间 = 1（发不出去），官方赛事频道 = 0（正常），与实际情况完全吻合 |
   | `speakSet.onlyAdmin` | 仅管理员可发言 | — |
   | `speakSet.speaklimit` / `speakLv` | 等级门槛 | — |

第 3 层**只做事后解释、不提前拦截**——万一平台字段含义变了，也不会把本来能发的房间挡掉。

前端拿到 `code: 'restricted'` 后会记住本房间的门槛：占位文案改成「本直播间可能无法发言」，
说明栏写清原因，但**不锁输入框**——用户去加了粉丝团，直接再点一次发送就能成功，成功后状态自动清除。

## 7. 通用踩坑清单

给以后改这块的人（也可能是三个月后的自己）：

1. **`webContents.insertText` 对 `contenteditable` 无效。** 必须走 CDP：
   `debugger.attach('1.3')` + `Input.insertText`，且先 `Input.dispatchMouseEvent` 点到输入框。
2. **回车不一定能触发发送。** 富文本编辑器（Slate）不认 `rawKeyDown`，必须 `keyDown` 带 `text:'\r'`。
3. **别用改 `textContent` 的方式清空草稿。** Slate 内部状态不会跟着变，界面看着空了，之后回车发不出去。
   用 `Meta/Ctrl+A` 全选 + `insertText` 覆盖。
4. **清空后可能残留零宽字符 `\u200b`。** JS 的 `trim()` **不把 U+200B 当空白**，
   「输入框已清空」会永远判否，于是每次都被误判成失败（实际已经发出去了）。
5. **隐藏窗口 + 键盘事件不可靠，但鼠标点击可靠。** 所以三家发送都用「点按钮」而不是「按回车」，
   这样用户完全看不到窗口。
6. **Electron `cookies.set` 覆盖 HttpOnly 会抛异常**，必须 try/catch，否则整个流程静默中断。
7. **桌面端分区里可能没有登录态。** 用户若是「浏览器模式粘贴 cookie」登录的，
   `persist:<platform>` 分区其实是空的——发送窗口首次打开时会用服务端保存的 cookie 补齐。
8. **Electron 下 `process.argv` 会把 `--no-sandbox` 也算进去**，按位置取参会错位。
