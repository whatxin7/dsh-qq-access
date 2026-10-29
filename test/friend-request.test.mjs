import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRIEND_REQUEST_DEFAULTS,
  decideDoubtRequest,
  decideFriendRequest,
  isPlaceholderFlag,
  isValidQq,
  normalizeFriendRequestConfig,
  shouldAdoptFriendOnFirstMessage,
  withPrivateAllowed
} from '../src/friend-request.js';

const event = (over = {}) => ({ post_type: 'request', request_type: 'friend', user_id: 20002, flag: 'u___aiPDnHuZofoHSjpZdWiQ', comment: '我是H.', ...over });

test('isValidQq / isPlaceholderFlag：只认正整数 QQ，全零 flag 视为无凭据', () => {
  assert.equal(isValidQq('12345'), true);
  assert.equal(isValidQq('0'), false);
  assert.equal(isValidQq(''), false);
  assert.equal(isPlaceholderFlag('u___aiPDnHuZofoHSjpZdWiQ'), false);
  assert.equal(isPlaceholderFlag('000000000000'), true);
  assert.equal(isPlaceholderFlag(''), true);
});

test('normalizeFriendRequestConfig：只认显式 boolean，轮询间隔有下限', () => {
  const c = normalizeFriendRequestConfig({ autoApprove: 'yes', sweepIntervalMs: 1000 });
  assert.equal(c.autoApprove, FRIEND_REQUEST_DEFAULTS.autoApprove, '字符串不当真');
  assert.equal(c.sweepIntervalMs, 60000, '下限 60s');
});

test('好友申请：正常凭据自动通过', () => {
  const v = decideFriendRequest({ event: event(), cfg: {}, selfId: '10001' });
  assert.equal(v.action, 'approve');
  assert.equal(v.userId, '20002');
  assert.equal(v.uinUnknown, false);
});

test('好友申请：事件没带 QQ 号但 flag 可用时仍要通过（flag 才是回执凭据）', () => {
  const v = decideFriendRequest({ event: event({ user_id: 0 }), cfg: {}, selfId: '10001' });
  assert.equal(v.action, 'approve');
  assert.equal(v.uinUnknown, true);
});

test('好友申请：没有可用 flag 只能忽略（approve 发不出去）', () => {
  const v = decideFriendRequest({ event: event({ flag: '000000000000' }), cfg: {}, selfId: '10001' });
  assert.equal(v.action, 'ignore');
  assert.match(v.reason, /flag/);
});

test('好友申请：黑名单一律拒绝，且不因 autoApprove 被绕过', () => {
  const v = decideFriendRequest({ event: event(), cfg: { deny: { private: ['20002'] } }, selfId: '10001' });
  assert.equal(v.action, 'reject');
});

test('好友申请：自己回显、非好友申请事件都忽略', () => {
  assert.equal(decideFriendRequest({ event: event(), cfg: {}, selfId: '20002' }).action, 'ignore');
  assert.equal(decideFriendRequest({ event: event({ post_type: 'message' }), cfg: {} }).action, 'ignore');
  assert.equal(decideFriendRequest({ event: event({ request_type: 'group' }), cfg: {} }).action, 'ignore');
});

test('好友申请：总开关与自动通过都可以关掉，关掉后只记日志', () => {
  assert.equal(decideFriendRequest({ event: event(), cfg: { friendRequest: { enabled: false } } }).action, 'ignore');
  assert.equal(decideFriendRequest({ event: event(), cfg: { friendRequest: { autoApprove: false } } }).action, 'ignore');
});

test('可疑申请队列：有 uid 才处理，黑名单优先，开关可关', () => {
  assert.equal(decideDoubtRequest({ item: { uid: 'u-abc', user_id: 20002 }, cfg: {} }).action, 'approve');
  assert.equal(decideDoubtRequest({ item: { uid: '', user_id: 0 }, cfg: {} }).action, 'ignore');
  assert.equal(decideDoubtRequest({ item: { uid: 'u-abc', user_id: 20002 }, cfg: { deny: { private: ['20002'] } } }).action, 'reject');
  assert.equal(decideDoubtRequest({ item: { uid: 'u-abc', user_id: 20002 }, cfg: { friendRequest: { autoApproveDoubt: false } } }).action, 'ignore');
});

test('首次私聊补白名单：只对「确认是好友 + 私聊 + 非 closed-agent + 不在黑名单」生效', () => {
  const base = { kind: 'private', mode: 'chat', userId: '20002', cfg: {}, isFriend: true, selfId: '10001' };
  assert.equal(shouldAdoptFriendOnFirstMessage(base).adopt, true);
  assert.equal(shouldAdoptFriendOnFirstMessage({ ...base, isFriend: false }).adopt, false, '陌生人不能补');
  assert.equal(shouldAdoptFriendOnFirstMessage({ ...base, kind: 'group' }).adopt, false);
  assert.equal(shouldAdoptFriendOnFirstMessage({ ...base, mode: 'closed-agent' }).adopt, false);
  assert.equal(shouldAdoptFriendOnFirstMessage({ ...base, cfg: { deny: { private: ['20002'] } } }).adopt, false);
  assert.equal(shouldAdoptFriendOnFirstMessage({ ...base, userId: '10001' }).adopt, false, '自己不补');
  assert.equal(shouldAdoptFriendOnFirstMessage({ ...base, cfg: { friendRequest: { enabled: false } } }).adopt, false);
});

test('withPrivateAllowed：就地写入 allow.private，去重并清掉历史单数键', () => {
  const cfg = { allow: { private: [1], privates: [2] } };
  const first = withPrivateAllowed(cfg, '30003');
  assert.deepEqual(first.allow, [1, 2, 30003]);
  assert.equal(first.added, true);
  assert.equal('privates' in cfg.allow, false);

  const again = withPrivateAllowed(cfg, '30003');
  assert.equal(again.added, false);
  assert.throws(() => withPrivateAllowed(cfg, 'abc'), /QQ 号无效/);
});
