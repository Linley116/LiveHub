// 平台弹幕发送器：在真实页面上下文里代用户「输入 + 点发送」。
//
// 为什么不做服务端直发：
//   斗鱼 wsproxy 对 Node 的 TLS 指纹一律回 401000206（同一账号在浏览器里正常）；
//   虎牙走 TAF RPC 且依赖页面登录态；抖音要 a_bogus 现算。
//   三家共同点是「页面自己就是合法客户端」，于是让页面干这件事最稳，也不用复刻签名。
//
// 每个平台复用一个隐藏窗口，窗口用 persist:<platform> 分区——和登录窗口同一个分区，
// 所以用户在 LiveHub 里登录过一次就够了，不需要再传 cookie。
const { BrowserWindow, ipcMain } = require('electron');

const PLATFORMS = {
  douyu: {
    name: '斗鱼',
    url: (room) => `https://www.douyu.com/${room}`,
    input: '.ChatSend-txt',
    sendButtons: ['.ChatSend-button'],
    // 未登录时输入区会挂一个「未登录」提示
    loggedOutHint: '.ChatSend',
    // 斗鱼的弹幕列表不把回显写进 body.innerText，页面判据对它会误判，
    // 所以只等「输入框清空」，是否真发出去交给回查本地服务的回显来定
    pageEcho: false,
    maxLength: 50,
    origin: 'https://www.douyu.com/',
    domain: '.douyu.com',
  },
  huya: {
    name: '虎牙',
    url: (room) => `https://www.huya.com/${room}`,
    input: 'textarea[placeholder*="弹幕"], textarea',
    sendButtons: ['#msg_send_bt'],
    loggedOutHint: '.login-tips, .J_loginTips',
    maxLength: 30,
    origin: 'https://www.huya.com/',
    domain: '.huya.com',
  },
  douyin: {
    name: '抖音',
    url: (room) => `https://live.douyin.com/${room}`,
    // 抖音直播间的输入区是 editor-kit 富文本，占位文字「与大家互动一下...」
    input: '[data-placeholder*="互动"], .editor-kit-container [contenteditable="true"], div[contenteditable="true"]',
    // 输入框右侧那个「↑」就是发送键（.webcast-chatroom___send-btn，svg 元素）
    sendButtons: ['.webcast-chatroom___send-btn'],
    loggedOutHint: '',
    // 点按钮而不是回车：鼠标事件在隐藏窗口里同样有效，用户看不到任何窗口
    maxLength: 30,
    origin: 'https://live.douyin.com/',
    domain: '.douyin.com',
  },
};

/** platform -> { win, roomId, queue } */
const senders = new Map();

/** 最近一次发送成功的时间：用来判断「发不出去」是不是因为太频繁 */
let lastSuccessAt = 0;

/** 本地服务端口：用来回查「平台是否真的收下了这条」 */
let serverPort = null;
function setServerPort(port) {
  serverPort = port || null;
}

/**
 * cookie 兜底来源（由主进程注入，读服务端保存的账号）。
 * 发送窗口用的是 persist:<platform> 分区，如果用户是在浏览器模式里粘的 cookie，
 * 分区里其实没有登录态，页面会显示未登录、点了发不出去——首次打开窗口时补一次。
 */
let cookieSource = null;
function setCookieSource(fn) {
  cookieSource = typeof fn === 'function' ? fn : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ_VALUE = `(el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.textContent)`;

/**
 * 富文本编辑器清空后常留一个零宽字符（抖音的 Slate 就是），
 * JS 的 trim() 不把 U+200B 当空白，不去掉会误判成「输入框还有内容」。
 */
const cleanText = (value) =>
  String(value ?? '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();

/** 在页面里轮询某个选择器，返回是否出现 */
async function waitForSelector(win, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await win.webContents
      .executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)
      .catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

function createSender(platform) {
  const conf = PLATFORMS[platform];
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    webPreferences: {
      // 和登录窗口同分区：登录态直接复用
      partition: `persist:${platform}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏窗口默认会被节流，页面脚本会停摆，必须关掉
      backgroundThrottling: false,
    },
  });
  win.webContents.setAudioMuted(true);
  const entry = { win, platform, roomId: null, chain: Promise.resolve(), conf, seeded: false };
  win.on('closed', () => senders.delete(platform));
  return entry;
}

function getSender(platform) {
  const existing = senders.get(platform);
  if (existing && !existing.win.isDestroyed()) return existing;
  const entry = createSender(platform);
  senders.set(platform, entry);
  return entry;
}

/**
 * 首次打开某平台窗口时，把服务端保存的账号 cookie 灌进该分区。
 * 用户可能是「浏览器模式粘贴 cookie」登录的，那样 persist 分区里其实没有登录态，
 * 页面会当成未登录、点发送毫无反应——这里补一次就自愈了。
 */
async function seedCookies(entry, platform) {
  const { conf } = entry;
  if (!cookieSource) return;
  let raw = '';
  try {
    raw = String((await cookieSource(platform)) || '');
  } catch {
    return;
  }
  if (!raw) return;

  const { session } = require('electron');
  const ses = session.fromPartition(`persist:${platform}`);
  for (const piece of raw.split(';')) {
    const at = piece.indexOf('=');
    if (at <= 0) continue;
    const name = piece.slice(0, at).trim();
    const value = piece.slice(at + 1).trim();
    if (!name) continue;
    try {
      await ses.cookies.set({ url: conf.origin, name, value, domain: conf.domain, path: '/' });
    } catch {
      /* HttpOnly 之类改不了的跳过即可，分区里本来就有 */
    }
  }
}

async function ensureRoom(entry, roomId) {
  const { win, conf } = entry;
  if (entry.roomId === String(roomId) && !win.webContents.isLoading()) return;

  // 第一次进页面之前补齐登录态，避免「页面显示未登录 → 点了没反应」
  if (!entry.seeded) {
    entry.seeded = true;
    await seedCookies(entry, entry.platform);
  }

  entry.roomId = String(roomId);
  await win.loadURL(conf.url(roomId));
  // 页面框架起来后输入区才注入，这里给足时间
  const ok = await waitForSelector(win, conf.input, 20_000);
  if (!ok) throw Object.assign(new Error(`${conf.name}直播间页面里没找到输入框`), { sendCode: 'page_not_ready' });
  await sleep(800);
  // 隐藏窗口会把页面的后台任务节流（斗鱼的聊天 socket 跑在 Worker 里，节流后发送不出去），
  // 调试时可以强制显示；正式路径见 fillInput 的按需显示。
  if (process.env.LIVEHUB_SENDER_VISIBLE === '1') win.showInactive();
}

/** 把文本写进输入框：先聚焦，再走 CDP 输入通道（对 contenteditable 才有效） */
async function fillInput(entry, text) {
  const { win, conf } = entry;
  const box = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(conf.input)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName };
  })()`);
  if (!box) throw Object.assign(new Error('输入框不存在'), { sendCode: 'page_not_ready' });

  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);

  const readBack = () =>
    win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(conf.input)}); return el ? (${READ_VALUE})(el) : ''; })()`,
    );

  const typeOnce = async () => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(300);

    // 有残留草稿时用「全选 + 覆盖输入」清掉。
    // 不要用 JS 改 textContent —— 富文本编辑器（抖音的 Slate）内部状态不会跟着变，
    // 表面上文字没了，但后续回车发不出去。
    const existing = cleanText(await readBack());
    if (existing) {
      const meta = process.platform === 'darwin' ? 4 : 2; // Meta / Ctrl
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: meta,
      });
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: meta,
      });
      await sleep(150);
    }

    await cdp('Input.insertText', { text });
    await sleep(400);
    return readBack();
  };

  let typed = await typeOnce();
  if (String(typed || '').includes(text)) return typed;

  // 隐藏窗口里富文本编辑器常常拿不到焦点（斗鱼就是），临时显示一下再试。
  // 显示但不抢焦点，用完立刻藏回去。
  win.showInactive();
  await sleep(700);
  await win.webContents.focus();
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(conf.input)});
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
    return true;
  })()`);
  typed = await typeOnce();

  if (!String(typed || '').includes(text)) win.hide();
  return typed;
}

/**
 * 只按回车。注意必须用 keyDown 并带上 text:'\r'：
 * 富文本编辑器（抖音的 Slate）不认 rawKeyDown 的按键。
 */
async function pressEnter(entry) {
  const cdp = (method, params) => entry.win.webContents.debugger.sendCommand(method, params);
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r',
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

/** 优先点发送按钮（隐藏窗口里最可靠），没有按钮才回车 */
async function clickSend(entry) {
  const { win, conf } = entry;
  const btn = await win.webContents.executeJavaScript(`(() => {
    const sels = ${JSON.stringify(conf.sendButtons)};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return null;
  })()`);

  if (!btn) {
    await pressEnter(entry);
    return 'enter';
  }

  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  return 'button';
}

/**
 * 页面判据：输入框清空（+ 平台会在页面里回显时，再确认文本出现）。
 * pageEcho=false 的平台只等清空——它们的回显不在 DOM 里，等下去只会白等。
 */
async function verifySent(entry, text, timeoutMs) {
  const { win, conf } = entry;
  const wantEcho = conf.pageEcho !== false;
  const deadline = Date.now() + (timeoutMs || (wantEcho ? 7000 : 3000));
  let cleared = false;
  while (Date.now() < deadline) {
    const state = await win.webContents
      .executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(conf.input)});
        const value = el ? (${READ_VALUE})(el) : '';
        return { value: (value || '').replace(/[\\u200b-\\u200d\\ufeff]/g, '').trim(), seen: document.body.innerText.includes(${JSON.stringify(text)}) };
      })()`)
      .catch(() => ({ value: text, seen: false }));
    if (!state.value) cleared = true;
    if (cleared && (!wantEcho || state.seen)) return { ok: true, cleared };
    await sleep(300);
  }
  return { ok: false, cleared };
}

/** 页面是否显示未登录 */
async function detectLoggedOut(entry) {
  const { win, conf } = entry;
  if (!conf.loggedOutHint) return false;
  return win.webContents
    .executeJavaScript(`(() => {
      const boxes = [...document.querySelectorAll(${JSON.stringify(conf.loggedOutHint)})];
      if (boxes.some((el) => /未登录|请登录|登录后/.test(el.innerText || ''))) return true;
      const input = document.querySelector(${JSON.stringify(conf.input)});
      const ph = input ? (input.getAttribute('data-placeholder') || input.placeholder || '') : '';
      if (/未登录|请登录/.test(ph)) return true;
      // 有的版本把「未登录」单独挂成一个叶子节点
      const leaf = [...document.querySelectorAll('span,div,p,a')]
        .find((el) => !el.children.length && /^未登录|请先登录|登录后发言/.test((el.textContent || '').trim()));
      return Boolean(leaf);
    })()`)
    .catch(() => false);
}

/**
 * 往直播间发一条弹幕。同一平台串行执行，避免两次发送抢同一个输入框。
 * @returns {Promise<{ok: true, platform: string, roomId: string, content: string, via: string}>}
 */
function sendDanmaku({ platform, roomId, content }) {
  const conf = PLATFORMS[platform];
  if (!conf) return Promise.resolve({ ok: false, error: `暂不支持往${platform}发送弹幕`, code: 'unsupported' });

  const text = String(content ?? '').trim();
  if (!text) return Promise.resolve({ ok: false, error: '弹幕内容为空', code: 'empty' });
  if (text.length > conf.maxLength) {
    return Promise.resolve({ ok: false, error: `弹幕最长 ${conf.maxLength} 个字`, code: 'too_long' });
  }

  const entry = getSender(platform);
  const run = async () => {
    try {
      await ensureRoom(entry, roomId);
      if (await detectLoggedOut(entry)) {
        return { ok: false, error: `尚未登录${conf.name}账号，无法发送弹幕`, code: 'no_auth' };
      }

      // 发送前先看输入区：有的房间直接把「关注主播后可发言」写在输入框上，
      // 这种根本不用试，省得用户等一圈才收到失败
      const pre = await detectInputRestriction(entry);
      if (pre) return restrictedResult(conf, pre);

      const before = await collectNotices(entry);
      const watcher = watchNotices(entry, before);

      const typed = await fillInput(entry, text);
      if (!typed || !String(typed).includes(text)) {
        return { ok: false, error: '没能把内容写进输入框，页面结构可能变了', code: 'input_failed' };
      }

      let how = await clickSend(entry);
      let result = await verifySent(entry, text);

      // 第一次没生效就换另一种触发方式再来一次：
      // 点按钮依赖「输入后按钮才解禁」的时序，回车依赖编辑器是否接受合成按键，
      // 两者互补，实测能救掉偶发的「点了没反应」。
      if (!result.ok && !result.cleared) {
        if (how === 'button') {
          await pressEnter(entry);
          how = 'enter';
        } else {
          how = await clickSend(entry);
        }
        result = await verifySent(entry, text);
      }

      const fresh = watcher.stop();
      if (process.env.LIVEHUB_SENDER_DEBUG) console.log('[sender] 发送期间新出现的提示:', JSON.stringify(fresh.slice(-20)));

      // 为了聚焦临时显示过的窗口，发完就藏回去
      if (!entry.win.isDestroyed() && entry.win.isVisible()) entry.win.hide();
      // 页面里亲眼看到文本 → 直接算成功
      if (result.ok && conf.pageEcho !== false) {
        lastSuccessAt = Date.now();
        return { ok: true, platform, roomId: String(roomId), content: text, via: how, verifiedBy: 'page' };
      }
      if (result.cleared) {
        // 页面里没看到不等于没发出去：先问本地服务有没有收到平台回推
        const echo = await checkEcho(platform, roomId, text);
        if (echo === true) {
          lastSuccessAt = Date.now();
          return { ok: true, platform, roomId: String(roomId), content: text, via: how, verifiedBy: 'echo' };
        }
        if (echo === null) {
          // 没有本地弹幕流可查（没进房间/没连上），不敢下结论，如实说明
          return {
            ok: false,
            code: 'unconfirmed',
            error: `${conf.name}没有返回接收确认，无法判断是否发出去；确认在直播间里能看到再说`,
          };
        }
        // 明确没进直播间：先看有没有新增的「门槛」提示，没有就按最可能的原因告知
        const block = detectNewRestriction(fresh);
        if (block) return restrictedResult(conf, block);

        // 页面什么都没说（斗鱼是静默丢弃）：先看房间设置，能给出确切门槛
        const byRule = ruleRestriction(await readRoomRules(entry, roomId));
        if (byRule) return restrictedResult(conf, byRule);

        // 设置里也没有限制 → 按最近是否发成功过来取舍：
        // 最近刚发成功过 → 更像频率限制；很久没成功 → 更像这个房间不让你发。
        const recentlyOk = Date.now() - lastSuccessAt < 60_000;
        return {
          ok: false,
          code: recentlyOk ? 'rejected' : 'restricted',
          reason: 'unknown',
          error: recentlyOk
            ? `${conf.name}没有接收这条弹幕，可能是发得太快了，稍等几秒再试`
            : `这条弹幕没有出现在直播间，${conf.name}也没给原因：这个房间很可能限制了发言（粉丝牌/等级/关注/禁言之一），换个房间就能发`,
        };
      }

      // 内容还留在输入框：先看是不是门槛提示，再退回通用失败
      const block = detectNewRestriction(fresh);
      if (block) return restrictedResult(conf, block);

      const diag = await diagnose(entry);
      return {
        ok: false,
        error: diag?.disabled
          ? `${conf.name}的发送按钮是禁用状态：可能是登录已失效，或这个房间不允许你发言`
          : `${conf.name}发送失败：内容还留在输入框里，可能是登录已失效或被平台限制`,
        code: 'not_sent',
      };
    } catch (err) {
      return { ok: false, error: err.message, code: err.sendCode || 'error' };
    } finally {
      // 为了聚焦/渲染临时显示过的窗口，不管成没成功都藏回去
      if (!entry.win.isDestroyed() && entry.win.isVisible()) entry.win.hide();
    }
  };

  // 串行化
  const task = entry.chain.then(run, run);
  entry.chain = task.catch(() => {});
  return task;
}

/**
 * 第二判据：问本地服务「这个房间的弹幕流里有没有出现这条」。
 * 斗鱼不把回显写进页面 DOM（body.innerText 里查不到），但平台会回推，
 * 用户发弹幕时正开着这个房间，流是现成的，所以这条最可靠。
 */
async function checkEcho(platform, roomId, content) {
  // 返回三态：true 收到回显 / false 确认没收到 / null 判断不了（本地弹幕流没连上）
  if (!serverPort) return null;
  const query = new URLSearchParams({ platform, room: String(roomId), content, since: '45000' });
  for (let i = 0; i < 4; i++) {
    await sleep(1200);
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/danmaku/echo?${query}`);
      if (!res.ok) return null;
      const data = await res.json();
      // known=false：这个房间没有活跃弹幕流（用户没进房/刚打开），结论不可用
      if (data.known === false) return null;
      if (data.seen) return true;
    } catch {
      return null;
    }
  }
  return false;
}

/**
 * 失败时收集现场信息：发送按钮是否被禁用、页面上有没有说明。
 * 「点了没反应」最常见的原因是按钮还处于 disable 态（未登录/发言受限/内容没被识别）。
 */
async function diagnose(entry) {
  const { win, conf } = entry;
  return win.webContents
    .executeJavaScript(`(() => {
      const sels = ${JSON.stringify(conf.sendButtons)};
      let disabled = null;
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '');
        disabled = /disabl/i.test(cls) || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true';
        break;
      }
      return { disabled };
    })()`)
    .catch(() => ({ disabled: null }));
}

function failureText(conf, diag, tip, fallback) {
  const hint = diag?.disabled ? '发送按钮处于禁用状态（未登录或该房间限制发言）' : '';
  return [tip, hint].filter(Boolean).join('；') || fallback;
}

/**
 * 发言门槛：把平台给的文案归成几类。
 * 平台说辞五花八门（粉丝团/粉丝牌/灯牌/等级不足/关注主播/禁言…），
 * 直接抛原文用户看不懂，归类后前端才能说一句人话。
 */
const RESTRICTIONS = [
  { reason: 'muted', re: /禁言|禁止发言|已被禁|封禁|小黑屋/, label: '你在这个直播间被禁言了' },
  { reason: 'fans_badge', re: /粉丝团|粉丝牌|粉丝等级|亲密度|灯牌|加入粉丝/, label: '这个直播间只有粉丝团成员能发言（需要粉丝牌）' },
  { reason: 'level', re: /等级不足|等级不够|达到\s*\d+\s*级|用户等级|荣誉等级|等级限制/, label: '这个直播间对发言有等级要求，你的等级不够' },
  { reason: 'follow', re: /关注主播|关注后才能|先关注|关注了?才/, label: '这个直播间要求先关注主播才能发言' },
  { reason: 'phone', re: /绑定手机|绑定帐号|手机号|实名认证/, label: '需要先绑定手机号才能发言' },
  { reason: 'permission', re: /无权发言|没有发言权限|发言权限|仅限.{0,6}(成员|用户)|开通.{0,6}(守护|贵族)|会员专属/, label: '这个直播间限制了发言权限' },
];

/**
 * 必须是「规则口吻」的句子才算门槛说明。
 * 页面上到处是「粉丝团」「亲密度」这类活动横幅，光靠名词会把横幅当成拒收原因
 * （实测抓到过「2倍亲密度+4倍亲密度上限」这种）。
 */
const RULE_HINT = /发言|说话|评论|聊天|加入|才能|需要|权限|禁止|限制|不允许|无法/;

/** 从一组文案里匹配门槛类型 */
function matchRestriction(texts) {
  for (const text of texts) {
    if (!RULE_HINT.test(text)) continue;
    for (const rule of RESTRICTIONS) {
      if (rule.re.test(text)) return { reason: rule.reason, label: rule.label, text };
    }
  }
  return null;
}

/**
 * 发送前：只看输入区自己的状态。
 * 这类提示是常驻的（「关注主播后可发言」「加入粉丝团」），比 toast 稳定。
 */
async function detectInputRestriction(entry) {
  const { win, conf } = entry;
  const state = await win.webContents
    .executeJavaScript(`(() => {
      const input = document.querySelector(${JSON.stringify(conf.input)});
      if (!input) return { texts: [], disabled: false };
      const box = input.closest('div') ? input.parentElement.parentElement : null;
      const texts = [];
      const ph = input.getAttribute('data-placeholder') || input.placeholder || '';
      if (ph) texts.push(ph);
      // 输入框周围一圈（两级容器）里的短文案，通常是「关注后可发言」这类提示
      if (box) {
        for (const el of box.querySelectorAll('span,div,p,a')) {
          if (el.children.length) continue;
          const t = (el.textContent || '').trim();
          if (t && t.length <= 40) texts.push(t);
        }
      }
      const readonly = input.getAttribute('contenteditable') === 'false' || input.readOnly === true || input.disabled === true;
      return { texts, disabled: readonly };
    })()`)
    .catch(() => ({ texts: [], disabled: false }));

  const hit = matchRestriction(state.texts);
  if (!hit) return null;
  // 只有两种情况下「发送前就判死」：输入框本身就是禁用态，
  // 或者提示里明确带「发言/评论」这类动作词。
  // 否则页面上随便一个「粉丝团」标签就会把正常房间误判成不能发。
  if (state.disabled || RULE_HINT.test(hit.text || '')) return hit;
  return null;
}

/**
 * 房间的发言设置（斗鱼）：页面静默丢弃时，用它给出确切原因。
 * betard 里 is_set_fans_badge=1 表示该房设了粉丝牌门槛，speakSet 里还有等级/仅管理员等限制。
 * 只作「事后解释」，不拿它提前拦截——避免字段含义变动时把能发的房间误判成不能发。
 */
async function readRoomRules(entry, roomId) {
  if (entry.platform !== 'douyu') return null;
  return entry.win.webContents
    .executeJavaScript(`(async () => {
      try {
        const res = await fetch('/betard/' + ${JSON.stringify(String(roomId))}, { credentials: 'include' });
        if (!res.ok) return null;
        const json = await res.json();
        const room = json.room || {};
        const speak = room.speakSet || {};
        return {
          fansBadge: Number(room.is_set_fans_badge) === 1,
          speakLimit: Number(speak.speaklimit) || 0,
          speakLv: Number(speak.speakLv) || 0,
          onlyAdmin: Boolean(speak.onlyAdmin),
        };
      } catch (e) {
        return null;
      }
    })()`)
    .catch(() => null);
}

/** 把房间设置翻成人话；没有可用的设置信息时返回 null */
function ruleRestriction(rules) {
  if (!rules) return null;
  if (rules.onlyAdmin) {
    return { reason: 'permission', label: '这个直播间只有管理员能发言', text: '' };
  }
  if (rules.speakLimit > 0) {
    const lv = rules.speakLv ? `（需要达到 ${rules.speakLv} 级）` : '';
    return { reason: 'level', label: `这个直播间要求粉丝等级才能发言${lv}`, text: '' };
  }
  if (rules.fansBadge) {
    return { reason: 'fans_badge', label: '这个直播间需要加入粉丝团（粉丝牌）才能发言', text: '' };
  }
  return null;
}

/** 收集页面上正在显示的短文案，用来做「发送前后 diff」 */
async function collectNotices(entry) {
  return entry.win.webContents
    .executeJavaScript(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('div,span,p')) {
        if (el.children.length) continue;
        const t = (el.textContent || '').trim();
        if (t && t.length <= 40) out.push(t);
      }
      return [...new Set(out)];
    })()`)
    .catch(() => []);
}

/**
 * 发送期间盯着页面：toast 只闪一两秒，等发完再快照就错过了。
 * 每 250ms 收一次短文案，攒出「发送前没有、发送后出现过」的那些。
 */
function watchNotices(entry, before) {
  const seen = [];
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const now = await collectNotices(entry);
    for (const text of now) {
      if (!before.includes(text) && !seen.includes(text)) seen.push(text);
    }
    if (!stopped) setTimeout(tick, 250);
  };
  setTimeout(tick, 250);
  return {
    stop() {
      stopped = true;
      return seen;
    },
  };
}

/** 从「发送期间新出现」的文案里找门槛；找不到返回 null */
function detectNewRestriction(fresh) {
  return matchRestriction(fresh || []);
}

/** 发送按钮是否被禁用 */
async function diagnose(entry) {
  const { win, conf } = entry;
  return win.webContents
    .executeJavaScript(`(() => {
      const sels = ${JSON.stringify(conf.sendButtons)};
      let disabled = null;
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '');
        disabled = /disabl/i.test(cls) || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true';
        break;
      }
      return { disabled };
    })()`)
    .catch(() => ({ disabled: null }));
}

/** 统一的失败信息：把「门槛类型」说清楚，再附上平台原文 */
function restrictedResult(conf, hit) {
  const detail = hit.text && hit.text !== hit.label ? `（平台提示：${hit.text}）` : '';
  return {
    ok: false,
    code: 'restricted',
    reason: hit.reason,
    error: `你在本直播间无法发送弹幕：${hit.label}${detail}`,
  };
}

function closeAllSenders() {
  for (const entry of senders.values()) {
    try {
      if (!entry.win.isDestroyed()) entry.win.destroy();
    } catch {
      /* ignore */
    }
  }
  senders.clear();
}

function registerSenderIpc() {
  ipcMain.handle('livehub:danmaku-send', (_event, payload) => sendDanmaku(payload || {}));
}

module.exports = {
  sendDanmaku,
  closeAllSenders,
  registerSenderIpc,
  setServerPort,
  setCookieSource,
  PLATFORMS,
};
