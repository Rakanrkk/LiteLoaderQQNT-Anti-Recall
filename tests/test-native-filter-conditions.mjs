/**
 * tests/test-native-filter-conditions.mjs
 * 原生筛选条件链回归（零 npm 依赖，纯合成数据，不触碰真实 QQ 数据）：
 *
 * A. 适配器链（createRecordStoreAdapter）——native computed `c.proxy.queryFilterParams`
 *    （filterSendersUid 每次访问新数组引用）+ `c.props.keyword`/`c.props.chatInfo`
 *    → api.getNativeRecallRecords 收到正确 filterSendersUid/filterMsgFromTime/
 *    filterMsgToTime/keyword/peerUid/chatType：
 *    1) 原生默认态（senders=[]、时间 '0'）原样透传为「无筛选」，查询字段白名单（不外泄多余内容）；
 *    2) 筛选变化（senders/日期/keyword）→ refresh() 用新值重查；旧范围在途响应按代数丢弃（stale guard）；
 *    3) 同范围但 computed 每次返回新引用 → 按值比较不误判 stale，响应正常应用；
 *    4) active 期间筛选/keyword 变过 → 关闭（disable）后原生 getMsg(qp) 恰好补一次，QQ 自身
 *       发送者/日期筛选不丢；重新开启取当前（变化后的）筛选值，再次关闭不再补查；
 *    5) 未变化的关闭 → 不补查，描述符与原生状态值全等恢复；关闭后 refresh 不再触发查询。
 *
 * B. 后端真实过滤函数（recallHistory.js createRecallHistory.getNativeRecords 导出 mock deps）：
 *    6) sender list [] = 无筛选（绝不是「匹配无人」）；非空按 senderUid / senderUin 匹配；
 *       keyword 走 senderName/uid/uin/text haystack；时间 '0' 为无界；
 *    7) 日期筛选数值秒、Unix 毫秒（数字或字符串）自适应，闭区间含边界，反界为空；
 *    8) 无效 scope（空 peerUid/chatType 非法）返回空且绝不回退全局搜索；跨 peer/chatType 隔离；
 *       返回 records 是深拷贝，改动不污染只读源条目。
 *
 * 运行：node --test tests/test-native-filter-conditions.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRecordStoreAdapter } from '../recordStoreAdapter.js';

const require = createRequire(import.meta.url);
const { createRecallHistory } = require('../recallHistory.js');

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

/* ------------------------------------------------------------------ A. 适配器链 */

function rec(msgId, msgTime, senderUid = 'uA') {
  return { msgId, msgSeq: Number(msgId.slice(1)), msgTime, chatType: 1, senderUid, senderUin: senderUid === 'uA' ? '10001' : '10002', elements: [{ textElement: { content: `raw-${msgId}` } }] };
}
const PAGE_A = [rec('r5', 1770000000), rec('r4', 1760000000), rec('r3', 1750000000)];
const PAGE_B = [rec('r2', 1740000000), rec('r1', 1730000000)];
const ORDINARY_GROUPS = [{ date: '2026/10/17', list: [{ msgId: 'o1', msgTime: 1792000000 }] }];

/** 合成 native 组件：queryFilterParams 为 computed（每次访问新数组/新对象引用，与实机一致） */
function makeComponent() {
  // 原生筛选源：模拟用户在原生筛选面板选择的发送者/日期（enable 后测试可改）
  const qfpSource = { filterSendersUid: [], filterMsgFromTime: '0', filterMsgToTime: '0' };
  const state = { messageList: ORDINARY_GROUPS.map((g) => ({ date: g.date, list: [...g.list] })), isFinished: false, isLoading: false };
  const counters = { getMsg: 0, getMoreMsg: 0, initRecordData: 0, cancelPendingRequests: 0 };
  const store = {};
  const defineAccessor = (obj, name, get, set) => Object.defineProperty(obj, name, { get, set, configurable: true, enumerable: true });

  defineAccessor(store, 'messageList', () => state.messageList, (v) => { state.messageList = v; });
  defineAccessor(store, 'isFinished', () => state.isFinished, (v) => { state.isFinished = v; });
  defineAccessor(store, 'isLoading', () => state.isLoading, (v) => { state.isLoading = v; });
  store.lastMsg = null; store.searchMore = false; store.msgCount = ORDINARY_GROUPS.length; store.counts = 1;

  const impl = {
    getMsg(qp) { counters.getMsg++; state.messageList = ORDINARY_GROUPS.map((g) => ({ date: g.date, list: g.list.map((r) => ({ ...r })) })); state.isLoading = false; return Promise.resolve('native-getMsg'); },
    getMoreMsg() { counters.getMoreMsg++; return Promise.resolve('native-more'); },
    setMessageList() { /* native 后台写，guard 测试不在此 */ },
  };
  defineAccessor(store, 'getMsg', () => impl.getMsg, (v) => { impl.getMsg = v; });
  defineAccessor(store, 'getMoreMsg', () => impl.getMoreMsg, (v) => { impl.getMoreMsg = v; });
  defineAccessor(store, 'setMessageList', () => impl.setMessageList, (v) => { impl.setMessageList = v; });

  store.getFirstScreenMsgWithFilter = function () { counters.getMsg++; return Promise.resolve('native-first'); };
  store.getMsgByKeyWord = function () { counters.getMsg++; return Promise.resolve('native-keyword'); };
  store.startFilterQuery = function () { counters.getMsg++; return Promise.resolve('native-filter'); };
  store.invokeFilterQuery = function () { counters.getMsg++; return Promise.resolve('native-invoke'); };
  store.getMoreMsgWithFilter = function () { counters.getMoreMsg++; return Promise.resolve('native-moref'); };
  store.getMoreSearchMsg = function () { counters.getMoreMsg++; return Promise.resolve('native-mores'); };
  store.setMessageList0 = undefined; // 干扰项，确保不被误碰
  store.getMsgByMsgId = function () { return Promise.resolve('native-jump'); };
  store.cancelPendingRequests = function () { counters.cancelPendingRequests++; };

  const proxy = {
    store,
    queryParams: { peer: { chatType: 1, peerUid: 'peerA' }, msgId: '0', cnt: 50, queryOrder: false },
    get queryFilterParams() {
      // 实机形态：computed —— filterSendersUid 等每次访问都是新数组/新对象引用
      return {
        chatInfo: null, searchFields: 0, filterMsgType: [],
        filterSendersUid: [...qfpSource.filterSendersUid],
        filterMsgFromTime: String(qfpSource.filterMsgFromTime),
        filterMsgToTime: String(qfpSource.filterMsgToTime),
        pageLimit: 50, isReverseOrder: false, isIncludeCurrent: true,
        guildId: '', filterSubsAndRemind: [],
      };
    },
    initRecordData() { counters.initRecordData++; },
  };
  const props = { chatInfo: { chatType: 1, peerUid: 'peerA', privilegeFlag: 0 }, keyword: '', filter: null, isActive: true };
  const component = { props, proxy, isUnmounted: false };
  return { component, store, state, counters, impl, props, proxy, qfpSource };
}

/** api mock：manual=true 时响应手动 resolve，可构造「旧范围在途」与时间线 */
function makeApi({ manual = false } = {}) {
  const calls = [];
  const pending = [];
  const answer = (q, records, echo = {}) => ({
    peerUid: echo.peerUid ?? q.peerUid, chatType: echo.chatType ?? q.chatType, records,
    total: records.length, hasMore: false, offset: q.offset, limit: q.limit,
  });
  return {
    calls,
    getNativeRecallRecords(query) {
      calls.push({ ...query, filterSendersUid: [...(query.filterSendersUid || [])] });
      if (!manual) return Promise.resolve(answer(query, query.offset === 0 ? PAGE_A : PAGE_B));
      return new Promise((resolve, reject) => pending.push({ resolve, reject, query }));
    },
    resolve(i, records, echo) { pending[i].resolve(answer(pending[i].query, records, echo)); },
  };
}

function snapshotDescriptors(obj) {
  return new Map(Object.getOwnPropertyNames(obj).map((n) => [n, Object.getOwnPropertyDescriptor(obj, n)]));
}
const sameDescs = (a, b) => [...a.keys()].every((k) => String(a.get(k)) === String(b.get(k)));

function expectNoFilterCall(call) {
  // 原生默认态 → 空发送者列表 + '0' 时间边界原样透传（后端按「无筛选」解释）
  assert.deepEqual(call.filterSendersUid, [], '默认空发送者列表必须原样传给 api');
  assert.equal(call.filterMsgFromTime, '0');
  assert.equal(call.filterMsgToTime, '0');
  assert.equal(call.peerUid, 'peerA');
  assert.equal(call.chatType, 1);
}

test('A1 原生默认态：computed queryFilterParams 的 []/\'0\' 与 props.keyword/chatInfo 正确进入 getNativeRecallRecords，查询字段白名单', async () => {
  const { component, qfpSource } = makeComponent();
  const api = makeApi();
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();

  assert.equal(api.calls.length, 1);
  const call = api.calls[0];
  expectNoFilterCall(call);
  assert.equal(call.keyword, '');
  assert.equal(call.offset, 0);
  assert.equal(call.limit, 50);
  // 查询只包含范围/筛选/分页字段，不夹带账号或组件内部内容（readonly 透传）
  assert.deepEqual(Object.keys(call).sort(), ['chatType', 'filterMsgFromTime', 'filterMsgToTime', 'filterSendersUid', 'keyword', 'limit', 'offset', 'peerUid']);

  // props.keyword 变化后 refresh() → 新查询携带当前原生关键词
  component.props.keyword = '报销';
  adapter.refresh();
  await flush();
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].keyword, '报销');
  expectNoFilterCall(api.calls[1]);
  // computed 源未被适配器改写（只读）
  assert.deepEqual(qfpSource.filterSendersUid, []);
  adapter.disable();
});

test('A2 筛选变化：refresh() 携带新 senders/日期/keyword 重查；旧范围在途响应按代数丢弃（stale guard）', async () => {
  const { component, qfpSource } = makeComponent();
  const api = makeApi({ manual: true });
  const adapter = createRecordStoreAdapter({ component, api, onState: () => {} });
  adapter.enable();
  await flush();
  assert.equal(api.calls.length, 1);
  const listAtEnable = component.proxy.store.messageList;

  // 用户改原生筛选：发送者 uB + 秒级字符串日期边界；keyword 也变
  qfpSource.filterSendersUid = ['uB'];
  qfpSource.filterMsgFromTime = '1760000000';
  qfpSource.filterMsgToTime = '1770000000';
  component.props.keyword = '订单';
  adapter.refresh();
  await flush();
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls[1].filterSendersUid, ['uB']);
  assert.equal(api.calls[1].filterMsgFromTime, '1760000000');
  assert.equal(api.calls[1].filterMsgToTime, '1770000000');
  assert.equal(api.calls[1].keyword, '订单');

  // 旧范围（call#0）后到：代数已变，必须整体丢弃
  api.resolve(0, PAGE_A);
  await flush();
  assert.equal(component.proxy.store.messageList, listAtEnable, '旧范围响应被丢弃：原生 messageList 未被写入');
  assert.equal(component.proxy.store.isLoading, true, '旧响应被丢弃，仍处于新查询 loading');

  // 新范围响应应用
  api.resolve(1, [rec('r4', 1760000000, 'uB'), rec('r5', 1770000000, 'uB')]);
  await flush();
  const store = component.proxy.store;
  assert.equal(store.isLoading, false);
  assert.equal(store.isFinished, true);
  const ids = store.messageList.flatMap((g) => g.list.map((r) => r.msgId)).sort();
  assert.deepEqual(ids, ['r4', 'r5']);
  adapter.disable();
});

test('A3 同范围 computed 新引用不误判 stale：每次访问返回新 [] 引用，按值比较后响应照常应用', async () => {
  const { component } = makeComponent();
  const api = makeApi({ manual: true });
  const adapter = createRecordStoreAdapter({ component, api });
  adapter.enable();
  await flush();

  // 原生 computed 被响应式系统反复求值（新引用、同值），再应用响应
  const proxy = component.proxy;
  for (let i = 0; i < 50; i++) void proxy.queryFilterParams;
  api.resolve(0, PAGE_A);
  await flush();
  const store = component.proxy.store;
  assert.equal(store.isLoading, false);
  const ids = store.messageList.flatMap((g) => g.list.map((r) => r.msgId)).sort();
  assert.deepEqual(ids, ['r3', 'r4', 'r5']); // resolve 精确回放传入的 PAGE_A
  adapter.disable();
});

test('A4 关闭/重开筛选保持用户与日期：active 期间筛选变化 → disable 补一次原生 getMsg(qp)；重开取当前筛选值；再次关闭不再补查', async () => {
  const { component, state, counters, proxy, qfpSource } = makeComponent();
  const originalList = state.messageList;
  const api = makeApi({ manual: true });
  const adapter = createRecordStoreAdapter({ component, api });
  adapter.enable();
  await flush();
  assert.equal(api.calls.length, 1);
  expectNoFilterCall(api.calls[0]);

  // 用户在原生筛选面板改了发送者与日期（active 期间）
  qfpSource.filterSendersUid = ['uB'];
  qfpSource.filterMsgFromTime = '1760000000';
  qfpSource.filterMsgToTime = '1770000000';
  component.props.keyword = '订单';

  // 关闭（收起筛选/退出仅看撤回）：恢复原生后必须让 QQ 自身按新筛选补查一次
  assert.equal(adapter.disable(), true);
  assert.equal(counters.getMsg, 1, '筛选变过 → disable 恰好补一次原生 getMsg');
  assert.ok(counters.getMoreMsg === 0 && counters.initRecordData === 0, '有可用的 getMsg 就不再走 initRecordData');
  // 补查由原生 getMsg 执行：重建原生普通列表（深等于 ORDINARY_GROUPS）
  assert.deepEqual(state.messageList.map((g) => g.date), ORDINARY_GROUPS.map((g) => g.date), 'disable 后原生 getMsg 重建普通消息列表');

  // 重新开启（再打开仅看撤回）：取当前（变化后的）筛选条件，不回退到 enable 时旧值
  adapter.enable();
  await flush();
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls[1].filterSendersUid, ['uB']);
  assert.equal(api.calls[1].filterMsgFromTime, '1760000000');
  assert.equal(api.calls[1].filterMsgToTime, '1770000000');
  assert.equal(api.calls[1].keyword, '订单');
  api.resolve(1, [rec('r4', 1760000000, 'uB')]);
  await flush();

  // 不再变化直接关闭：QQ 自身筛选状态正确，不重复补查
  adapter.disable();
  assert.equal(counters.getMsg, 1, '范围未再变化 → 不补查');
});

test('A5 未变化的关闭零扰动：描述符全等恢复、无原生补查；关闭后 refresh/loadMore 不触发查询', async () => {
  const { component, state, counters } = makeComponent();
  const originalList = state.messageList;
  const before = snapshotDescriptors(component.proxy.store);
  const api = makeApi();
  const adapter = createRecordStoreAdapter({ component, api });
  adapter.enable();
  await flush();
  assert.equal(api.calls.length, 1);
  assert.equal(adapter.disable(), true);

  assert.equal(counters.getMsg, 0, '无变化关闭不补查');
  assert.equal(state.messageList, originalList);
  const after = snapshotDescriptors(component.proxy.store);
  assert.equal(sameDescs(before, after), true, 'store 描述符全等恢复');
  assert.equal(adapter.active, false);

  // 关闭后纯透传：refresh/loadMore 不再发起查询
  assert.equal(adapter.refresh(), false);
  assert.equal(adapter.loadMore(), false);
  await flush();
  assert.equal(api.calls.length, 1);
});

/* ------------------------------------------------------- B. 后端真实过滤函数 */

const T1 = 1750000000; // 秒
const T2 = 1760000000;
const T3 = 1770000000;

function makeBackend() {
  const entries = [
    { id: 'b1', sender: 'Alice', msg: { msgId: 'b1', msgSeq: 1, chatType: 1, peerUid: 'peerA', senderUid: 'uA', senderUin: '10001', sendNickName: 'Alice', msgTime: T1, elements: [{ textElement: { content: 'hello world' } }] } },
    { id: 'b2', sender: 'Bob', msg: { msgId: 'b2', msgSeq: 2, chatType: 1, peerUid: 'peerA', senderUid: 'uB', senderUin: '10002', sendNickName: 'Bob', msgTime: T2, elements: [{ textElement: { content: '订单详情' } }] } },
    { id: 'b3', sender: 'Carol', msg: { msgId: 'b3', msgSeq: 3, chatType: 1, peerUid: 'peerA', senderUid: 'uC', senderUin: '10086', sendNickName: 'Carol', msgTime: T3, elements: [{ textElement: { content: '明天见' } }] } },
    { id: 'b4', sender: 'Dave', msg: { msgId: 'b4', msgSeq: 4, chatType: 2, peerUid: 'peerA', senderUid: 'uD', senderUin: '10004', sendMemberName: 'Dave', msgTime: T2, elements: [{ textElement: { content: '群消息' } }] } },
    { id: 'b5', sender: 'Alice', msg: { msgId: 'b5', msgSeq: 5, chatType: 1, peerUid: 'peerB', senderUid: 'uA', senderUin: '10001', sendNickName: 'Alice', msgTime: T2, elements: [{ textElement: { content: '别的会话' } }] } },
  ];
  const probes = { knownIdCalls: 0, findCalls: 0 };
  const deps = {
    getKnownRecalledIds(peerUid) {
      probes.knownIdCalls++;
      return entries.filter((e) => !peerUid || e.msg.peerUid === peerUid).map((e) => e.id);
    },
    async findCachedMessage(id) {
      probes.findCalls++;
      const e = entries.find((e) => e.id === id);
      return e ? { entry: e, source: 'test' } : null;
    },
  };
  return { history: createRecallHistory(deps), entries, probes };
}

test('B6 发送者 [] = 无筛选；非空按 senderUid/senderUin 匹配；keyword 走名字/正文 haystack；时间 \'0\' 为无界', async () => {
  const { history } = makeBackend();
  const base = { peerUid: 'peerA', chatType: 1, filterMsgFromTime: '0', filterMsgToTime: '0' };

  // 原生默认态：空发送者列表 + '0' → 全部 3 条，绝不变成「匹配无人」
  const all = await history.getNativeRecords({ ...base, filterSendersUid: [] });
  assert.equal(all.total, 3);
  assert.deepEqual(all.records.map((r) => r.msgId).sort(), ['b1', 'b2', 'b3']);

  // 非空列表按 senderUid 精确过滤
  const bob = await history.getNativeRecords({ ...base, filterSendersUid: ['uB'] });
  assert.deepEqual(bob.records.map((r) => r.msgId), ['b2']);

  // senderUin 也可命中（原生控件可能传 uin）
  const byUin = await history.getNativeRecords({ ...base, filterSendersUid: ['10086'] });
  assert.deepEqual(byUin.records.map((r) => r.msgId), ['b3']);

  // keyword（来自 c.props.keyword 链）：命中 senderName 与正文
  const kwName = await history.getNativeRecords({ ...base, filterSendersUid: [], keyword: 'ALICE' });
  assert.deepEqual(kwName.records.map((r) => r.msgId), ['b1']);
  const kwText = await history.getNativeRecords({ ...base, filterSendersUid: [], keyword: '订单' });
  assert.deepEqual(kwText.records.map((r) => r.msgId), ['b2']);
  // 组合：keyword 与发送者同时生效
  const combo = await history.getNativeRecords({ ...base, filterSendersUid: ['uB'], keyword: 'alice' });
  assert.equal(combo.total, 0);
});

test('B7 日期筛选：秒级/毫秒级（数字或字符串）自适应，闭区间含边界，反界为空', async () => {
  const { history } = makeBackend();
  const base = { peerUid: 'peerA', chatType: 1, filterSendersUid: [] };

  // 秒级字符串边界：T1 < from=T2 <= to=T3 → b2、b3（b3 恰好等于上界，闭区间保留）
  const secRange = await history.getNativeRecords({ ...base, filterMsgFromTime: String(T2), filterMsgToTime: String(T3) });
  assert.deepEqual(secRange.records.map((r) => r.msgId).sort(), ['b2', 'b3']);

  // 毫秒级数字：下界恰好等于 b1（闭区间保留）
  const msRange = await history.getNativeRecords({ ...base, filterMsgFromTime: T1 * 1000, filterMsgToTime: T1 * 1000 + 5 });
  assert.deepEqual(msRange.records.map((r) => r.msgId), ['b1']);

  // 毫秒级字符串与秒级等价
  const msStr = await history.getNativeRecords({ ...base, filterMsgFromTime: `${T1 * 1000}`, filterMsgToTime: `${T1 * 1000}` });
  assert.deepEqual(msStr.records.map((r) => r.msgId), ['b1']);

  // 反界（from > to）→ 空，绝不整段回退
  const reversed = await history.getNativeRecords({ ...base, filterMsgFromTime: String(T3), filterMsgToTime: String(T2) });
  assert.deepEqual(reversed.records, []);
});

test('B8 无效 scope 绝不回退全局搜索；跨 peer/chatType 隔离；records 深拷贝不污染只读源', async () => {
  const { history, entries, probes } = makeBackend();

  // 空 peerUid / 非法 chatType → 空结果，且完全不触发已知撤回索引读取（无账号内容外泄面）
  probes.knownIdCalls = 0;
  const noPeer = await history.getNativeRecords({ peerUid: '', chatType: 1, filterSendersUid: [], filterMsgFromTime: '0', filterMsgToTime: '0' });
  assert.deepEqual(noPeer.records, []);
  const badChat = await history.getNativeRecords({ peerUid: 'peerA', chatType: 99, filterSendersUid: [], filterMsgFromTime: '0', filterMsgToTime: '0' });
  assert.deepEqual(badChat.records, []);
  assert.equal(probes.knownIdCalls, 0, '无效 scope 不得读取任何撤回索引');

  // peer+chatType 双重隔离：同 peerUid 的群聊（b4）不进入私聊结果，peerB（b5）不进入 peerA
  const privateChat = await history.getNativeRecords({ peerUid: 'peerA', chatType: 1, filterSendersUid: [], filterMsgFromTime: '0', filterMsgToTime: '0' });
  assert.deepEqual(privateChat.records.map((r) => r.msgId).sort(), ['b1', 'b2', 'b3']);
  const group = await history.getNativeRecords({ peerUid: 'peerA', chatType: 2, filterSendersUid: [], filterMsgFromTime: '0', filterMsgToTime: '0' });
  assert.deepEqual(group.records.map((r) => r.msgId), ['b4']);

  // 返回 records 是深拷贝：改动不写回只读源条目
  const victim = privateChat.records[0];
  victim.msgId = 'tampered';
  victim.elements.length = 0;
  assert.equal(entries.find((e) => e.id === 'b1').msg.msgId, 'b1');
  assert.equal(entries.find((e) => e.id === 'b1').msg.elements.length, 1);
});
