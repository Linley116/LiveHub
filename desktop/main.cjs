// LiveHub 桌面端主进程：内嵌启动本地服务，主窗口加载同一个 Web UI。
// 账号登录走独立的平台登录窗口（persist 分区），登录成功后把 cookie 同步给本地服务，
// 之后自研播放器取流、弹幕连接都用这份登录态。
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, shell, session, nativeImage } = require('electron');
const shadow = require('./shadow.cjs');

/** 数据目录：打包后指到 userData，开发时是仓库里的 data/ */
let dataDir = null;
const sender = require('./sender.cjs');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PLATFORMS = ['bilibili', 'huya', 'douyu', 'douyin'];

const PLATFORM_META = {
  bilibili: {
    name: '哔哩哔哩',
    loginUrl: 'https://passport.bilibili.com/login',
    domain: 'bilibili.com',
    authCookies: ['SESSDATA'],
  },
  huya: {
    name: '虎牙',
    loginUrl: 'https://www.huya.com/',
    domain: 'huya.com',
    authCookies: ['yyuid', 'udb_uid'],
  },
  douyu: {
    name: '斗鱼',
    loginUrl: 'https://www.douyu.com/',
    domain: 'douyu.com',
    authCookies: ['acf_uid', 'acf_auth'],
  },
  douyin: {
    name: '抖音',
    loginUrl: 'https://www.douyin.com/',
    domain: 'douyin.com',
    authCookies: ['sessionid', 'sessionid_ss'],
    // 首页要再点一下「登录」才弹二维码，这里让打开即到位
    loginEntryWords: ['登录'],
    // 面板里二维码和验证码是并排的，窗口窄了右侧会被截断（实测 520 不够）
    loginSize: { width: 740, height: 860 },
  },
};

let mainWindow = null;
let httpServer = null;
let serverPort = null;
const loginWindows = new Map();

/**
 * 固定端口，不要再用 0 让系统随机分配。
 * localStorage / Cookie 是按 origin（含端口）隔离的，端口每次都变的话，
 * 每次启动对浏览器来说都是个全新的站点，之前存的偏好和服务端 session 全对不上。
 * 端口被别的进程占着就顺延一位，全被占了才退回随机。
 */
const DESKTOP_PORTS = Array.from({ length: 10 }, (_, i) => 8756 + i);

/** 把 Express 起在固定端口；偶发占用则顺延，实在不行才随机 */
async function bootServer() {
  const entry = pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href;
  const mod = await import(entry);
  let conflictError = null;
  for (const port of DESKTOP_PORTS) {
    try {
      const started = await mod.startServer({ port });
      httpServer = started.server;
      if (port !== DESKTOP_PORTS[0]) {
        console.warn(`[server] 默认端口 ${DESKTOP_PORTS[0]} 被占用，改用 ${started.port}`);
      }
      return started.port;
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
      conflictError = err;
    }
  }
  // 连续 10 个都被占：仍要能起来，代价是这次偏好不会被记住
  console.warn(
    '[server] 端口 8756-8765 均被占用，回退到随机端口；本次会话的观看偏好将无法跨启动保留',
    conflictError?.message || '',
  );
  const started = await mod.startServer({ port: 0 });
  httpServer = started.server;
  return started.port;
}

/** cookie 是否属于该平台的域名 */
function cookieBelongs(platform, cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  const base = PLATFORM_META[platform].domain;
  return host === base || host.endsWith(`.${base}`);
}

/** 导出该平台分区下的整份 cookie，形如 "a=1; b=2" */
async function exportCookie(platform) {
  const ses = session.fromPartition(`persist:${platform}`);
  const cookies = await ses.cookies.get({});
  return cookies
    .filter((cookie) => cookie.value && cookieBelongs(platform, cookie))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function hasAuthCookie(platform) {
  const ses = session.fromPartition(`persist:${platform}`);
  const cookies = await ses.cookies.get({});
  const names = PLATFORM_META[platform].authCookies;
  return cookies.some(
    (cookie) => names.includes(cookie.name) && cookie.value && cookieBelongs(platform, cookie),
  );
}

async function serverAccounts() {
  if (!serverPort) return [];
  const res = await fetch(`http://127.0.0.1:${serverPort}/api/accounts`);
  return res.json();
}

/**
 * 把分区里的 cookie 推给本地服务。
 * 没登录时只用来补设备指纹（ttwid / buvid3 这类），不能覆盖服务端已有的登录态——
 * 否则用户在浏览器模式手动粘的 Cookie 会被桌面端的匿名 cookie 冲掉。
 */
async function syncAccount(platform) {
  if (!serverPort) return null;
  const cookie = await exportCookie(platform);
  if (!cookie) return null;

  if (!(await hasAuthCookie(platform))) {
    const existing = await serverAccounts().catch(() => []);
    if (existing.find((item) => item.platform === platform)?.cookieCount) return null;
  }

  const res = await fetch(`http://127.0.0.1:${serverPort}/api/accounts/${platform}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `同步失败（${res.status}）`);
  mainWindow?.webContents.send('livehub:accounts-changed');
  return data;
}

async function syncAllAccounts() {
  for (const platform of PLATFORMS) {
    try {
      await syncAccount(platform);
    } catch (err) {
      console.error(`[accounts] ${platform} 同步失败:`, err.message);
    }
  }
}

/** URL 是否还在该平台的站点内 */
function isPlatformPage(platform, url) {
  try {
    const host = new URL(url).hostname.replace(/^\./, '').toLowerCase();
    const base = PLATFORM_META[platform].domain;
    return host === base || host.endsWith(`.${base}`);
  } catch {
    return false;
  }
}

/**
 * 把窗口可靠地带到前台。
 * 这是「第二次点登录打不开」的根因：focus() 对隐藏或最小化的窗口不生效，
 * 必须自己 show()/restore()，否则用户点了登录什么也不会出现。
 */
function revealWindow(win) {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (win.isVisible()) win.focus();
  else win.show(); // show() 会自带聚焦
  // macOS 上窗口还可能藏在别的 App 后面，要把整个应用拉到前台
  if (process.platform === 'darwin') app.focus({ steal: true });
  else win.moveTop();
}

/** 登录页加载不出来时的兜底页，避免用户对着白屏 */
function loginFailurePage(meta, reason) {
  const html = `<!doctype html><meta charset="utf-8">
  <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#14161b;color:#d7dae2;font:14px/1.7 -apple-system,'PingFang SC',sans-serif">
    <div style="max-width:340px;text-align:center">
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">打不开 ${meta.name} 的登录页</div>
      <div style="color:#8b90a0;font-size:12.5px">${reason}</div>
      <div style="color:#8b90a0;font-size:12.5px;margin-top:12px">
        检查网络后，回到 LiveHub 再点一次「登录」。
      </div>
    </div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * 抖音这类首页不会直接显示二维码，要先点一下「登录」才弹出面板（试过
 * /passport/ 这种直链，会被 ERR_FAILED 拒掉），这里帮忙点开。
 */
function autoOpenLoginPanel(win, platform) {
  const words = PLATFORM_META[platform].loginEntryWords;
  if (!words) return () => {};
  let tries = 0;
  const timer = setInterval(async () => {
    if (win.isDestroyed() || tries >= 8) return clearInterval(timer);
    tries += 1;
    try {
      // 已经登录就停止，别把登录后的页面再点乱
      if (await hasAuthCookie(platform)) return clearInterval(timer);
      const clicked = await win.webContents.executeJavaScript(`(() => {
        if (document.querySelector('[class*="qrcode" i], [class*="qr-code" i]')) return 'panel-open';
        const words = ${JSON.stringify(words)};
        const hit = [...document.querySelectorAll('a, button, [role="button"], span, div')].find((node) => {
          const text = (node.innerText || node.textContent || '').trim();
          if (!text || text.length > 10) return false;
          if (!words.some((word) => text === word || text.startsWith(word))) return false;
          if (node.offsetParent === null) return false;
          const rect = node.getBoundingClientRect();
          if (rect.top < 0 || rect.width < 24 || rect.height < 16) return false;
          return getComputedStyle(node).visibility !== 'hidden';
        });
        if (!hit) return null;
        hit.click();
        return 'clicked';
      })()`);
      if (clicked) clearInterval(timer);
    } catch {
      /* 页面还在跳转，下一轮再试 */
    }
  }, 1200);
  return () => clearInterval(timer);
}

/** 打开平台官方登录页；检测到登录 cookie 后自动同步并关窗 */
async function openLogin(platform, options = {}) {
  const meta = PLATFORM_META[platform];
  if (!meta) return { ok: false, error: '未知平台' };
  const wantReload = Boolean(options.reload);

  // 窗口还在（可能上一次卡在空白页，或被 window.open 带到了别的站点）：
  // 复用它，必要时重新导航回登录页——这正是「第二次点登录没反应」的场景
  const existing = loginWindows.get(platform);
  if (existing && !existing.isDestroyed()) {
    revealWindow(existing);
    const current = existing.webContents.getURL();
    if (wantReload || !isPlatformPage(platform, current)) {
      existing.loadURL(meta.loginUrl).catch(() => {});
      return { ok: true, reused: true, reloaded: true };
    }
    return { ok: true, reused: true };
  }

  const win = new BrowserWindow({
    width: meta.loginSize?.width || 620,
    height: meta.loginSize?.height || 780,
    minWidth: 420,
    minHeight: 560,
    title: `登录 ${meta.name}`,
    parent: mainWindow || undefined,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      partition: `persist:${platform}`,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  loginWindows.set(platform, win);

  // 抖音首页很重，网络慢时 ready-to-show 迟迟不来，窗口会一直不显示。
  // 加个兜底：超时就直接显示，宁可看到加载中也别让用户以为没反应。
  let shown = false;
  const markShown = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', () => {
    clearTimeout(showFallback);
    markShown();
  });
  const showFallback = setTimeout(() => {
    clearTimeout(showFallback);
    markShown();
  }, 1500);

  win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    // -3 = 加载被中断（用户或代码主动取消），不用提示
    if (!isMainFrame || code === -3 || win.isDestroyed()) return;
    console.error(`[login] ${platform} 加载失败: ${desc} (${code}) ${url}`);
    clearTimeout(showFallback);
    markShown();
    win.loadURL(loginFailurePage(meta, `${desc}（${code}）`)).catch(() => {});
  });

  // 平台的登录页偶尔会 window.open 出扫码窗 / 验证码页，默认在当前窗口里打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') return { action: 'deny' };
    if (url.startsWith('http://') || url.startsWith('https://')) {
      win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    }
    // 自定义协议（各类 App 唤起）交给系统，自己加载会直接失败
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const stopAutoClick = autoOpenLoginPanel(win, platform);

  // 打开前就已有登录态时不能自动关窗：用户点登录常常就是想换号或补登，
  // 一检测到历史 cookie 就秒关会很莫名。这时保持开着让用户操作，
  // 他自己关窗时下面的 closed 回调照样会把最新 cookie 同步过去。
  const hadAuthAtStart = await hasAuthCookie(platform).catch(() => false);

  const timer = setInterval(async () => {
    if (win.isDestroyed()) return;
    try {
      if (!(await hasAuthCookie(platform))) return;
      if (hadAuthAtStart) return; // 打开前就登录着：留着窗口，不抢关
      clearInterval(timer);
      await syncAccount(platform).catch((err) =>
        console.error(`[accounts] ${platform} 同步失败:`, err.message),
      );
      setTimeout(() => {
        if (!win.isDestroyed()) win.close();
      }, 600);
    } catch {
      /* 页面还没加载完时忽略 */
    }
  }, 1200);

  win.on('closed', async () => {
    clearInterval(timer);
    clearTimeout(showFallback);
    stopAutoClick();
    loginWindows.delete(platform);
    // 用户手动关窗也再同步一次，避免「登录了但没检测到」的情况
    try {
      await syncAccount(platform);
    } catch {
      /* 没登录就静默跳过 */
    }
    mainWindow?.webContents.send('livehub:accounts-changed');
  });

  win.loadURL(meta.loginUrl).catch((err) => {
    console.error(`[login] ${platform} 初始加载失败:`, err.message);
    clearTimeout(showFallback);
    markShown();
    win.loadURL(loginFailurePage(meta, err.message)).catch(() => {});
  });
  return { ok: true };
}

/** 退出登录：清空该平台分区的 cookie，并删掉服务端账号 */
async function logout(platform) {
  const meta = PLATFORM_META[platform];
  if (!meta) return { ok: false, error: '未知平台' };
  const ses = session.fromPartition(`persist:${platform}`);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage'] });
  if (serverPort) {
    await fetch(`http://127.0.0.1:${serverPort}/api/accounts/${platform}`, { method: 'DELETE' });
  }
  mainWindow?.webContents.send('livehub:accounts-changed');
  return { ok: true };
}

function registerIpc() {
  ipcMain.handle('livehub:login', (_event, platform, options) =>
    openLogin(String(platform), options || {}),
  );
  ipcMain.handle('livehub:logout', (_event, platform) => logout(String(platform)));
  ipcMain.handle('livehub:sync-account', (_event, platform) => syncAccount(String(platform)));
  // 主题切换后同步窗口底色：拉伸窗口时露出的底色不能还是另一个主题的
  ipcMain.on('livehub:theme', (_event, theme) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBackgroundColor(theme === 'light' ? '#f1f2f5' : '#0f1115');
  });
  shadow.registerShadowIpc();
  sender.registerSenderIpc();
}

/**
 * 开发模式（npm run desktop）是直接用 electron 二进制跑起来的，Dock / 任务栏
 * 显示的是 Electron 自己的图标 —— build/icon.icns 只有在「打包」时才会被写进 .app。
 * 这里在运行时补上图标，让开发模式看到的也是 LiveHub 图标。
 * 打包后 .app 自带 icns，且 build/ 不会打进包里（files 里已排除），
 * 因此找不到文件时会返回 null，不覆盖原生图标。
 */
function appIconPath() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(__dirname, 'assets', 'icon.png'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

async function createWindow(port) {
  const iconPath = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0f1115',
    title: 'LiveHub',
    // Windows / Linux 任务栏图标；macOS 的 Dock 图标走下面的 app.dock.setIcon
    ...(iconPath ? { icon: iconPath } : {}),
    show: false,
    // 接管标题栏：系统的浅灰标题条和页面近黑底色永远是两截，
    // 看起来像「外面套了个壳」。改成隐藏式标题栏后红绿灯直接浮在侧栏上，
    // 整窗只剩一块深色画布；顶部 46px 拖拽区在页面里用 .window-bar 提供。
    titleBarStyle: 'hiddenInset',
    // 灯组宽 52（12×3 + 8×2），轨道 80 → x=14 时左右各留 14px；y=17 让灯在 46px 顶区上下居中
    trafficLightPosition: { x: 14, y: 17 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,   // 已移除「平台官方页」内嵌，不再需要 webview 权限
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 站外链接交给系统浏览器，不在应用里乱开窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 打包后 .app 内部是只读的（且在 /Applications 下），
 * 所以把数据目录指到 userData：关注列表和账号 cookie 都写这里，升级重装不会丢。
 * 必须在 import server 之前设好——服务端模块在加载时就会读这个环境变量。
 */
function prepareDataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  process.env.LIVEHUB_DATA_DIR = dir;
  dataDir = dir;

  // 首次启动：把打包时带上的关注列表铺进去（只含房间，不含任何账号 cookie）
  const rooms = path.join(dir, 'rooms.json');
  const seed = path.join(__dirname, '..', 'seed', 'rooms.json');
  if (!fs.existsSync(rooms) && fs.existsSync(seed)) {
    try {
      fs.copyFileSync(seed, rooms);
    } catch (err) {
      console.error('[seed] 关注列表初始化失败:', err.message);
    }
  }
  return dir;
}

app.whenReady().then(async () => {
  prepareDataDir();

  // macOS：开发模式下 Dock 会显示 Electron 图标，这里换成 LiveHub 图标。
  // 打包后由 .app 自带的 icon.icns 提供，此时文件不存在会静默跳过。
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = appIconPath();
    if (iconPath) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) app.dock.setIcon(image);
    }
  }

  // 平台原页 / 登录窗口的登录态按 partition 落地，第二次进来还是已登录
  for (const platform of PLATFORMS) {
    const ses = session.fromPartition(`persist:${platform}`);
    ses.setUserAgent(UA);
  }

  try {
    serverPort = await bootServer();
    shadow.setServerPort(serverPort);
    sender.setServerPort(serverPort);
    // 发送窗口首次打开时用服务端保存的 cookie 补齐分区：
    // 用户若是「浏览器模式粘贴 cookie」登录的，persist 分区里其实没有登录态
    sender.setCookieSource((platform) => {
      try {
        const file = path.join(dataDir || path.join(__dirname, '..', 'data'), 'accounts.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data?.[platform]?.cookie || '';
      } catch {
        return '';
      }
    });
    registerIpc();
    await createWindow(serverPort);
    // 上次登录留下的 cookie 再推一次，保证服务端和 session 一致
    syncAllAccounts().catch(() => {});
  } catch (err) {
    console.error('启动失败:', err);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow(serverPort);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  shadow.closeAllShadows();
  sender.closeAllSenders();
  httpServer?.close();
  httpServer = null;
});
