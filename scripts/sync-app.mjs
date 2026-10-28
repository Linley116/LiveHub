#!/usr/bin/env node
// 把源码改动同步进已经打好的 dist/mac-arm64/LiveHub.app。
//
// 为什么要这个脚本：electron-builder 打包时会把源码复制进 .app，之后改源码
// 不会影响已经打好的 app。重新跑一次 npm run dist 当然可以，但那要重新下载和
// 解压 Electron（几分钟），而日常改的只是 .js 文件。这里直接替换同名文件，
// 再补一次 ad-hoc 签名（改了 Resources 会破坏签名密封，不重签会起不来）。
//
// 用法：npm run sync:app        （加 --diff 只看差异不写入）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appBundle = path.join(root, 'dist', 'mac-arm64', 'LiveHub.app');
const appRoot = path.join(appBundle, 'Contents', 'Resources', 'app');

// 源码里需要同步的内容（node_modules 用打包时的那份，不动）
const SYNC_DIRS = ['desktop', 'server', 'seed', 'web'];
const SYNC_FILES = ['package.json'];
const SKIP_NAMES = new Set(['node_modules', '.DS_Store']);

const dryRun = process.argv.includes('--diff');

function sha(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

if (!fs.existsSync(appBundle)) {
  console.error(`找不到打包产物：${appBundle}`);
  console.error('请先执行一次 npm run dist 生成 dist/mac-arm64/LiveHub.app');
  process.exit(1);
}

const changed = [];
const same = [];

for (const dir of SYNC_DIRS) {
  for (const rel of walk(path.join(root, dir))) {
    const src = path.join(root, dir, rel);
    const dst = path.join(appRoot, dir, rel);
    if (!fs.existsSync(dst)) {
      changed.push({ rel: `${dir}/${rel}`, kind: '新增' });
      continue;
    }
    if (sha(src) === sha(dst)) {
      same.push(`${dir}/${rel}`);
      continue;
    }
    changed.push({ rel: `${dir}/${rel}`, kind: '修改' });
  }
}

for (const rel of SYNC_FILES) {
  const src = path.join(root, rel);
  const dst = path.join(appRoot, rel);
  if (fs.existsSync(src) && fs.existsSync(dst) && sha(src) !== sha(dst)) {
    changed.push({ rel, kind: '修改' });
  }
}

const total = changed.length + same.length;
if (!changed.length) {
  console.log(`✓ app 已是最新（比对 ${total} 个文件，无差异），不用同步`);
  process.exit(0);
}

console.log(`发现 ${changed.length} 个文件待同步（另有 ${same.length} 个未变）：`);
for (const item of changed) console.log(`  ${item.kind}  ${item.rel}`);

if (dryRun) {
  console.log('\n（--diff 模式，未写入）');
  process.exit(0);
}

// 先备份被覆盖的文件，出问题能一键还原
const backupDir = path.join('/tmp', `livehub-app-backup-${Date.now()}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const item of changed) {
  const dst = path.join(appRoot, item.rel);
  if (!fs.existsSync(dst)) continue;
  const target = path.join(backupDir, item.rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(dst, target);
}
console.log(`\n已备份旧文件到 ${backupDir}`);

for (const item of changed) {
  const src = path.join(root, item.rel);
  const dst = path.join(appRoot, item.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
console.log('已写入 app');

// 改过 Resources 里的文件会破坏代码签名密封，必须重签，否则 app 起不来
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appBundle], {
    stdio: 'pipe',
  });
  execFileSync('codesign', ['-v', appBundle], { stdio: 'pipe' });
  console.log('✓ 已重新签名并校验通过');
} catch (err) {
  console.error('✗ 重新签名失败：', String(err.stderr || err.message).trim().slice(0, 300));
  console.error(`  可用备份还原：${backupDir}`);
  process.exit(1);
}

console.log(`\n✓ 完成，运行 open ${appBundle} 验证`);
