// 影子窗口 preload：在原页面里钩住 XHR / fetch，把 /webcast/im/fetch/ 的响应体
// 增量复制一份，通过 postMessage 交给隔离世界，再用 IPC 发给主进程。
//
// 注意：抖音的弹幕长轮询走的是 XMLHttpRequest（responseType=arraybuffer），
// 不是在 fetch 上，所以两套都要钩。
const { ipcRenderer, webFrame } = require('electron');

const roomArg = process.argv.find((arg) => arg.startsWith('--livehub-room='));
const roomId = roomArg ? roomArg.slice('--livehub-room='.length) : '';

const HOOK = `(() => {
  if (window.__livehubDanmakuHooked) return;
  window.__livehubDanmakuHooked = true;
  const MATCH = '/webcast/im/fetch/';

  const emit = (bytes) => {
    if (!bytes || !bytes.length) return;
    let binary = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    window.postMessage({ __livehub: 'chunk', b64: btoa(binary) }, '*');
  };

  // XHR：arraybuffer 类型的 progress 事件里 response 是「累计」数据，按 offset 取增量
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__livehubUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__livehubUrl || '';
    if (url.includes(MATCH)) {
      let sent = 0;
      const flush = () => {
        try {
          const buf = this.response;
          if (buf instanceof ArrayBuffer) {
            if (buf.byteLength > sent) {
              emit(new Uint8Array(buf.slice(sent)));
              sent = buf.byteLength;
            }
          } else if (typeof buf === 'string' && buf.length > sent) {
            emit(new TextEncoder().encode(buf.slice(sent)));
            sent = buf.length;
          }
        } catch (err) {
          /* 读不到就跳过这一帧 */
        }
      };
      this.addEventListener('progress', flush);
      this.addEventListener('readystatechange', () => {
        if (this.readyState >= 3) flush();
        if (this.readyState === 4 && this.response instanceof Blob) {
          this.response.arrayBuffer().then((b) => emit(new Uint8Array(b))).catch(() => {});
        }
      });
    }
    return origSend.apply(this, args);
  };

  // fetch：保留一份，兼容页面切回 fetch 的情况
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = origFetch.apply(this, args);
      if (!url.includes(MATCH)) return promise;
      return promise.then((res) => {
        try {
          const clone = res.clone();
          if (clone.body) {
            const reader = clone.body.getReader();
            (async () => {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                emit(value);
              }
            })().catch(() => {});
          }
        } catch (err) {
          /* ignore */
        }
        return res;
      });
    };
  }
})();`;

webFrame.executeJavaScript(HOOK).catch(() => {});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.__livehub !== 'chunk' || !data.b64) return;
  ipcRenderer.send('livehub:danmaku-chunk', { roomId, b64: data.b64 });
});
