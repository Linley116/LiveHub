// 端到端验证：真实起本地服务 → 开影子窗口抓抖音直播间 → SSE 上数弹幕条数。
// 跑的是 main.cjs 用的同一份 shadow.cjs / shadow-preload.cjs，不复制实现。
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, session } = require('electron');
const shadow = require('./shadow.cjs');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ROOM = process.argv.slice(2).find((a) => /^\d+$/.test(a)) || '690510060377';
const WAIT_MS = Number(process.argv.find((a) => a.startsWith('--wait='))?.slice(7)) || 35_000;

function watchSse(base, roomId) {
  const got = [];
  const states = [];
  const ac = new AbortController();
  const started = fetch(`${base}/api/danmaku/stream?platform=douyin&room=${roomId}`, {
    signal: ac.signal,
  }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        if (part.startsWith('event: message')) got.push(JSON.parse(part.split('data: ')[1]));
        else if (part.startsWith('event: status')) {
          const s = JSON.parse(part.split('data: ')[1]);
          states.push(`${s.state}`);
          console.log(`  [状态] ${s.state} — ${s.message}`);
        }
      }
    }
  }).catch(() => {});
  return { got, states, stop: () => ac.abort(), started };
}

app.whenReady().then(async () => {
  session.fromPartition('persist:douyin').setUserAgent(UA);

  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href);
  const { port, server } = await mod.startServer({ port: 0 });
  console.log(`[e2e] 本地服务 127.0.0.1:${port} | 房间 ${ROOM}`);

  shadow.setServerPort(port);
  shadow.registerShadowIpc();

  const sse = watchSse(`http://127.0.0.1:${port}`, ROOM);
  // SSE 流不会自己结束，不能 await；订阅一个 round-trip 的时间就够注册了
  await new Promise((r) => setTimeout(r, 600));

  console.log('[e2e] 打开影子窗口…');
  const opened = shadow.openShadow(ROOM);
  console.log('[e2e] openShadow ->', JSON.stringify(opened));

  const marks = [];
  const t0 = Date.now();
  const tick = setInterval(() => {
    marks.push(`${Math.round((Date.now() - t0) / 1000)}s:${sse.got.length}`);
  }, 5000);

  setTimeout(async () => {
    clearInterval(tick);
    const live = shadow.getShadows();
    console.log('\n===== 结果 =====');
    console.log('影子窗口数:', live.size);
    console.log('累计曲线 :', marks.join('  '));
    console.log('弹幕总数 :', sse.got.length);
    const named = sse.got.filter((m) => m.user && m.user !== '匿名').length;
    console.log('带用户名 :', named);
    for (const m of sse.got.slice(0, 8)) console.log(`   ${m.user} | ${m.content.slice(0, 44)}`);
    if (sse.got.length > 8) {
      console.log('   … 最近一条:', sse.got[sse.got.length - 1].user, '|', sse.got[sse.got.length - 1].content.slice(0, 44));
    }
    // 关窗后应当停发，验证生命周期没有泄漏
    shadow.closeShadow(ROOM);
    const afterClose = sse.got.length;
    await new Promise((r) => setTimeout(r, 3000));
    console.log('关窗后新增:', sse.got.length - afterClose, '(应为 0)');
    console.log('关窗后窗口数:', shadow.getShadows().size, '(应为 0)');
    sse.stop();
    server.close();
    app.exit(0);
  }, WAIT_MS);
});
