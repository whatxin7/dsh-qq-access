// 好友申请策略：**只通过别人发来的好友验证，永不主动加人**。
//
// 操作者口径（原话）：「仅允许通过他人好友验证，不允许主动加他人；通过他人好友验证后
// 自动将其加入白名单」。后来又加了一条：「以后来的都能通过」。所以这里做四件事：
//   1. 只处理 `post_type=request` + `request_type=friend` 的事件（别人来加我们）；
//   2. 只要 `flag` 可用就**通过**（approve）——包括「事件里没带 QQ 号」的那种；
//   3. 通过之后把对方 QQ 写进 `allow.private`，否则对方的私聊会被白名单挡掉，等于白加；
//      事件里没带 QQ 号时由 bridge.js 用好友列表差分事后认领；
//   4. 黑名单（`deny.private`）里的号一律**拒绝**，不给白名单留后门。
//
// 两个容易踩的事实，别在重构时丢掉：
//   · OneBot v11 / SnowLuma 网关里**没有「主动加好友」这个 action**
//     （catalog 里只有 `set_friend_add_request` 处理申请、`delete_friend` 删好友、
//      `get_friend_list` 查好友等）。所以「不主动加」是结构上就成立的：
//      本模块不发任何加好友请求，桥接也从不把这类能力暴露给 AI。
//   · 2026-10-26 实测：网关在「解析不出对方 UIN」时会把 `user_id` 填 0，但 `flag` 里
//     仍然带着对方的 **UID**（SnowLuma 的 decodeFriendRequest 就是 `flag = sourceUid`）。
//     那时候旧逻辑会先按 `user_id` 判「没有有效 QQ 号」直接忽略，把一条本可以通过的
//     申请丢掉了（当天「我是H.」那条就是这样被吞的）。**flag 才是回执凭据，`user_id`
//     只是附加信息** —— 判据顺序不能反过来。
//
// 本文件只放纯逻辑（不碰 fs / 网络），方便 scripts/test-friend-request.mjs 直接测；
// 真正的 approve 调用与 config.json 落盘都在 bridge.js 里。

/** 三档开关的默认值：全自动通过 + 自动加白名单（操作者选的就是这个）。 */
export const FRIEND_REQUEST_DEFAULTS = Object.freeze({
  // 总开关：关掉后收到申请只记日志，既不通过也不拒绝（留给操作者在 QQ/手机端处理）。
  enabled: true,
  // 收到申请立刻 approve。关掉则只记日志（事件里的 flag 会过期，别指望以后再补）。
  autoApprove: true,
  // 通过后自动写 allow.private。
  autoWhitelist: true,
  // 「可疑好友申请」（QQ 风控拦下的那批，走 get_doubt_friends_add_request 读）是否也自动通过。
  // 操作者要求「以后来的都能通过」，所以默认开；关掉则退回到「只记录，等人工」。
  autoApproveDoubt: true,
  // 手动加的好友（好友申请被网关吞掉 / 操作者在手机端直接通过验证）**第一次发私聊**时，
  // 只要确认他确实在好友列表里，就自动补进 allow.private 并记一条日志。
  // 不加这条兜底，人成了好友却永远聊不上：私聊会被白名单挡在 handleIncoming 门口，
  // 日志里只剩一行「忽略未授权会话」（2026-10-26 的 H. 事故）。
  autoWhitelistOnFirstMessage: true
});

/** 配置规范化：只认显式 boolean，其它（字符串/数字/缺失）一律落回默认值。 */
export function normalizeFriendRequestConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const interval = Number(src.sweepIntervalMs);
  return {
    enabled: bool(src.enabled, FRIEND_REQUEST_DEFAULTS.enabled),
    autoApprove: bool(src.autoApprove, FRIEND_REQUEST_DEFAULTS.autoApprove),
    autoWhitelist: bool(src.autoWhitelist, FRIEND_REQUEST_DEFAULTS.autoWhitelist),
    autoApproveDoubt: bool(src.autoApproveDoubt, FRIEND_REQUEST_DEFAULTS.autoApproveDoubt),
    autoWhitelistOnFirstMessage: bool(src.autoWhitelistOnFirstMessage, FRIEND_REQUEST_DEFAULTS.autoWhitelistOnFirstMessage),
    // 可疑申请队列的轮询间隔：只在事件链路漏掉时兜底，不需要很勤。下限 60s。
    sweepIntervalMs: Number.isFinite(interval) ? Math.max(60000, Math.floor(interval)) : 300000
  };
}

/**
 * 读 allow/deny 里的某类 id 列表，兼容历史上的单复数写法：
 *   allow.private / allow.privates、allow.groups / allow.group
 * 两份都在时取并集（配置里手写残了也不会丢号），非法值丢弃。
 */
function readIdList(bag, kind) {
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return [];
  const raw = kind === 'groups'
    ? [bag.groups, bag.group]
    : [bag.private, bag.privates];
  const out = [];
  for (const list of raw) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const s = String(value ?? '').trim();
      if (!/^\d+$/.test(s)) continue;
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** 该 QQ 是否在黑名单里（黑名单永远优先于自动通过）。 */
export function isPrivateDenied(cfg, userId) {
  return readIdList(cfg?.deny, 'private').includes(String(userId ?? '').trim());
}

/** 合法 QQ 号（正整数）判断；事件里的 `user_id` 可能缺失、为 0 或非数字。 */
export function isValidQq(value) {
  const s = String(value ?? '').trim();
  return /^\d+$/.test(s) && Number(s) > 0;
}

/**
 * flag 是不是「空壳」。
 *
 * 真的 flag 长得像 `u___aiPDnHuZofoHSjpZdWiQ`（SnowLuma 给的是对方 UID）；
 * 网关解析失败时会给出 12 个 0 —— 那种打出去只会换来 `invalid uin: 0`，
 * 没必要浪费一次调用，直接记日志。
 */
export function isPlaceholderFlag(flag) {
  const s = String(flag ?? '').trim();
  return s === '' || /^0+$/.test(s);
}

/**
 * 决定一条好友申请怎么处理。
 *
 * @param {object} args
 * @param {object} args.event   OneBot 事件（post_type=request / request_type=friend）
 * @param {object} args.cfg     桥接配置（用 friendRequest / deny.private）
 * @param {string|number} [args.selfId] 自己的 QQ（= 事件里的 self_id），用于滤掉网关回显
 * @returns {{action:'approve'|'reject'|'ignore', reason:string, userId?:string, flag?:string,
 *            comment?:string, uinUnknown?:boolean}}
 */
export function decideFriendRequest({ event, cfg, selfId } = {}) {
  const requestType = String(event?.request_type ?? '');
  const postType = String(event?.post_type ?? '');
  if (postType !== 'request' || requestType !== 'friend') {
    return {
      action: 'ignore',
      reason: `不是好友申请（post_type=${postType || '空'} / request_type=${requestType || '空'}）`
    };
  }

  const rawUserId = String(event?.user_id ?? '').trim();
  const userId = isValidQq(rawUserId) ? rawUserId : '';
  const comment = typeof event?.comment === 'string' ? event.comment : '';
  const flag = String(event?.flag ?? '').trim();

  // 网关偶尔会把「自己」也回显成一包事件：自己加自己没有任何意义，忽略。
  if (userId && selfId !== undefined && selfId !== null && String(selfId) !== '' && userId === String(selfId)) {
    return { action: 'ignore', reason: '是自己（网关回显）', userId, comment };
  }
  // flag 才是回执凭据：没有它 approve 发不出去，只能记一笔（这通常是网关版本/解析问题）。
  if (isPlaceholderFlag(flag)) {
    return {
      action: 'ignore',
      reason: '事件缺少可用 flag（网关没给出对方 UID，approve 发不出去，只能手机端手动处理）',
      userId: userId || undefined,
      comment
    };
  }

  const conf = normalizeFriendRequestConfig(cfg?.friendRequest);
  if (!conf.enabled) {
    return { action: 'ignore', reason: '好友申请处理已关闭（friendRequest.enabled=false）', userId: userId || undefined, flag, comment };
  }
  // 只有知道 QQ 号时才判黑名单；不知道号的走 approve 后由 bridge.js 事后回滚。
  if (userId && isPrivateDenied(cfg, userId)) {
    return { action: 'reject', reason: '在黑名单 deny.private 里', userId, flag, comment };
  }
  if (!conf.autoApprove) {
    return {
      action: 'ignore',
      reason: '自动通过已关闭（friendRequest.autoApprove=false），请在手机/QQ 端手动处理',
      userId: userId || undefined, flag, comment
    };
  }
  return {
    action: 'approve',
    // 事件没带 QQ 号也照样通过：flag 里是对方 UID，approve 不需要 QQ 号。
    reason: userId ? '自动通过' : '自动通过（事件未带 QQ 号，用 flag 内的 UID 通过，随后按好友列表认领 QQ）',
    userId: userId || undefined,
    flag,
    comment,
    uinUnknown: !userId
  };
}

/**
 * 决定一条「可疑好友申请」（QQ 风控拦下的那批）怎么处理。
 *
 * 这批申请走的是 `get_doubt_friends_add_request` 读、`set_doubt_friends_add_request` 处理，
 * 和实时事件链路是两条路：事件里可能永远等不到它。字段形状：
 *   { uid, user_id, nick, source, reason, msg, group_code, reqTime }
 * 注意 `uid` 可能是空串（网关解析不出 UID 就是空），那种条目**通过和拒绝都发不出去**，
 * 只能报给操作者在手机端处理。
 *
 * @returns {{action:'approve'|'reject'|'ignore', reason:string, key?:string,
 *            userId?:string, uinUnknown?:boolean}}
 */
export function decideDoubtRequest({ item, cfg } = {}) {
  const conf = normalizeFriendRequestConfig(cfg?.friendRequest);
  const rawUserId = String(item?.user_id ?? '').trim();
  const userId = isValidQq(rawUserId) ? rawUserId : '';
  const uid = String(item?.uid ?? '').trim();
  const key = uid || userId;

  if (!conf.enabled) {
    return { action: 'ignore', reason: '好友申请处理已关闭（friendRequest.enabled=false）', key, userId: userId || undefined };
  }
  if (!key) {
    return {
      action: 'ignore',
      reason: '网关这条既没给 uid 也没给 QQ 号（通过/拒绝都发不出去），只能在手机/QQ 端手动处理',
      userId: userId || undefined
    };
  }
  if (userId && isPrivateDenied(cfg, userId)) {
    return { action: 'reject', reason: '在 blacklist deny.private 里', key, userId };
  }
  if (!conf.autoApproveDoubt) {
    return { action: 'ignore', reason: '可疑申请自动通过已关闭（friendRequest.autoApproveDoubt=false）', key, userId: userId || undefined };
  }
  return {
    action: 'approve',
    reason: '自动通过（可疑队列）',
    key,
    userId: userId || undefined,
    uinUnknown: !userId
  };
}

/**
 * 决定一条「未授权私聊」要不要当成「手动加的好友」补进白名单。
 *
 * 场景（2026-10-26 的 H. 事故）：好友申请被网关吞掉（事件里 user_id=0），或者操作者
 * 直接在手机/QQ 端通过了验证 —— 两条路都绕过了 bridge.js 的 approve + autoWhitelist。
 * 结果是：人在好友列表里，私聊却被白名单挡在 handleIncoming 门口，只留下一行
 * 「忽略未授权会话」，看起来就是「加上了但永远聊不上」。
 *
 * 判据刻意收窄（宁可漏补，不可错放）：
 *   · 只在非 closed-agent 模式、只在**私聊**上补（群聊一律不动）；
 *   · 对方必须在**当前好友列表**里（isFriend 由调用方查网关后传进来）——
 *     陌生人、临时会话、已经被删掉的好友都不补；
 *   · 黑名单 deny.private 优先，永不补；
 *   · 自己（网关回显）不补；
 *   · friendRequest.enabled / autoWhitelistOnFirstMessage 任一关掉就不补。
 *
 * **想永久挡掉某个好友：把他写进 deny.private**。从 allow.private 里删掉不算 ——
 * 他下一条私聊会被当成「手动加的好友」再补回来。
 *
 * @param {object} args
 * @param {'private'|'group'} args.kind  会话类型
 * @param {string} args.mode             当前桥接模式（closed-agent / chat / reserved / reserved2）
 * @param {string|number} args.userId    消息发送者 QQ
 * @param {object} args.cfg              桥接配置（用 friendRequest / deny.private）
 * @param {boolean} args.isFriend        调用方查网关好友列表的结果
 * @param {string|number} [args.selfId]  自己的 QQ（滤掉网关回显）
 * @returns {{adopt:boolean, reason:string, userId?:string}}
 */
export function shouldAdoptFriendOnFirstMessage({ kind, mode, userId, cfg, isFriend, selfId } = {}) {
  const raw = String(userId ?? '').trim();
  const qq = isValidQq(raw) ? raw : '';
  if (mode === 'closed-agent') return { adopt: false, reason: 'closed-agent 只认管理员私聊' };
  if (kind !== 'private') return { adopt: false, reason: '兜底只对私聊生效（群聊不受影响）' };
  if (!qq) return { adopt: false, reason: '事件里没有有效 QQ 号' };
  if (selfId !== undefined && selfId !== null && String(selfId) !== '' && qq === String(selfId)) {
    return { adopt: false, reason: '是自己（网关回显）', userId: qq };
  }
  const conf = normalizeFriendRequestConfig(cfg?.friendRequest);
  if (!conf.enabled) {
    return { adopt: false, reason: '好友申请处理已关闭（friendRequest.enabled=false）', userId: qq };
  }
  if (!conf.autoWhitelistOnFirstMessage) {
    return {
      adopt: false,
      reason: '首次私聊自动补白名单已关闭（friendRequest.autoWhitelistOnFirstMessage=false）',
      userId: qq
    };
  }
  if (isPrivateDenied(cfg, qq)) return { adopt: false, reason: '在黑名单 deny.private 里', userId: qq };
  if (isFriend !== true) return { adopt: false, reason: '不在好友列表里（陌生人/临时会话/已删好友）', userId: qq };
  return { adopt: true, reason: '是好友但不在白名单：首次私聊自动补进 allow.private', userId: qq };
}

/**
 * 把 QQ 加进 `cfgObject.allow.private`（就地改传入的 config.json 对象），返回结果。
 *
 * 写回时统一用复数键 `allow.private` 并删掉历史单数键，避免以后读配置时两份数据打架
 * （loadConfig 的兼容读法见 bridge.js 的 normalizeIdList 调用处）。
 *
 * @returns {{allow:number[], added:boolean}}
 */
export function withPrivateAllowed(cfgObject, userId) {
  const qq = String(userId ?? '').trim();
  if (!/^\d+$/.test(qq) || Number(qq) <= 0) throw new Error('QQ 号无效，拒绝写入白名单');
  const root = cfgObject && typeof cfgObject === 'object' && !Array.isArray(cfgObject) ? cfgObject : {};
  const bag = root.allow && typeof root.allow === 'object' && !Array.isArray(root.allow) ? root.allow : {};
  const current = readIdList(bag, 'private');
  const added = !current.includes(qq);
  const allow = (added ? [...current, qq] : current).map(Number);
  bag.private = allow;
  if (Object.prototype.hasOwnProperty.call(bag, 'privates')) delete bag.privates;
  root.allow = bag;
  return { allow, added };
}
