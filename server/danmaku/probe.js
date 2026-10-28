// 弹幕连通性探针：node server/danmaku/probe.js <platform> <roomId> [秒数]
import { CONNECTORS } from './hub.js';

const [platform, roomId, seconds] = process.argv.slice(2);
const connector = CONNECTORS[platform];

if (!connector) {
  console.error(`未知平台：${platform}，可选 ${Object.keys(CONNECTORS).join(' / ')}`);
  process.exit(1);
}

let count = 0;
const limit = (Number(seconds) || 15) * 1000;
const startedAt = Date.now();

console.log(`[probe] ${platform} room=${roomId} 最长 ${limit / 1000}s`);

const handle = await connector.connect({
  roomId,
  onStatus: (state, message) => console.log(`[status] ${state} ${message || ''}`),
  onMessage: (msg) => {
    count += 1;
    if (count <= 8) console.log(`[msg ${count}]`, JSON.stringify(msg));
  },
  onClose: (err) => console.log('[close]', err?.message || '连接结束'),
});

setTimeout(() => {
  console.log(`[probe] 收到 ${count} 条 / ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  handle?.close?.();
  process.exit(count > 0 ? 0 : 2);
}, limit);
