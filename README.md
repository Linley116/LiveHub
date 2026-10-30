<div align="center">

<p align="center"><img src="docs/images/livehub-logo.svg" alt="LiveHub" width="520"></p>

<p><b>把四个直播平台收进一个窗口：主播库、播放器、弹幕收发，全部本地运行。</b></p>

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-2b3345?style=flat-square">
  <img alt="electron" src="https://img.shields.io/badge/Electron-45-47848F?style=flat-square&logo=electron&logoColor=white">
  <img alt="node" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="local" src="https://img.shields.io/badge/%E6%9C%AC%E5%9C%B0%E8%BF%90%E8%A1%8C-%E4%B8%8D%E4%B8%8A%E4%BC%A0%E6%95%B0%E6%8D%AE-success?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
</p>

</div>

## 项目简介

LiveHub 是一个**本地优先**的直播工作台。不用在四个网站的标签页之间来回切，也不用忍受各家播放器的广告和推荐流。

- 粘贴链接就能把直播间加进自己的**主播库**，按主播、平台、开播状态管理
- 用**自研播放器**看，清晰度和线路自己选
- **弹幕能读也能发**，悬浮在画面上，发送框就在播放器控制条里
- **侧栏可折叠**成头像轨，常看的主播拖进「特别关注」置顶，不开播也排在最前
- **外观三态**：跟随系统 / 日间 / 夜间，实时切换
- 所有数据留在本机，不需要注册 LiveHub 账号

> 视频流和弹幕都来自各平台官方接口，LiveHub 只是把它们整理成一个自己顺手的界面。

## 功能

| 能力 | 说明 |
| --- | --- |
| 📥 导入房间 | 粘贴直播间链接、短链，或直接输入 `平台 房间号` |
| 🗂 主播库 | 按平台筛选、搜索、按开播状态/人气/导入时间排序，本地 JSON 保存 |
| ⭐ 特别关注 | 把主播拖进侧栏「特别关注」即置顶，不开播也排在最前；右键可移除主播 |
| 🫥 侧栏折叠 | 一键收成 80px 头像轨，悬停看名字与当前直播标题，点头像直接切台 |
| 🎨 外观 | 跟随系统 / 日间 / 夜间三态，实时切换，浮在画面上的控件两套主题保持一致 |
| 📺 自研播放器 | HLS / HTTP-FLV 双协议，清晰度与 CDN 线路分开切换，断流自动重连 |
| 💬 弹幕 | 四平台全部接入，悬浮在画面上，不再单独占侧栏 |
| ✍️ 弹幕发送 | 四平台全部可用，带发送前校验、失败原因说明、自己发的去重 |
| 👤 平台账号 | 应用内扫码/密码登录，Cookie 只落本机，入口在窗口右上角 |
| 🔄 开播状态 | 目录页 3 分钟轮询，进房间未开播每 30 秒重试 |
| 🪟 窗口 | 隐藏式标题栏，红绿灯浮在侧栏上，整窗只剩一块画布 |

## 平台支持

| 平台 | 看直播 | 读弹幕 | 发弹幕 | 读取方式 |
| :--- | :---: | :---: | :---: | :--- |
| 哔哩哔哩 | ✅ | ✅ | ✅ | 服务端直连 WSS（brotli 分包） |
| 虎牙 | ✅ | ✅ | ✅ | 服务端直连 `wsapi.huya.com` |
| 斗鱼 | ✅ | ✅ | ✅ | 服务端直连 `danmuproxy.douyu.com` |
| 抖音 | ✅ | ✅ | ✅ | 桌面端影子窗口旁路抓包（需桌面版） |

补充说明：

- **抖音的读取和发送都依赖桌面版**——它的接口要 `a_bogus` 现算签名，LiveHub 不自己造签名，而是让官方页面算，再从旁复制字节。浏览器模式只能看直播，拿不到弹幕。
- 发送策略分两种：B 站由服务端直接调接口；斗鱼 / 虎牙 / 抖音由桌面端在真实页面里「输入 + 点发送」，因为这三家的发送通道要么签名在页面里、要么会校验客户端指纹。

## 快速开始

### 一、源码运行（开发 / 体验）

```bash
git clone https://github.com/Linley116/LiveHub.git
cd livehub
npm install

npm run desktop    # 桌面版（推荐，弹幕/发送功能最全）
npm start          # 浏览器版 → http://127.0.0.1:7788（只能看 + 读弹幕）
```

要求：Node.js ≥ 20。开发模式在 macOS / Windows / Linux 都能跑，**目前只提供 macOS 安装包**。

上手三步：

1. 左侧输入框粘贴直播间链接（或输 `douyu 138243`）→ 回车
2. 点卡片进房间，播放器自动取流；侧栏点头像可以直接切台
3. 右上角「平台账号」登录一次，弹幕和原画清晰度就都解锁了

### 二、仓库里没有的东西（先说清楚）

- **`dist/` 目录不在 git 仓库里**（已在 `.gitignore` 中忽略）。
- **`.dmg` 安装包也没有上传到仓库**——它是「打包」环节生成的本地产物，体积大且每次构建都会变，不适合进版本库。
- 因此 clone 下来看不到 `dist/`、`*.dmg` 是**正常现象，不是缺文件**。想拿到安装包，按下面的「打包」自己构建，或去仓库的 **Releases** 页下载（若已发布）。

### 三、从源码到安装包：三个环节

**1. 构建（Build）**

```bash
npm install        # 安装依赖，就绪后即可运行
```

- Web UI 是原生 JS，**没有额外的打包 / 编译步骤**；依赖装好后 `npm run desktop` 就能直接跑源码。
- 产物：本机 `node_modules/` + 可直接运行的源码，**没有独立产物目录**。

**2. 打包 / 分包（Package）**

三平台各自一条命令，分别出对应安装包：

```bash
npm run dist:mac      # macOS   → dist/LiveHub-<版本>-arm64.dmg
npm run dist:win      # Windows → dist/LiveHub Setup <版本>.exe（NSIS 安装包）
npm run dist:linux    # Linux   → dist/LiveHub-<版本>.AppImage / .deb

npm run dist          # 等价于 dist:mac（当前主力平台）
npm run dist:all      # 一次性出 mac + win + linux 三套（适合 CI）
npm run dist:dir      # 只出 macOS 的 .app，用于快速验证、不出 DMG
```

各平台产物与注意点：

| 平台 | 命令 | 产物 | 备注 |
| :--- | :--- | :--- | :--- |
| macOS | `dist:mac` | `.dmg`（arm64） | 本机直接可打，已用 `build/icon.icns` |
| Windows | `dist:win` | `.exe`（NSIS） | 在 Windows 上打最稳；在 macOS 上打需要 Wine |
| Linux | `dist:linux` | `.AppImage` / `.deb` | `.AppImage` 跨平台可打；`.deb` 需在 Linux 或装了 `dpkg`/`fpm` 的环境打 |

补充：

- 三端图标已统一：`build/icon.icns`（macOS）、`build/icon.ico`（Windows）、`build/icon.png`（Linux），均由 `docs/images/livehub-app-icon.svg` 导出，无需再单独准备；
- 跨平台一次性打包（`dist:all`）建议在 CI 矩阵里**按平台分别跑**，而不是在一台机器上同时打三端（macOS 打 Windows 需要 Wine，打 `.deb` 需要 `dpkg`/`fpm`）；
- 所有产物都在本地 `dist/`，`dist/` 已被 gitignore，不会进仓库，需自行发布到 Releases。

**3. 分发（Distribute）**

- 仓库本身只承载**源码**，不托管 DMG；当前未配置 CI/CD，Release 需手动把 `dist/` 产物上传。
- 未签名 / 未公证的 DMG 在 macOS 上会提示「已损坏 / 无法验证开发者」，处理方式见下方常见问题。

## 界面

<p align="center"><img src="docs/images/hub.jpg" alt="LiveHub 主播库" width="920"></p>

**主播库**：左侧主播列表，顶部筛选与排序，右上角是平台账号与外观设置。
拖动主播到「特别关注」就能置顶，右键可以移除主播。

<p align="center"><img src="docs/images/hub-light.jpg" alt="LiveHub 主播库（日间模式）" width="920"></p>

**日间模式**：同一套界面的浅色版本，深浅两套各自调过对比度；
播放器上的控件浮在画面上，两套主题长得一样。

<p align="center"><img src="docs/images/room.jpg" alt="观看页" width="920"></p>

**观看页**：画面居中，弹幕直接浮在画面上，发送框做进播放器底部的控制条。四个平台在这个页面上长得一样。

## 工作原理

```text
┌───────────────────────────────────────────────────────────┐
│                      Electron 主进程                        │
│                                                           │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│   │  内嵌 Express │   │  登录窗口      │   │  发送/影子窗口 │  │
│   │  随机端口     │   │  persist 分区  │   │  隐藏、静音    │  │
│   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘  │
└──────────┼──────────────────┼──────────────────┼──────────┘
           │                  │                  │
      ┌────▼──────────────────▼──────────────────▼────┐
      │              本地服务（Node / ESM）            │
      │  resolvers  四平台取流与元数据解析              │
      │  danmaku    四平台连接器 + 连接生命周期管理       │
      │  accounts   Cookie 存储与登录判定               │
      │  store      本地房间库                         │
      └────────────────────┬─────────────────────────┘
                           │ HTTP / SSE
                    ┌──────▼──────┐
                    │  Web UI      │
                    │  原生 JS     │
                    └─────────────┘
```

三层各管一件事：

- **resolvers**：把「房间号」变成「能播的地址」。四个平台的接口、签名、清晰度参数都不一样，全部在这里抹平。
- **danmaku**：每个平台一个连接器，统一输出 `{ user, content, color, timestamp }`。同一房间多个页面只连一条上游，最后一个人走了才断。
- **Web UI**：原生 JS（没有框架），通过 SSE 接弹幕，通过 REST 管房间。

技术深水区（虎牙切片签名、斗鱼静默丢弃、抖音签名旁路、发送通道选型等）单独放在 **[docs/TECHNICAL.md](docs/TECHNICAL.md)**。

## 数据与隐私

- 房间库：`<userData>/data/rooms.json`（macOS 是 `~/Library/Application Support/livehub/data/`），
  特别关注等标记也写在这里；写入是原子的（临时文件 + 替换），并留一份 `.bak` 备份
- 平台 Cookie：同目录 `accounts.json`，**只在本机**，不上传、不回传
- 服务默认只监听 `127.0.0.1`，随机端口，外部访问不到
- 删除数据：侧栏「清空房间库」，或直接删掉上面那个目录

## 常见问题

<details>
<summary><b>打开应用提示「已损坏」或「无法验证开发者」</b></summary>

安装包没有做代码签名/公证。右键 App → **打开**，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/LiveHub.app
```
</details>

<details>
<summary><b>为什么要用桌面版，浏览器版不行吗？</b></summary>

四家平台的房间页都不允许被第三方站点内嵌（B 站 `X-Frame-Options`、抖音 CSP 白名单），
第三方 Cookie 限制也会让登录态失效。桌面版用 Electron 在后台加载官方页面，是顶层上下文，
不受这些限制——**发弹幕、读抖音弹幕**都依赖这一点。

这些官方页面只在后台窗口里跑，不会出现在界面上：LiveHub 自己不跳转到平台网页，
视频、弹幕、发送全部走自研播放器。

浏览器版仍然可以看直播、读 B 站/虎牙/斗鱼的弹幕。
</details>

<details>
<summary><b>提示「本直播间无法发言」怎么办？</b></summary>

说明这个房间设了发言门槛。LiveHub 会尽量给出具体原因（需要粉丝牌 / 等级 / 已禁言 / 仅管理员），
实在拿不到时也会明确告诉你「这个房间可能限制了发言」。

满足条件后（比如加了粉丝团），直接在输入框再点一次发送即可，不需要重启。
</details>

<details>
<summary><b>某个直播间突然黑屏 / 解析失败</b></summary>

直播平台的接口和页面结构会变。先试：切线路 → 切清晰度 → 重新进房间。
仍然不行的话，多半是该平台的解析需要更新（见 `server/resolvers/`）。
</details>

<details>
<summary><b>登录后清晰度还是没解锁</b></summary>

部分平台未登录会**降级但不报错**（B 站请求原画只回超清，斗鱼只回蓝光）。
LiveHub 会比对「请求档位 / 实际下发档位」，在播放器下方明确提示，不会假装切成功。
遇到这种情况，去「平台账号」里确认登录态还在。
</details>

## 项目结构

```text
server/
  index.js            Express 服务与本地 REST API
  resolvers/          四平台房间元数据与播放线路解析
  danmaku/            四平台弹幕连接器 + 生命周期管理
  accounts.js         平台账号（Cookie 存储、登录判定）
  store.js            本地房间库
desktop/
  main.cjs            Electron 主进程：内嵌服务、登录窗口、账号同步
  sender.cjs          弹幕发送器（在真实页面里代发）
  shadow.cjs          抖音影子窗口（旁路抓弹幕）
  preload.cjs         暴露给页面的桥
web/
  index.html          主播库与观看页
  app.js              路由、播放器、弹幕面板
  hub.css             样式
docs/
  TECHNICAL.md        技术细节与踩坑记录
```

## 免责声明

本项目仅用于个人学习和本地使用。所有直播内容、弹幕数据的版权归各平台及主播所有。
请遵守各平台的服务条款，不要用于爬取、批量分发或其他商业用途。
接口随时可能变化，不保证长期可用。

## License

本项目代码遵循 [MIT](LICENSE) © Linley116，你可以自由使用、修改、分发，保留版权声明即可。
