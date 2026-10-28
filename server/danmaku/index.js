// 弹幕模块入口：对外只暴露「订阅」「状态查询」「发送」与「回查回显」。
export {
  CONNECTORS,
  subscribe,
  getDanmakuStatus,
  ingestDanmaku,
  sendDanmaku,
  findEcho,
  DANMAKU_MAX_LENGTH,
} from './hub.js';
