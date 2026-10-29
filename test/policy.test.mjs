import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REASON,
  admitGroup,
  admitPrivate,
  explainPolicy,
  normalizePolicyConfig,
  readIdList
} from '../src/policy.mjs';

const cfg = (over = {}) => normalizePolicyConfig({
  ownerQQ: '10001',
  allowAllWhenEmpty: false,
  allow: { private: ['20002'], groups: ['30003'] },
  deny: { private: ['40004'], groups: ['50005'] },
  ...over
});

test('readIdList：兼容单复数键名、去重、丢弃非法值', () => {
  assert.deepEqual(readIdList({ private: ['1', 2, '2', 'abc', 0] }, 'private'), ['1', '2']);
  assert.deepEqual(readIdList({ privates: ['7'] }, 'private'), ['7']);
  assert.deepEqual(readIdList({ group: ['9'], groups: ['9', '10'] }, 'groups'), ['9', '10']);
  assert.deepEqual(readIdList(null, 'private'), []);
});

test('normalizePolicyConfig：缺省值与非法 ownerQQ 都收敛', () => {
  const p = normalizePolicyConfig({ ownerQQ: 'abc' });
  assert.equal(p.ownerQQ, null);
  assert.equal(p.allowAllWhenEmpty, true);
  assert.deepEqual(p.allow.private, []);
});

test('黑名单优先于白名单与自动通过（顺序即安全语义）', () => {
  const verdict = admitPrivate({ cfg: cfg(), userId: '40004' });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reasonCode, REASON.DENIED);
});

test('closed-agent：只认管理员私聊；没配管理员则 fail-closed', () => {
  assert.deepEqual(admitPrivate({ cfg: cfg(), userId: '10001', mode: 'closed-agent' }), {
    allow: true,
    reasonCode: REASON.OWNER_OK,
    reason: '管理员私聊（closed-agent 唯一入口）'
  });
  const other = admitPrivate({ cfg: cfg(), userId: '20002', mode: 'closed-agent' });
  assert.equal(other.allow, false);
  assert.equal(other.reasonCode, REASON.OWNER_REQUIRED);

  const noOwner = admitPrivate({ cfg: cfg({ ownerQQ: '' }), userId: '10001', mode: 'closed-agent' });
  assert.equal(noOwner.allow, false);
  assert.equal(noOwner.reasonCode, REASON.OWNER_MISSING);
});

test('普通模式：管理员恒放行、白名单放行、其他人拒绝', () => {
  assert.equal(admitPrivate({ cfg: cfg(), userId: '10001' }).reasonCode, REASON.OWNER_OK);
  assert.equal(admitPrivate({ cfg: cfg(), userId: '20002' }).reasonCode, REASON.ALLOWED);
  const outsider = admitPrivate({ cfg: cfg(), userId: '99999' });
  assert.equal(outsider.allow, false);
  assert.equal(outsider.reasonCode, REASON.NOT_IN_ALLOW);
});

test('空白名单：只有 allowAllWhenEmpty=true 才放行全部', () => {
  const open = admitPrivate({ cfg: cfg({ allow: { private: [], groups: [] } }), userId: '99999' });
  assert.equal(open.allow, false, 'allowAllWhenEmpty=false 时空白名单等于谁都不放');

  const loose = admitPrivate({ cfg: cfg({ allow: { private: [], groups: [] }, allowAllWhenEmpty: true }), userId: '99999' });
  assert.equal(loose.allow, true);
  assert.equal(loose.reasonCode, REASON.EMPTY_ALLOW_ALL);
});

test('群聊只按群号判，黑名单优先', () => {
  assert.equal(admitGroup({ cfg: cfg(), groupId: '30003' }).allow, true);
  assert.equal(admitGroup({ cfg: cfg(), groupId: '50005' }).reasonCode, REASON.DENIED);
  assert.equal(admitGroup({ cfg: cfg(), groupId: '77777' }).allow, false);
});

test('非法 id 不会因为"看起来像空"而放行', () => {
  for (const bad of ['', 'abc', '-1', '0', null, undefined]) {
    const v = admitPrivate({ cfg: cfg({ allowAllWhenEmpty: true, allow: { private: [], groups: [] } }), userId: bad });
    assert.equal(v.allow, false, `userId=${String(bad)} 不该放行`);
    assert.equal(v.reasonCode, REASON.INVALID_ID);
  }
});

test('explainPolicy：能一眼看出当前准入面', () => {
  const text = explainPolicy(cfg());
  assert.ok(text.includes('管理员：10001'));
  assert.ok(text.includes('私聊白名单 1 个：20002'));
  assert.ok(text.includes('群白名单 1 个：30003'));
});
