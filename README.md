# dsh-qq-access

> **一句话**：把「谁能和这个 agent 说话」做成一个纯函数 + 一条 CLI —— 不连 QQ、不连 DSH、不发消息，只回答放行还是拒绝，以及**为什么**。
>
> 从 `qq-bridge` 抽出的独立项目，对应成本统计里 **「好友 / 白名单 / 权限」** 这条线（约 6.3% 的 token 花在这上面 —— 因为准入逻辑踩过的坑，比写它的代码还贵）。

---

## 它解决什么

把 agent 接进 QQ，本质上是**把账号的控制权交给模型**。默认配置写错一格，结果不是报错，而是「陌生人也能指挥它」——这类错误在日志里长得和正常工作一模一样。

所以这里的每一条判断都：

- **顺序固定**（黑名单 → 管理员 → closed-agent → 白名单 → 空白名单兜底），顺序本身就是安全语义；
- **fail-closed**（该拒绝时拒绝；`closed-agent` 没配管理员 = 拒绝所有人，不是放行所有人）；
- **带理由**（`reasonCode` 机器可判 + `reason` 人可读，直接进启动日志）；
- **可离线测**（纯函数，20 个用例，没有网络依赖）。

## 快速开始

### 三种装法（挑一个）

```bash
# 1) 零安装，先跑一次试试（需要 node ≥ 20 和 git）
npx github:whatxin7/dsh-qq-access init --out config.json

# 2) 装成全局命令（日常用这个）
npm i -g github:whatxin7/dsh-qq-access

# 3) 想改代码 / 跑测试
git clone https://github.com/whatxin7/dsh-qq-access.git
cd dsh-qq-access && npm install && npm test
```

> ⚠️ npm 上的 `dsh-qq-access` 这个名字**已被他人占用**（Applepinea 的 DSH QQ 通道，不是本项目），所以不要 `npm i dsh-qq-access`。
> 本项目只通过 `github:whatxin7/...` 或源码安装；以后发 npm 会用 `@whatxin7/...` scope。


```bash
git clone https://github.com/whatxin7/dsh-qq-access.git
cd dsh-qq-access
node --test                     # 20 个用例
node bin/qq-access.mjs init --out config.json
node bin/qq-access.mjs explain --config config.json
```

```
模式开关：allowAllWhenEmpty=false
管理员：10001
私聊白名单 2 个：20002, 20003
群白名单 1 个：30003
私聊黑名单 0 个；群黑名单 0 个
```

### 查一个号能不能进来

```bash
qq-access check private 20002 --config config.json     # ✅ 放行 … 在 allow.private 白名单里
qq-access check private 99999 --config config.json     # ⛔ 拒绝 … 不在 allow.private 白名单里
qq-access check private 20002 --mode closed-agent      # ⛔ 拒绝 … closed-agent 只认管理员私聊
qq-access check group 30003 --config config.json       # ✅ 放行
```

退出码：`0` 放行 / `1` 拒绝 / `2` 用法错误 —— 可以直接写进 shell 判断和 CI。

### 模拟一条好友申请

```bash
cat > event.json <<'JSON'
{ "post_type": "request", "request_type": "friend", "user_id": 20002, "flag": "u___aiPDnHuZofoHSjpZdWiQ", "comment": "我是H." }
JSON
qq-access friend --event event.json --config config.json
```

```
APPROVE — 自动通过
  QQ：20002
  生效配置：{"enabled":true,"autoApprove":true,...}
```

## 判定顺序（顺序即语义）

| # | 规则 | 结果 | reasonCode |
|---|---|---|---|
| 1 | `deny.private` / `deny.groups` 命中 | 拒绝 | `denied` |
| 2 | `closed-agent` 且没配 `ownerQQ` | 拒绝（fail-closed） | `owner-missing` |
| 3 | `closed-agent` 且不是管理员私聊 | 拒绝 | `owner-required` |
| 4 | 管理员私聊 | 放行 | `owner-ok` |
| 5 | 在 `allow.private` / `allow.groups` 里 | 放行 | `allowed` |
| 6 | 白名单为空且 `allowAllWhenEmpty=true` | 放行（并提示先填白名单） | `empty-allow-all` |
| 7 | 其它 | 拒绝 | `not-in-allow` |
| — | id 不是正整数 | 拒绝 | `invalid-id` |

> ⚠️ `allowAllWhenEmpty` 默认 `true` 是「装上就能用」的取舍，不是安全默认值。
> 让模型带着完整工具面上线前，请先填白名单，或把它设成 `false`。

## 好友申请：只通过，不主动加

OneBot v11 / SnowLuma **没有「主动加好友」这个 action**（只有 `set_friend_add_request`、`delete_friend`、`get_friend_list`）。所以「只通过、不主动加」是结构上成立的，不是靠自觉。

四条实测口径（都写进了 `src/friend-request.js` 的注释与测试）：

1. **`flag` 才是回执凭据**，`user_id` 只是附加信息。网关解析不出对方 UIN 时会把 `user_id` 填 0，但 `flag` 里仍有 UID —— 先按 `user_id` 判「没有 QQ 号」就会把一条**本可以通过**的申请丢掉（真实事故：一条「我是H.」被吞）。
2. **通过之后必须写白名单**，否则对方私聊仍会被挡在门外，等于白加。
3. **可疑申请是另一条链路**（`get_doubt_friends_add_request`）：事件流里可能永远等不到它，得启动扫一遍 + 定时轮询。
4. **兜底补白名单**：申请被吞 / 在手机端手动通过时，对方「第一次私聊」若确认在好友列表里，就补进 `allow.private`。判据刻意收窄：只私聊、只好友、非 closed-agent、非黑名单、不是自己。

想永久挡掉某个好友：写 `deny.private`。**只从 `allow.private` 删掉没用** —— 他下一条私聊会被当成「手动加的好友」再补回来。

## 作为库用

```js
import { admitPrivate, admitGroup, normalizePolicyConfig, REASON } from 'dsh-qq-access';

const cfg = normalizePolicyConfig(JSON.parse(configText));
const v = admitPrivate({ cfg, userId: '20002', mode: 'chat' });
if (!v.allow) console.warn('拒绝：', v.reason, v.reasonCode);
```

| 文件 | 职责 |
|---|---|
| `src/policy.mjs` | 私聊/群聊准入、配置规范化、准入面说明 |
| `src/friend-request.js` | 好友申请 / 可疑申请 / 首次私聊补白名单的纯判定 |
| `bin/qq-access.mjs` | CLI：`explain` / `check` / `friend` / `json` / `init` |

`json` 子命令输出机器可读结果（含规范化后的策略），便于接进控制台或监控：

```bash
qq-access json private 20002 --config config.json
```

## 集成到桥接

```js
// 收到消息时
const verdict = admitPrivate({ cfg: policy, userId: event.user_id, mode: currentMode });
if (!verdict.allow) return log.info(`忽略会话：${verdict.reason}（${verdict.reasonCode}）`);

// 收到好友申请时
const decision = decideFriendRequest({ event, cfg, selfId });
if (decision.action === 'approve') await onebot.setFriendAddRequest(decision.flag);
if (decision.action === 'approve' && conf.autoWhitelist && decision.userId) {
  withPrivateAllowed(cfgObject, decision.userId);   // 就地改配置对象
  saveConfig(cfgObject);                            // 落盘由调用方负责
}
```

## 已知边界

- 只判「群号级」准入；成员级权限（谁能 @ 它、谁能让它执行命令）不在这里做。
- `ownerQQ` 只有一个。多管理员需要自己扩展 `ownerQQ → ownerQQs`。
- 不信 `user_id` 之外的身份信息（昵称/名片都能改，不参与任何判断）。
- 本模块不写文件：`withPrivateAllowed()` 只改传入的对象，落盘与并发控制属于调用方。

## 项目家族

| 项目 | 对应成本条目 |
|---|---|
| **dsh-qq-access**（本仓库） | 好友 / 白名单 / 权限 |
| [dsh-token-meter](https://github.com/whatxin7/dsh-token-meter) | 用量与成本核算 |
| [dsh-qq-voice](https://github.com/whatxin7/dsh-qq-voice) | 语音 / 唱歌 / 音色 |
| [dsh-qq-stickers](https://github.com/whatxin7/dsh-qq-stickers) | 表情包 / 斗图 |
| [dsh-mcp-safe-tools](https://github.com/whatxin7/dsh-mcp-safe-tools) | 能力扩展（视觉 / 搜索 / 语感） |
| [dsh-session-link](https://github.com/whatxin7/dsh-session-link) | 联通会话 / 行为调优 |
| [dsh-persona-kit](https://github.com/whatxin7/dsh-persona-kit) | 人格 / 角色卡 |
| [qq-bridge](https://github.com/whatxin7/qq-bridge) | 桥接内核（旗舰仓库） |

## English

Admission policy for a QQ ↔ DSH bridge: a pure, offline-testable decision function for private/group access plus friend-request handling (approve-only, never add), with an ordered rule table, fail-closed defaults, machine-readable reason codes, and a CLI (`check` / `explain` / `friend` / `json`).

## License

MIT © whatxin7


