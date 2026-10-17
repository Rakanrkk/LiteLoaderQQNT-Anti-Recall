/**
 * tests/test-record-store-adapter.mjs
 * 合成 mock native store（own accessor / computed filter 数组形态与实机一致）验证 recordStoreAdapter：
 * native jump 不变、peer 对象与 filters 透传、off 描述符全等、旧 query 后到(stale)、echo 校验、
 * more 分组合并、普通写 guard、raw record 不被改动、不自动订阅新撤回。
 * 回归：Proxy reactive（Vue 模拟）store 下 writeStoreValue 必须 store[name]=value 触发 Proxy.set 通知，
 * native computed 视图同步；旧 savedDescriptor.set.call(proxy,…) 绕过 Proxy.set → 零通知 → 视图失更新。
 * 运行：node --test tests/test-record-store-adapter.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordStoreAdapter, groupNativeRecords } from '../recordStoreAdapter.js';

function sec(y, m, d, hh = 0, mm = 0) {
  return Math.floor(new Date(y, m - 1, d, hh, mm, 0).getTime() / 1000);
}
function rec(msgId, msgTime) {
  return { msgId, msgSeq: Number(msgId.slice(1)), msgTime, chatType: 1, senderUid: 'u1', elements: [{ textElement: { content: `raw-${msgId}` } }] };
}
// 页1：10-17 两条 + 10-16 一条；页2：10-15 一条
const PAGE1 = [rec('m4', sec(2026, 10, 17, 9, 15)), rec('m3', sec(2026, 10, 17, 8, 0)), rec('m2', sec(2026, 10, 16, 23, 30))];
const PAGE2 = [rec('m1', sec(2026, 10, 15, 12, 0))];
const ORDINARY = [
  { date: '2026/10/17', list: [{ msgId: 'o1', msgTime: sec(2026, 10, 17, 7, 0) }] },
  { date: '2026/10/16', list: [{ msgId: 'o2', msgTime: sec(2026, 10, 16, 7, 0) }] },
];

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
function collector() { const events = []; return { events, onState: (s) => events.push({ ...s }) }; }

/** 合成 native store：messageList/isFinished/isLoading 为 configurable get/set；getMsg/getMoreMsg/setMessageList 为 own accessor；queryFilterParams 为 computed（每次新数组引用） */
function makeComponent() {
  const state = { messageList: ORDINARY.map((g) => ({ date: g.date, list: [...g.list] })), isFinished: false, isLoading: false };
  const counters = { getMsg: 0, getMoreMsg: 0, cancelPendingRequests: 0, initRecordData: 0, setMessageList: 0, updateMessageList: 0, clearMessageList: 0, handleMsgQueryResult: 0, setFilteredMsgList: 0 };
  const qfpSource = { filterSendersUid: ['u9'] };
  const store = {};
  const defineAccessor = (obj, name, get, set) => Object.defineProperty(obj, name, { get, set, configurable: true, enumerable: true });

  defineAccessor(store, 'messageList', () => state.messageList, (v) => { state.messageList = v; });
  defineAccessor(store, 'isFinished', () => state.isFinished, (v) => { state.isFinished = v; });
  defineAccessor(store, 'isLoading', () => state.isLoading, (v) => { state.isLoading = v; });
  store.lastMsg = null;
  store.searchMore = false;
  store.counts = 2;

  const impl = {
    getMsg() {
      counters.getMsg++;
      state.messageList = ORDINARY.map((g) => ({ date: g.date, list: g.list.map((r) => ({ ...r })) }));
      state.isLoading = false;
      return Promise.resolve('native-getMsg');
    },
    getMoreMsg() {
      counters.getMoreMsg++;
      state.messageList = [...state.messageList, { date: '2026/10/14', list: [{ msgId: 'oMore', msgTime: sec(2026, 10, 14, 7, 0) }] }];
      return Promise.resolve('native-more');
    },
    setMessageList(groups) { counters.setMessageList++; state.messageList = groups; },
  };
  defineAccessor(store, 'getMsg', () => impl.getMsg, (v) => { impl.getMsg = v; });
  defineAccessor(store, 'getMoreMsg', () => impl.getMoreMsg, (v) => { impl.getMoreMsg = v; });
  defineAccessor(store, 'setMessageList', () => impl.setMessageList, (v) => { impl.setMessageList = v; });

  store.getFirstScreenMsgWithFilter = function () { counters.getMsg++; return Promise.resolve('native-first'); };
  store.getMsgByKeyWord = function () { counters.getMsg++; return Promise.resolve('native-keyword'); };
  store.getMoreMsgWithFilter = function () { counters.getMoreMsg++; return Promise.resolve('native-more-filter'); };
  store.getMoreSearchMsg = function () { counters.getMoreMsg++; return Promise.resolve('native-more-search'); };
  store.startFilterQuery = function () { counters.getMsg++; return Promise.resolve('native-filter'); };
  store.invokeFilterQuery = function () { counters.getMsg++; return Promise.resolve('native-invoke'); };
  store.getMsgByMsgId = function () { return Promise.resolve('native-jump'); }; // 不在覆盖清单：jump 原样
  store.setFilteredMsgList = function (g) { counters.setFilteredMsgList++; state.messageList = g; };
  store.updateMessageList = function (g) { counters.updateMessageList++; state.messageList = g; };
  store.clearMessageList = function () { counters.clearMessageList++; state.messageList = []; };
  store.handleMsgQueryResult = function (g) { counters.handleMsgQueryResult++; state.messageList = g; };
  // applyFilterQueryResult 故意不存在 → 验证 hadOwn=false 影子属性恢复
  store.cancelPendingRequests = function () { counters.cancelPendingRequests++; };

  const proxy = {
    store,
    // 实机形态：peer 是 {chatType, peerUid} 对象
    queryParams: { peer: { chatType: 1, peerUid: 'peerA' }, msgId: '0', cnt: 50, queryOrder: false },
    // 实机形态：computed，每次访问产生新数组引用
    get queryFilterParams() {
      return {
        chatInfo: null, searchFields: 0, filterMsgType: [], filterSendersUid: [...qfpSource.filterSendersUid],
        filterMsgFromTime: null, filterMsgToTime: null, pageLimit: 50,
        isReverseOrder: false, isIncludeCurrent: true, guildId: '', filterSubsAndRemind: [],
      };
    },
    initRecordData() { counters.initRecordData++; },
  };
  const props = { chatInfo: { chatType: 1, peerUid: 'peerA', privilegeFlag: 0 }, keyword: '', filter: null, isActive: true };
  const component = { props, proxy, isUnmounted: false, ctx: { targetToChat() { return 'native-targetToChat'; } } };
  return { component, store, state, counters, impl, props, proxy, qfpSource };
}

/** api mock：manual=true 时 promise 由测试手动 resolve/reject，可构造“旧 query 后到” */
function makeApi({ manual = false } = {}) {
  const calls = [];
  const pending = [];
  const answer = (q, records, extra = {}, echo = {}) => ({
    peerUid: echo.peerUid ?? q.peerUid, chatType: echo.chatType ?? q.chatType, records,
    total: extra.total ?? records.length,
    hasMore: extra.hasMore ?? false,
    offset: q.offset, limit: q.limit,
  });
  const api = {
    calls,
    recallHistoryChangedCalls: 0,
    getNativeRecallRecords(query) {
      calls.push({ ...query, filterSendersUid: [...(query.filterSendersUid || [])] });
      if (!manual) {
        const all = [...PAGE1, ...PAGE2];
        const pageSize = Math.min(3, query.limit);
        const slice = all.slice(query.offset, query.offset + pageSize);
        return Promise.resolve(answer(query, slice, { total: all.length, hasMore: query.offset + slice.length < all.length }));
      }
      return new Promise((resolve, reject) => pending.push({ resolve, reject, query }));
    },
    resolve(i, records, extra, echo) { pending[i].resolve(answer(pending[i].query, records, extra, echo)); },
    reject(i, err) { pending[i].reject(err); },
  };
  return api;
}

function snapshotDescriptors(obj) {
  return new Map(Object.getOwnPropertyNames(obj).map((n) => [n, Object.getOwnPropertyDescriptor(obj, n)]));
}

test('groupNativeRecords 按本地日期 YYYY/MM/DD 分组（新→旧）且保留 record 引用；数字串时间自适应', () => {
  const groups = groupNativeRecords(PAGE1);
  assert.deepEqual(groups.map((g) => g.date), ['2026/10/17', '2026/10/16']);
  assert.deepEqual(groups.map((g) => g.list.length), [2, 1]);
  assert.equal(groups[0].list[0], PAGE1[0]); // 同一对象，无 wrapper
  const numStr = [{ msgId: 'x', msgTime: String(sec(2026, 10, 10, 5, 0)) }]; // numeric string
  assert.deepEqual(groupNativeRecords(numStr).map((g) => g.date), ['2026/10/10']);
  const g2 = groupNativeRecords(PAGE1, 'YYYY-MM-DD');
  assert.deepEqual(g2.map((g) => g.date), ['2026-10-17', '2026-10-16']);
});

test('enable 后原生列表被撤回分组替换、raw record 原样、onState 汇报、peer 对象与 filter 正确取值', async () => {
  const { component, state, counters, proxy } = makeComponent();
  const { onState, events } = collector();
  const api = makeApi();
  const adapter = createRecordStoreAdapter({ component, api, onState });
  assert.equal(adapter.enable(), true);
  await flush();

  assert.equal(adapter.active, true);
  assert.equal(state.messageList[0].list[0], PAGE1[0]); // raw 原对象直填
  assert.deepEqual(state.messageList.map((g) => g.date), ['2026/10/17', '2026/10/16']);
  const q = api.calls.at(-1);
  assert.equal(q.peerUid, 'peerA'); // 严格 string，来自 qp.peer.peerUid / chatInfo
  assert.equal(q.chatType, 1);
  assert.equal(q.keyword, '');
  assert.deepEqual(q.filterSendersUid, ['u9']); // computed 新引用数组按值透传
  assert.equal(q.offset, 0);
  assert.equal(q.limit, 50);
  assert.ok(events.some((e) => e.active === true && e.loading === false && e.total === 4 && e.hasMore === true && e.error === null));
  assert.equal(counters.cancelPendingRequests, 1); // enable 先取消旧 native 响应
  void proxy;
  adapter.disable();
});

test('enable/disable 循环后 store 描述符全等、native 快照恢复、hadOwn=false 影子删除、jump/targetToChat 不变', async () => {
  const { component, store, state } = makeComponent();
  const api = makeApi();
  const before = snapshotDescriptors(store);
  const beforeList = state.messageList;
  const jumpBefore = Object.getOwnPropertyDescriptor(store, 'getMsgByMsgId');
  const ctxBefore = Object.getOwnPropertyDescriptor(component.ctx, 'targetToChat');

  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'applyFilterQueryResult'), true); // 影子已建
  assert.notDeepEqual(state.messageList, beforeList);
  assert.equal(await store.getMsgByMsgId(), 'native-jump'); // jump 函数原样（不在覆盖清单）

  adapter.disable();
  assert.equal(Object.prototype.hasOwnProperty.call(store, 'applyFilterQueryResult'), false); // hadOwn=false 已删
  assert.equal(Object.getOwnPropertyNames(store).length, before.size);
  for (const [n, d] of before) assert.deepEqual(Object.getOwnPropertyDescriptor(store, n), d, `descriptor ${n}`);
  assert.equal(state.messageList, beforeList); // 原生快照（同一数组引用）恢复
  assert.equal(state.isLoading, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(store, 'getMsgByMsgId'), jumpBefore);
  assert.deepEqual(Object.getOwnPropertyDescriptor(component.ctx, 'targetToChat'), ctxBefore);
});

test('active 期间 keyword 变过 → disable 恰好触发一次原生 getMsg(queryParams)；filter 数组变更同样触发', async () => {
  const { component, store, counters, impl, qfpSource } = makeComponent();
  const api = makeApi();
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  component.props.keyword = 'changed';
  adapter.disable();
  assert.equal(counters.getMsg, 1); // 仅恢复后的那次原生刷新
  assert.equal(Object.getOwnPropertyDescriptor(store, 'getMsg').get.call(store), impl.getMsg); // backing fn 未被动过

  // 仅 filter（computed 数组，值变化）→ 也触发一次
  const counters2 = makeComponent();
  const adapter2 = createRecordStoreAdapter({ component: counters2.component, api });
  assert.equal(adapter2.enable(), true);
  await flush();
  counters2.qfpSource.filterSendersUid.push('u8'); // 值变化（引用每次都是新的，必须按值比较）
  adapter2.disable();
  assert.equal(counters2.counters.getMsg, 1);

  // 未变过 → 不触发
  const third = makeComponent();
  const adapter3 = createRecordStoreAdapter({ component: third.component, api });
  assert.equal(adapter3.enable(), true);
  await flush();
  adapter3.disable();
  assert.equal(third.counters.getMsg, 0);
});

test('旧 query 后到被丢弃（request 代数防 stale）', async () => {
  const { component, store, props, state, proxy } = makeComponent();
  const api = makeApi({ manual: true });
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  assert.equal(api.calls.length, 1);
  assert.equal(state.isLoading, true);

  props.keyword = 'kw';
  store.getMsg(proxy.queryParams); // active → reset（带 hint），同 tick debounce
  await flush();
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].keyword, 'kw');

  api.resolve(0, PAGE1, { hasMore: true }); // 旧代数结果晚到
  await flush();
  assert.deepEqual(state.messageList, ORDINARY); // 未应用
  assert.equal(state.isLoading, true);

  api.resolve(1, PAGE1, { hasMore: true });
  await flush();
  assert.equal(state.messageList[0].list[0], PAGE1[0]);
  assert.equal(state.isLoading, false);
  adapter.disable();
});

test('响应 echo scope 不符（peerUid/chatType 回带错误）→ 丢弃，不污染列表', async () => {
  const { component, state } = makeComponent();
  const api = makeApi({ manual: true });
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  api.resolve(0, PAGE1, { hasMore: true }, { peerUid: 'peerB' }); // 回声 peer 不符
  await flush();
  assert.deepEqual(state.messageList, ORDINARY);
  assert.equal(state.isLoading, false); // rejected response completes this request

    adapter.disable();
});

test('loadMore 按 date 合并、保留原 record、offset 推进、hasMore=false 后不再发请求', async () => {
  const { component, state } = makeComponent();
  const api = makeApi();
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  assert.equal(api.calls.length, 1);

  adapter.loadMore();
  await flush();
  assert.deepEqual(state.messageList.map((g) => g.date), ['2026/10/17', '2026/10/16', '2026/10/15']);
  assert.equal(state.messageList.find((g) => g.date === '2026/10/15').list[0], PAGE2[0]);
  assert.equal(api.calls.at(-1).offset, 3);
  assert.equal(state.isFinished, true);

  adapter.loadMore(); // hasMore=false → no-op
  await flush();
  assert.equal(api.calls.length, 2);
  adapter.disable();
});

test('active 期间原生后台写被忽略（含 computed 新引用下仍保持）；off 后透传恢复', async () => {
  const { component, store, state, counters } = makeComponent();
  const api = makeApi();
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  const applied = state.messageList;

  store.setMessageList(ORDINARY);
  store.setFilteredMsgList(ORDINARY);
  store.updateMessageList(ORDINARY);
  store.clearMessageList();
  store.handleMsgQueryResult(ORDINARY);
  store.messageList = ORDINARY; // 绕过方法的直接赋值 → active 下同样忽略
  store.isFinished = true;
  store.isLoading = true;
  await flush();
  assert.equal(counters.setMessageList + counters.setFilteredMsgList + counters.updateMessageList + counters.clearMessageList + counters.handleMsgQueryResult, 0);
  assert.equal(state.messageList, applied); // guard 生效，未被写穿
  assert.equal(state.isFinished, false);    // 访问器直接赋值也被忽略
  assert.equal(state.isLoading, false);
  assert.equal(store.messageList, applied); // getter 原样透传

  adapter.disable();
  store.setMessageList(ORDINARY); // off → 透传
  assert.equal(counters.setMessageList, 1);
  assert.deepEqual(state.messageList, ORDINARY);
  store.isFinished = true; // 描述符恢复后直接赋值生效
  assert.equal(state.isFinished, true);
});

test('getMoreMsg/getMoreMsgWithFilter 非 active 纯透传；active 由插件接管翻页', async () => {
  const { component, store, counters } = makeComponent();
  const api = makeApi();
  assert.equal(await store.getMoreMsg(), 'native-more'); // inactive 透传
  assert.equal(await store.getMoreMsgWithFilter(), 'native-more-filter');
  assert.equal(counters.getMoreMsg, 2);

  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  await store.getMoreMsg(); // active → 插件 more 查询
  await flush();
  assert.equal(counters.getMoreMsg, 2); // native backing 未被调用
  assert.equal(api.calls.at(-1).offset, 3);
  adapter.disable();
  assert.equal(await store.getMoreMsg(), 'native-more'); // 恢复后仍透传
  assert.equal(counters.getMoreMsg, 3);
});

test('不自动订阅新撤回（recallHistoryChanged 由 UI 主处理，适配器从不调用）', async () => {
  const { component } = makeComponent();
  const api = makeApi();
  api.recallHistoryChanged = () => { api.recallHistoryChangedCalls++; return () => {}; };
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  adapter.refresh();
  await flush();
  adapter.disable();
  adapter.dispose();
  assert.equal(api.recallHistoryChangedCalls, 0);
});

test('api 报错 → onState.error 上报、native 列表不被破坏', async () => {
  const { component, state } = makeComponent();
  const { onState, events } = collector();
  const api = makeApi({ manual: true });
  const adapter = createRecordStoreAdapter({ component, api, onState });
  assert.equal(adapter.enable(), true);
  await flush();
  api.reject(0, new Error('boom'));
  await flush();
  assert.ok(events.some((e) => e.active === true && typeof e.error === 'string' && e.error.includes('boom')));
  assert.deepEqual(state.messageList, ORDINARY); // 失败时不清原生列表
  adapter.disable();
});

test('raw record 全程不被改动；unmount 拒绝启用；dispose 幂等', async () => {
  const { component } = makeComponent();
  const api = makeApi();
  const rawSnapshot = JSON.parse(JSON.stringify([...PAGE1, ...PAGE2]));
  const adapter = createRecordStoreAdapter({ component, api });
  assert.equal(adapter.enable(), true);
  await flush();
  adapter.loadMore();
  await flush();
  adapter.disable();
  adapter.dispose();
  adapter.dispose();
  assert.deepEqual([...PAGE1, ...PAGE2], rawSnapshot); // 不改原消息
  assert.equal(adapter.active, false);

  component.isUnmounted = true;
  const adapter2 = createRecordStoreAdapter({ component, api });
  assert.equal(adapter2.enable(), false);
});

test('回归（Proxy reactive store）：writeStoreValue 经 store[name]=value 触发 Proxy.set 通知、native computed 同步；旧 savedDescriptor.set.call(proxy,…) 不通知 → 视图失更新', async () => {
  const raw = makeComponent();
  // 模拟 Vue reactive：目标对象上是 own 原生访问器（setter 只写 backing closure state，不通知），
  // Proxy.set trap 在 Reflect.set 后负责 trigger —— 通知订阅视图失效。
  const reactiveKeys = new Set(['messageList', 'isFinished', 'isLoading', 'lastMsg', 'searchMore', 'counts']);
  const notifications = [];
  let viewDirty = true;
  let viewRows = null;
  const storeProxy = new Proxy(raw.store, {
    set(target, key, value, receiver) {
      const ok = Reflect.set(target, key, value, receiver);
      if (reactiveKeys.has(key)) { notifications.push(key); viewDirty = true; }
      return ok;
    },
  });
  raw.proxy.store = storeProxy; // 实机形态：component.proxy.store 是 reactive Proxy

  // native computed：只在响应式 trigger（通知）后重算 store.messageList，否则返回缓存
  const nativeView = () => {
    if (viewDirty) {
      const list = storeProxy.messageList;
      viewRows = (Array.isArray(list) ? list : []).map((g) => `${g.date}:${(g.list || []).map((r) => r.msgId).join(',')}`);
      viewDirty = false;
    }
    return viewRows;
  };
  const msgListWrites = () => notifications.filter((k) => k === 'messageList').length;

  assert.deepEqual(nativeView(), ['2026/10/17:o1', '2026/10/16:o2']); // 初始原生视图（warm computed）

  const origListDesc = { ...Object.getOwnPropertyDescriptor(storeProxy, 'messageList') }; // 旧 adapter 的 savedDescriptor

  const adapter = createRecordStoreAdapter({ component: raw.component, api: makeApi() });
  assert.equal(adapter.enable(), true);
  await flush();
  assert.equal(msgListWrites(), 1, 'enable 接收首页：插件写 messageList 经 Proxy.set → 恰一次通知');
  assert.deepEqual(nativeView(), ['2026/10/17:m4,m3', '2026/10/16:m2'], '通知触发重算 → native 视图 rows 变为插件 records');

  adapter.loadMore();
  await flush();
  assert.equal(msgListWrites(), 2, 'loadMore：同样经 Proxy.set 通知');
  assert.deepEqual(nativeView(), ['2026/10/17:m4,m3', '2026/10/16:m2', '2026/10/15:m1'], '翻页结果同步进 native 视图');

  adapter.disable();
  assert.equal(msgListWrites(), 3, 'disable 恢复原生快照：同样经 Proxy.set 通知');
  assert.deepEqual(nativeView(), ['2026/10/17:o1', '2026/10/16:o2'], 'native 视图恢复原生数据');

  // 根因回归：旧实现 savedDescriptor.set.call(proxy, value) 直接调原生 setter（只写 backing），
  // 完全绕过 Proxy.set → 零通知 → computed 不失效，数据已变而视图停留旧值。
  const nBefore = notifications.length;
  const staleView = nativeView();
  const ghost = [{ date: '1999/01/01', list: [{ msgId: 'ghost', msgSeq: 1, msgTime: 1, elements: [] }] }];
  origListDesc.set.call(storeProxy, ghost);
  assert.equal(notifications.length, nBefore, 'setter.call(proxy,…) 绕过 Proxy.set：零通知（bug 根因）');
  assert.equal(nativeView(), staleView, '无通知 → computed 未重算（同一缓存引用）→ 视图仍是旧 rows');
  assert.deepEqual(storeProxy.messageList, ghost, 'backing 实际已变：数据与 native 视图脱节');
});
