// 会话准入策略：把「谁能和这个 agent 说话」收成一个纯函数。
//
// 为什么单独抽一层：原桥接里准入判断散在 10k 行的 `bridge.js` 里（`handleIncoming` 的几个
// if），于是「某个群为什么没反应」只能靠翻日志猜。这里把判断顺序固定下来，并让每次拒绝都
// 带一个**可读的原因 + 机器可判的 reasonCode**，这样既能写进启动日志，也能被控制台展示。
//
// 判定顺序（顺序本身就是安全语义，不要重排）：
//
//   1. **黑名单优先**：deny.private / deny.groups 命中即拒，任何"自动通过/自动补白名单"都不得绕过。
//   2. **closed-agent 只认管理员私聊**：这条模式把完整工具面交给模型，所以只有 ownerQQ 的私聊放行。
//      owner 缺失时一律拒绝（fail-closed）——"忘了配管理员"不能等于"对所有人开放"。
//   3. **管理员私聊恒放行**（非 closed-agent 模式）：不然操作者把自己关在门外。
//   4. **白名单**：私聊看 allow.private，群聊看 allow.groups。
//   5. **空白名单**：`allowAllWhenEmpty` 为 true 时才放行全部；默认 true 是为了"装上就能用"，
//      但这是把账号控制权交出去的那一步，README 里明确写了建议先填白名单再开。
//
// 本模块只做判断，不读文件、不发消息、不改配置。

/** 默认配置片段（与 qq-bridge 的 config.example.json 同构）。 */
export const POLICY_DEFAULTS = Object.freeze({
  allowAllWhenEmpty: true,
  allow: { private: [], groups: [] },
  deny: { private: [], groups: [] }
});

/** 判断/拒绝原因代码。日志与测试都引用它，别直接比字符串。 */
export const REASON = Object.freeze({
  DENIED: 'denied',
  OWNER_REQUIRED: 'owner-required',
  OWNER_MISSING: 'owner-missing',
  OWNER_OK: 'owner-ok',
  ALLOWED: 'allowed',
  EMPTY_ALLOW_ALL: 'empty-allow-all',
  NOT_IN_ALLOW: 'not-in-allow',
  INVALID_ID: 'invalid-id'
});

/** 读取一组 id 列表，兼容单复数键名，去重且只保留正整数。 */
export function readIdList(bag, kind) {
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return [];
  const keys = kind === 'groups' ? ['groups', 'group'] : ['private', 'privates'];
  const out = [];
  for (const key of keys) {
    const list = bag[key];
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const s = String(value ?? '').trim();
      if (!/^\d+$/.test(s) || Number(s) <= 0) continue;
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** 配置规范化：把缺省、脏写、单复数都收成一套稳定结构。 */
export function normalizePolicyConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allowAllWhenEmpty = typeof src.allowAllWhenEmpty === 'boolean' ? src.allowAllWhenEmpty : POLICY_DEFAULTS.allowAllWhenEmpty;
  const ownerQQ = String(src.ownerQQ ?? '').trim();
  return {
    allowAllWhenEmpty,
    ownerQQ: /^\d+$/.test(ownerQQ) && Number(ownerQQ) > 0 ? ownerQQ : null,
    allow: {
      private: readIdList(src.allow, 'private'),
      groups: readIdList(src.allow, 'groups')
    },
    deny: {
      private: readIdList(src.deny, 'private'),
      groups: readIdList(src.deny, 'groups')
    }
  };
}

/** 该 id 是否在黑名单里（黑名单永远压过白名单与自动通过）。 */
export function isDenied(cfg, kind, id) {
  const bag = kind === 'groups' ? cfg.deny.groups : cfg.deny.private;
  return bag.includes(String(id ?? '').trim());
}

/**
 * 私聊准入。
 * @param {object} args
 * @param {object} args.cfg  normalizePolicyConfig() 的结果
 * @param {string|number} args.userId 发送者 QQ
 * @param {string} [args.mode] 运行模式（closed-agent / chat / reserved / reserved2）
 * @returns {{allow:boolean, reasonCode:string, reason:string}}
 */
export function admitPrivate({ cfg, userId, mode = 'chat' } = {}) {
  const policy = normalizePolicyConfig(cfg);
  const id = String(userId ?? '').trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    return { allow: false, reasonCode: REASON.INVALID_ID, reason: `QQ 号无效（收到 "${id}"）` };
  }
  if (isDenied(policy, 'private', id)) {
    return { allow: false, reasonCode: REASON.DENIED, reason: '在 deny.private 黑名单里' };
  }
  if (mode === 'closed-agent') {
    if (!policy.ownerQQ) {
      return { allow: false, reasonCode: REASON.OWNER_MISSING, reason: 'closed-agent 模式没配管理员 ownerQQ：fail-closed' };
    }
    return id === policy.ownerQQ
      ? { allow: true, reasonCode: REASON.OWNER_OK, reason: '管理员私聊（closed-agent 唯一入口）' }
      : { allow: false, reasonCode: REASON.OWNER_REQUIRED, reason: `closed-agent 只认管理员私聊（ownerQQ=${policy.ownerQQ}）` };
  }
  if (policy.ownerQQ && id === policy.ownerQQ) {
    return { allow: true, reasonCode: REASON.OWNER_OK, reason: '管理员私聊' };
  }
  if (policy.allow.private.includes(id)) {
    return { allow: true, reasonCode: REASON.ALLOWED, reason: '在 allow.private 白名单里' };
  }
  if (!policy.allow.private.length && policy.allowAllWhenEmpty) {
    return {
      allow: true,
      reasonCode: REASON.EMPTY_ALLOW_ALL,
      reason: '白名单为空且 allowAllWhenEmpty=true：放行全部私聊（建议先填白名单）'
    };
  }
  return { allow: false, reasonCode: REASON.NOT_IN_ALLOW, reason: '不在 allow.private 白名单里' };
}

/**
 * 群聊准入。
 * 群里每个成员都会触发消息事件，所以群聊只按**群号**判；成员级权限不在这里做。
 */
export function admitGroup({ cfg, groupId } = {}) {
  const policy = normalizePolicyConfig(cfg);
  const id = String(groupId ?? '').trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    return { allow: false, reasonCode: REASON.INVALID_ID, reason: `群号无效（收到 "${id}"）` };
  }
  if (isDenied(policy, 'groups', id)) {
    return { allow: false, reasonCode: REASON.DENIED, reason: '在 deny.groups 黑名单里' };
  }
  if (policy.allow.groups.includes(id)) {
    return { allow: true, reasonCode: REASON.ALLOWED, reason: '在 allow.groups 白名单里' };
  }
  if (!policy.allow.groups.length && policy.allowAllWhenEmpty) {
    return {
      allow: true,
      reasonCode: REASON.EMPTY_ALLOW_ALL,
      reason: '群白名单为空且 allowAllWhenEmpty=true：放行全部群（建议先填白名单）'
    };
  }
  return { allow: false, reasonCode: REASON.NOT_IN_ALLOW, reason: '不在 allow.groups 白名单里' };
}

/** 一屏说明当前配置的准入面（启动日志 / CLI `explain` 用）。 */
export function explainPolicy(cfg) {
  const policy = normalizePolicyConfig(cfg);
  return [
    `模式开关：allowAllWhenEmpty=${policy.allowAllWhenEmpty}`,
    `管理员：${policy.ownerQQ ?? '（未配置；closed-agent 模式下会拒绝所有人）'}`,
    `私聊白名单 ${policy.allow.private.length} 个：${policy.allow.private.join(', ') || '（空）'}`,
    `群白名单 ${policy.allow.groups.length} 个：${policy.allow.groups.join(', ') || '（空）'}`,
    `私聊黑名单 ${policy.deny.private.length} 个；群黑名单 ${policy.deny.groups.length} 个`
  ].join('\n');
}
