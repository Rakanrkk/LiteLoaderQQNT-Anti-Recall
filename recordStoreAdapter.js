/**
 * recordStoreAdapter.js — QQ 原生 #/record「仅看撤回」record store 适配器（ESM）
 *
 * 用法：
 *   import { createRecordStoreAdapter, groupNativeRecords } from './recordStoreAdapter.js';
 *   const adapter = createRecordStoreAdapter({ component: c, api, onState });
 *   adapter.enable();    // 进入仅看撤回（接管 store 数据源）
 *   adapter.refresh();   // offset 0 重查
 *   adapter.loadMore();  // 追加翻页（按日期合并）
 *   adapter.disable();   // 退出：恢复描述符 + 原生状态快照
 *   adapter.dispose();   // unmount 时调用（内部先 disable）
 *   adapter.active       // 是否接管中
 *
 * 实机契约（2026-10-17 实测）：
 * - store.messageList = [{date:'YYYY/MM/DD', list:[full raw msgrecord]}]，date 必须斜杠格式；
 *   list 元素即原生 raw record（msgId/msgSeq/elements，无 wrapper），原生渲染与 jump 不变。
 * - props.chatInfo={chatType,peerUid,privilegeFlag}；c.proxy.queryParams.peer={chatType,peerUid}
 *   （对象！）；c.props.keyword 原生字符串；queryFilterParams.filterSendersUid/filterMsgType 为
 *   computed 数组（每次访问新引用，比较必须按值）。
 * - messageList/isFinished/isLoading 为 configurable get/set 访问器；getMsg/getMoreMsg/
 *   setMessageList 为 own accessor（get 返回 backing fn，禁止用其 set 改 backing）；其余 base
 *   方法普通 writable，可覆写。toString 全 native，不可读源码。
 *
 * 约束：
 * - 仅覆盖本组件 store 实例属性（defineProperty + 描述符快照，可完整恢复），无全局 proxy。
 * - 不触碰 targetToChat / ctx 组件方法；native jump 函数原样。
 * - active 期间忽略原生后台写（guard 方法）；插件写回只经快照的原生 messageList/isFinished/
 *   isLoading setter，不走被 guard 的方法。
 * - 非 active 时全部纯透传：普通消息流不触发 query/clear；不自动订阅新撤回推送（由 UI 主处理）。
 * - off 时恢复描述符与原生快照；若 keyword/filter 范围在 active 期间变过，恢复后调用一次原生
 *   getMsg(c.proxy.queryParams)（或 initRecordData）让 QQ 自身筛选恢复正常。
 * - 响应做 strict echo scope 校验（peerUid/chatType 与请求不一致的响应直接丢弃）。
 */

const DEFAULT_LIMIT = 50;

// reset 类查询方法：同一 tick 内多次触发合并为一次查询（microtask debounce）
const RESET_METHODS = ['getMsg', 'getFirstScreenMsgWithFilter', 'getMsgByKeyWord', 'startFilterQuery', 'invokeFilterQuery'];
// 翻页类方法
const MORE_METHODS = ['getMoreMsg', 'getMoreMsgWithFilter', 'getMoreSearchMsg'];
// active 期间需要忽略的原生后台写方法
const WRITE_GUARD_METHODS = ['setMessageList', 'setFilteredMsgList', 'updateMessageList', 'handleMsgQueryResult', 'applyFilterQueryResult', 'clearMessageList'];
// 需要快照并在 off 时恢复的原生状态值
const STATE_VALUE_NAMES = ['messageList', 'isFinished', 'isLoading', 'lastMsg', 'searchMore', 'msgCount', 'counts'];
// own accessor 形态（get 返回 backing function）的方法：保持访问器形态覆盖，绝不调用其 set
const ACCESSOR_METHODS = new Set(['getMsg', 'getMoreMsg', 'setMessageList']);
// scope 参与比较的字段
const SCOPE_KEYS = ['peerUid', 'chatType', 'keyword', 'filterSendersUid', 'filterMsgFromTime', 'filterMsgToTime'];

function ownDesc(obj, name) {
  try { return Object.getOwnPropertyDescriptor(obj, name) || null; } catch { return null; }
}

function safeGet(obj, name, d) {
  try { return d && d.get ? d.get.call(obj) : obj[name]; } catch { return undefined; }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 严格字符串（空串合法；非 string 返回 null 走下一来源） */
function pickString(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * 值稳定比较：computed 数组每次新引用也按值比较（数组元素顺序不敏感）。
 * 仅用于 scope/filter 判断，不参与任何数据写入。
 */
function stableKey(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableKey).sort().join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
}

function scopeChanged(a, b) {
  if (!a || !b) return false;
  return SCOPE_KEYS.some((k) => stableKey(a[k]) !== stableKey(b[k]));
}

/** 从原生 raw record 中自适应提取时间（数值/数字串优先，秒/毫秒自适应，字符串可解析兜底）→ 毫秒；无时间返回 0 */
export function pickRecordTimeMs(record) {
  if (!record || typeof record !== 'object') return 0;
  for (const key of ['msgTime', 'msgTimeMs', 'msgTimeStamp', 'sendTime', 'time', 'timestamp', 'createdAt']) {
    const v = record[key];
    if (v == null) continue;
    let n = Number(v); // 数字与数字串（'1792…'）一律先 Number，避免 Date.parse 误判
    if (!Number.isFinite(n) || n <= 0) {
      if (typeof v !== 'string') continue;
      n = Date.parse(v.trim().replace(/-/g, '/'));
      if (!Number.isFinite(n) || n <= 0) continue;
    }
    if (n < 1e12) n *= 1000; // 秒 → 毫秒
    return n;
  }
  return 0;
}

/** 毫秒 → 原生 date 字符串，默认本地 'YYYY/MM/DD'（斜杠格式，实机要求） */
export function formatNativeDate(ms, dateFormat = 'YYYY/MM/DD') {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const Y = String(d.getFullYear());
  const M = pad2(d.getMonth() + 1);
  const D = pad2(d.getDate());
  return String(dateFormat).replace(/YYYY/g, Y).replace(/MM/g, M).replace(/DD/g, D);
}

/**
 * 把原生 raw records 按日期分组为 [{date,list}]（日期新→旧）。
 * 保留 record 对象引用（不克隆、不包 wrapper），native 渲染/jump 直接可用。
 * dateFormat 可按实机调整（默认 'YYYY/MM/DD'）。
 */
export function groupNativeRecords(records, dateFormat = 'YYYY/MM/DD') {
  const groups = [];
  const byDate = new Map();
  for (const rec of Array.isArray(records) ? records : []) {
    const date = formatNativeDate(pickRecordTimeMs(rec), dateFormat);
    let g = byDate.get(date);
    if (!g) {
      g = { date, list: [] };
      byDate.set(date, g);
      groups.push(g);
    }
    g.list.push(rec);
  }
  groups.sort((a, b) => b.date.localeCompare(a.date));
  return groups;
}

/** 翻页追加：按 date 合并新旧分组，保留原 record 引用，生成新分组对象保证响应式更新 */
function mergeGroups(oldGroups, addGroups) {
  const byDate = new Map();
  const order = [];
  for (const g of Array.isArray(oldGroups) ? oldGroups : []) {
    byDate.set(g.date, Array.isArray(g.list) ? [...g.list] : []);
    order.push(g.date);
  }
  for (const g of Array.isArray(addGroups) ? addGroups : []) {
    if (byDate.has(g.date)) byDate.get(g.date).push(...(g.list || []));
    else {
      byDate.set(g.date, [...(g.list || [])]);
      order.push(g.date);
    }
  }
  order.sort((a, b) => b.localeCompare(a));
  return order.map((date) => ({ date, list: byDate.get(date) }));
}

/**
 * @param {object} options.component 实机 c（__VUE__ 实例，c.proxy.store 单实例）
 * @param {object} options.api  { getNativeRecallRecords(query) -> {peerUid,chatType,records:[raw],total,hasMore,offset,limit} }
 *                                （新撤回推送/提示由 UI 主处理，适配器不订阅）
 * @param {function} [options.onState]  汇报 {active,loading,total,hasMore,error}
 * @param {number}   [options.limit]    每页条数，默认 50
 * @param {string}   [options.dateFormat] 默认 'YYYY/MM/DD'
 */
export function createRecordStoreAdapter({ component, api, onState, limit = DEFAULT_LIMIT, dateFormat = 'YYYY/MM/DD' }) {
  let active = false;
  let applyingStore = false;
  let disposed = false;
  let store = null;
  let epoch = 0;          // 请求代数：新查询使旧在途结果作废
  let offset = 0;
  let loading = false;
  let total = 0;
  let hasMore = false;
  let error = null;
  let appliedGroups = [];
  let enableScope = null;   // enable 时的范围快照（off 恢复判断用）
  let enableFilter = null;  // enable 时 queryFilterParams 相关字段快照（仅 off 恢复判断，不阻止运行中筛选）
  let resetScheduled = false;
  let pendingHint;
  let lastEmitted = '';

  const propSnapshots = [];       // { name, orig: descriptor|null }（orig=null 表示原本非 own，恢复时 delete）
  const savedValues = new Map();  // name -> enable 时原生状态值
  const savedDescs = new Map();   // name -> enable 时原生描述符（用其 set 写回，不经 guard 方法）

  function emit() {
    if (typeof onState !== 'function') return;
    const s = { active, loading, total, hasMore, error };
    const key = JSON.stringify(s);
    if (key === lastEmitted) return;
    lastEmitted = key;
    try { onState({ ...s }); } catch { /* onState 异常不影响适配器 */ }
  }

  /**
   * 读取当前查询范围：优先 getMsg/startFilterQuery 传入的 hint（queryParams / 关键字字符串），
   * 否则组件 props。peerUid/chatType 严格取 string/number（qp.peer 是 {chatType,peerUid} 对象）。
   */
  function readScope(hint) {
    const props = component?.props || {};
    const proxy = component?.proxy || {};
    const isObjHint = hint && typeof hint === 'object';
    const qp = Object.assign({}, proxy.queryParams || {}, isObjHint ? hint : {});
    const chat = props.chatInfo || qp.chatInfo || {};
    const peerObj = qp.peer && typeof qp.peer === 'object' ? qp.peer : {};
    const peerUid = pickString(chat.peerUid) ?? pickString(peerObj.peerUid) ?? '';
    const chatType = chat.chatType ?? qp.chatType ?? qp.type ?? peerObj.chatType ?? 0;
    const keyword = pickString(typeof hint === 'string' ? hint : undefined)
      ?? pickString(qp.keyword)
      ?? pickString(props.keyword)
      ?? pickString(component?.parent?.props?.keyword)
      ?? '';
    const qfp = Object.assign({}, proxy.queryFilterParams || {}, isObjHint ? hint : {});
    return {
      peerUid,
      chatType,
      keyword,
      filterSendersUid: qfp.filterSendersUid ?? null,
      filterMsgFromTime: qfp.filterMsgFromTime ?? null,
      filterMsgToTime: qfp.filterMsgToTime ?? null,
    };
  }

  /** 查询发起后范围是否又变了（按值比较，computed 新引用不触发）；变了则丢弃该结果，等新 reset */
  function scopeChangedSince(scope) {
    return scopeChanged(scope, readScope());
  }

  /** off 恢复判断：active 期间 keyword/filter（含 computed 数组，按值）或范围是否变过 */
  function scopeDifferFromEnable() {
    if (enableScope && scopeChanged(enableScope, readScope())) return true;
    if (enableFilter) {
      const cur = component?.proxy?.queryFilterParams || {};
      for (const k of ['filterSendersUid', 'filterMsgFromTime', 'filterMsgToTime']) {
        if (stableKey(enableFilter[k]) !== stableKey(cur[k])) return true;
      }
    }
    return false;
  }

  /** 通过快照的原生访问器/可写属性写回状态值（不走被 guard 的方法） */
  function writeStoreValue(name, value) {
    const d = savedDescs.get(name);
    try {
      applyingStore = true;
      if ((d && d.set) || (d && d.writable)) store[name] = value;
      else if (!d) store[name] = value;
    } finally {
      applyingStore = false;
    }
  }

  function snapshotAndOverride(name, makeDescriptor) {
    const orig = ownDesc(store, name);
    propSnapshots.push({ name, orig: orig ? { ...orig } : null });
    Object.defineProperty(store, name, makeDescriptor(orig));
  }

  function callOriginal(orig, thisArg, args) {
    if (!orig) return undefined;
    const fn = orig.get ? orig.get.call(thisArg) : orig.value;
    if (typeof fn !== 'function') return undefined;
    return fn.apply(thisArg, args);
  }

  /** 同一 tick 的多次 reset 合并为一次（microtask debounce） */
  function scheduleReset(hint) {
    if (!active) return;
    if (arguments.length > 0) pendingHint = hint;
    if (resetScheduled) return;
    resetScheduled = true;
    queueMicrotask(() => {
      resetScheduled = false;
      const h = pendingHint;
      pendingHint = undefined;
      if (active) runQuery('reset', h);
    });
  }

  function runQuery(kind, hint) {
    if (!active) return Promise.resolve();
    if (kind === 'more' && (loading || !hasMore)) return Promise.resolve();
    const scope = readScope(hint);
    const qOffset = kind === 'reset' ? 0 : offset;
    const myEpoch = ++epoch;
    loading = true;
    error = null;
    emit();
    writeStoreValue('isLoading', true);
    let promise;
    try {
      promise = api.getNativeRecallRecords({
        peerUid: scope.peerUid,
        chatType: scope.chatType,
        keyword: scope.keyword,
        filterSendersUid: scope.filterSendersUid,
        filterMsgFromTime: scope.filterMsgFromTime,
        filterMsgToTime: scope.filterMsgToTime,
        offset: qOffset,
        limit,
      });
    } catch (e) {
      promise = Promise.reject(e);
    }
    return Promise.resolve(promise).then((res) => {
      if (!active || myEpoch !== epoch) return;        // stale / 已关闭：旧请求代数直接丢弃
      // strict echo scope 校验：响应必须回带一致的 peerUid/chatType
      if (!res || typeof res !== 'object') return;
      if (typeof res.peerUid !== 'string' || res.peerUid !== scope.peerUid) return;
      if (res.chatType == null || Number(res.chatType) !== Number(scope.chatType)) return;
      if (scopeChangedSince(scope)) return;            // 范围已切换，等新的 reset
      const records = Array.isArray(res.records) ? res.records : [];
      total = res.total ?? records.length;
      hasMore = !!res.hasMore;
      offset = qOffset + records.length;
      appliedGroups = kind === 'reset'
        ? groupNativeRecords(records, dateFormat)
        : mergeGroups(appliedGroups, groupNativeRecords(records, dateFormat));
      writeStoreValue('messageList', appliedGroups);   // 原生 {date,list} 分组，渲染/jump 不变
      writeStoreValue('isFinished', !hasMore);
    }).catch((e) => {
      if (!active || myEpoch !== epoch) return;
      error = e && e.message ? String(e.message) : String(e);
      hasMore = false;
      writeStoreValue('isFinished', true);
    }).finally(() => {
      if (!active || myEpoch !== epoch) return;
      loading = false;
      writeStoreValue('isLoading', false);
      emit();
    });
  }

  function enable() {
    if (active || disposed) return false;
    store = component?.proxy?.store ?? component?.store ?? null;
    if (!store || component?.isUnmounted === true) return false;

    active = true;
    epoch++;
    offset = 0;
    loading = false;
    total = 0;
    hasMore = false;
    error = null;
    appliedGroups = [];
    enableScope = readScope();
    const qfp = component?.proxy?.queryFilterParams;
    enableFilter = qfp ? {
      filterSendersUid: qfp.filterSendersUid,
      filterMsgFromTime: qfp.filterMsgFromTime,
      filterMsgToTime: qfp.filterMsgToTime,
    } : null;

    // 1. 快照原生状态值与描述符（off 时按原样恢复）
    for (const name of STATE_VALUE_NAMES) {
      const d = ownDesc(store, name);
      if (!d) continue;
      savedDescs.set(name, { ...d });
      savedValues.set(name, safeGet(store, name, d));
    }

    // 2. 先取消旧的 native 在途响应
    try { store.cancelPendingRequests?.(); } catch { /* 忽略 */ }

    // 3. 覆盖方法（wrapper 内部按 active 分支；非 active 纯透传）
    const makeReset = (orig) => function (...args) {
      if (!active) return callOriginal(orig, this, args);
      scheduleReset(args[0]);
      return Promise.resolve();
    };
    const makeMore = (orig) => function (...args) {
      if (!active) return callOriginal(orig, this, args);
      if (loading || !hasMore) return Promise.resolve();
      return runQuery('more', args[0]);
    };
    const makeGuard = (orig) => function (...args) {
      if (!active) return callOriginal(orig, this, args);
      return undefined; // active 期间忽略原生后台写
    };
    const accessorDesc = (fn, orig) => ({
      get: () => fn,
      set: orig?.set,
      configurable: true,
      enumerable: orig ? orig.enumerable : true,
    });
    const valueDesc = (fn, orig) => ({
      value: fn,
      writable: true,
      configurable: true,
      enumerable: orig ? orig.enumerable : true,
    });

    for (const name of RESET_METHODS) snapshotAndOverride(name, (orig) => (ACCESSOR_METHODS.has(name) ? accessorDesc(makeReset(orig), orig) : valueDesc(makeReset(orig), orig)));
    for (const name of MORE_METHODS) snapshotAndOverride(name, (orig) => (ACCESSOR_METHODS.has(name) ? accessorDesc(makeMore(orig), orig) : valueDesc(makeMore(orig), orig)));
    for (const name of WRITE_GUARD_METHODS) snapshotAndOverride(name, (orig) => (ACCESSOR_METHODS.has(name) ? accessorDesc(makeGuard(orig), orig) : valueDesc(makeGuard(orig), orig)));

    // 3.5 状态访问器 setter 一并 guard：native 在途代码可能直接 store.messageList=… 绕过方法。
    // 插件自身写回走 savedDescs 里的原始 setter，不受影响；getter 原样透传；off 恢复描述符。
    for (const name of STATE_VALUE_NAMES) {
      const orig = savedDescs.get(name);
      if (!orig || !orig.get || !orig.set) continue;
      propSnapshots.push({ name, orig: { ...orig } });
      Object.defineProperty(store, name, {
        get: function () { return orig.get.call(this); },
        set: function (v) { if (!active || applyingStore) orig.set.call(this, v); },
        configurable: true,
        enumerable: orig.enumerable,
      });
    }

    emit();
    scheduleReset(); // 初始查询 offset 0
    return true;
  }

  function restoreDescriptors() {
    for (let i = propSnapshots.length - 1; i >= 0; i--) {
      const { name, orig } = propSnapshots[i];
      try {
        if (orig) Object.defineProperty(store, name, orig);
        else delete store[name]; // hadOwn=false：删除我们的影子属性
      } catch { /* 忽略 */ }
    }
    propSnapshots.length = 0;
  }

  /** keyword/filter 范围在 active 期间变过：恢复后让原生自查一次，保证 QQ 自身筛选状态正常（仅一次） */
  function kickNativeRefreshOnce() {
    try {
      const qp = component?.proxy?.queryParams;
      const d = ownDesc(store, 'getMsg');
      const fn = d && (d.get ? d.get.call(store) : d.value);
      if (typeof fn === 'function' && qp) {
        fn.call(store, qp);
        return;
      }
      if (typeof component?.proxy?.initRecordData === 'function') component.proxy.initRecordData();
    } catch { /* 忽略 */ }
  }

  function disable() {
    if (!active) return false;
    active = false;
    epoch++; // 丢弃在途插件请求
    // 1. 用快照的原生 setter 恢复状态值
    for (const [name, value] of savedValues) writeStoreValue(name, value);
    // 2. 恢复描述符（hadOwn=false 的删除影子属性）→ getMsg/getMoreMsg/setMessageList 等 native 函数原样
    restoreDescriptors();
    savedValues.clear();
    savedDescs.clear();
    // 3. 范围/筛选变过则触发一次原生刷新
    if (scopeDifferFromEnable()) kickNativeRefreshOnce();
    enableScope = null;
    enableFilter = null;
    emit();
    return true;
  }

  return {
    enable,
    disable,
    refresh: () => { if (active) scheduleReset(); return active; },
    loadMore: () => { if (active) runQuery('more'); return active; },
    dispose() {
      if (disposed) return;
      disposed = true;
      disable();
      store = null;
    },
    get active() { return active; },
  };
}
