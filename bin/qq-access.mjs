#!/usr/bin/env node
// qq-access CLI：不连 QQ、不连 DSH，只拿配置回答「这个号/这个群能不能进来」。
//
//   qq-access explain  --config config.json
//   qq-access check    private 123456 --config config.json [--mode closed-agent]
//   qq-access check    group   987654 --config config.json
//   qq-access friend   --event event.json --config config.json
//   qq-access init     --out config.json
//
// 退出码：0 = 放行，1 = 拒绝，2 = 用法错误。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitGroup, admitPrivate, explainPolicy, normalizePolicyConfig } from '../src/policy.mjs';
import { decideFriendRequest, normalizeFriendRequestConfig } from '../src/friend-request.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) args._.push(t);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) args[t.slice(2)] = true;
    else {
      args[t.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function readJson(file) {
  const p = String(file);
  if (!fs.existsSync(p)) {
    const error = new Error(`找不到配置文件：${p}`);
    error.code = 'ENOENT_CONFIG';
    throw error;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadCfg(args) {
  if (!args.config) return {};
  return readJson(args.config);
}

const example = {
  ownerQQ: '10001',
  allowAllWhenEmpty: false,
  allow: { private: ['20002'], groups: ['30003'] },
  deny: { private: [], groups: [] },
  friendRequest: {
    enabled: true,
    autoApprove: true,
    autoWhitelist: true,
    autoApproveDoubt: true,
    autoWhitelistOnFirstMessage: true,
    sweepIntervalMs: 300000
  }
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === 'init') {
    const out = String(args.out ?? 'config.json');
    if (fs.existsSync(out) && !args.force) {
      console.error(`${out} 已存在（加 --force 覆盖）`);
      return 2;
    }
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(example, null, 2)}\n`, 'utf8');
    console.log(`已写入 ${out}`);
    return 0;
  }

  if (cmd === 'explain') {
    console.log(explainPolicy(loadCfg(args)));
    return 0;
  }

  if (cmd === 'check') {
    const kind = String(args._[1] ?? '');
    const id = String(args._[2] ?? '');
    if (!id) {
      console.error('用法：qq-access check private|group <id> --config config.json');
      return 2;
    }
    const cfg = loadCfg(args);
    const verdict =
      kind === 'group'
        ? admitGroup({ cfg, groupId: id })
        : kind === 'private'
          ? admitPrivate({ cfg, userId: id, mode: String(args.mode ?? 'chat') })
          : null;
    if (!verdict) {
      console.error('kind 只能是 private 或 group');
      return 2;
    }
    console.log(`${verdict.allow ? '✅ 放行' : '⛔ 拒绝'} ${kind} ${id} — ${verdict.reason}（${verdict.reasonCode}）`);
    return verdict.allow ? 0 : 1;
  }

  if (cmd === 'friend') {
    const cfg = loadCfg(args);
    const event = args.event ? readJson(args.event) : null;
    if (!event) {
      console.error('用法：qq-access friend --event event.json [--config config.json]');
      return 2;
    }
    const verdict = decideFriendRequest({ event, cfg, selfId: cfg.ownerQQ });
    console.log(`${verdict.action.toUpperCase()} — ${verdict.reason}`);
    if (verdict.userId) console.log(`  QQ：${verdict.userId}`);
    console.log(`  生效配置：${JSON.stringify(normalizeFriendRequestConfig(cfg.friendRequest))}`);
    return verdict.action === 'reject' ? 1 : 0;
  }

  if (cmd === 'json') {
    // 给自动化用：把判断结果打成 JSON（含规范化后的策略）
    const cfg = loadCfg(args);
    const kind = String(args._[1] ?? 'private');
    const id = String(args._[2] ?? '');
    const verdict = kind === 'group' ? admitGroup({ cfg, groupId: id }) : admitPrivate({ cfg, userId: id, mode: String(args.mode ?? 'chat') });
    console.log(JSON.stringify({ kind, id, verdict, policy: normalizePolicyConfig(cfg) }, null, 2));
    return verdict.allow ? 0 : 1;
  }

  console.error(
    [
      '用法：',
      '  qq-access explain  [--config config.json]',
      '  qq-access check private|group <id> [--config config.json] [--mode closed-agent]',
      '  qq-access friend   --event event.json [--config config.json]',
      '  qq-access json     private|group <id> [--config config.json]',
      '  qq-access init     [--out config.json] [--force]',
      '',
      `（也可作为库引用：${pathToFileURL(new URL('../src/policy.mjs', import.meta.url).pathname).href}）`
    ].join('\n')
  );
  return 2;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error?.code === 'ENOENT_CONFIG') {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
