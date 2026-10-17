#!/usr/bin/env node
/**
 * tests/test-native-record-filter.mjs — 原生 #/record「仅看撤回」record store 适配端到端测试（零 npm 依赖）。
 *
 * 驱动 tests/fixtures/native-record-filter.html（mock 原生 reactive store / __VUE__ 组件 /
 * window.anti_recall），加载真实 windowLauncher.js + recordStoreAdapter.js，验证：
 * 聊天主路由无入口无面板；#/record 显示 toggle；开启后原生列表替换为撤回 raw 记录
 * （msgId/msgSeq 保持 string、原 targetToChat 跳转原样）；原生关键词变动经适配筛选；
 * 普通消息/DOM 变更零查询；newRecall 仅显示更新按钮不自动查询；关闭恢复原生记录与描述符。
 *
 * 用法（复用已运行的 preview 静态服务，不自行起服务）：
 *   node tests/test-native-record-filter.mjs
 *   BASE_URL=http://127.0.0.1:8746 CHROME_BIN=/path/to/chrome node tests/test-native-record-filter.mjs
 *
 * 退出码：0 通过；1 断言失败；3 找不到 Chrome；4 夹具/服务/驱动故障。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8746";
const FIXTURE_URL = BASE_URL + "/tests/fixtures/native-record-filter.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

async function launchChrome(chromeBin) {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "arh-nrf-test-"));
  const devtoolsFile = path.join(userDataDir, "DevToolsActivePort");
  for (const headlessFlag of ["--headless=new", "--headless"]) {
    const child = spawn(chromeBin, [
      headlessFlag, "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--window-size=1280,900", "about:blank",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const start = Date.now();
    while (Date.now() - start < 20000) {
      try {
        const st = await fsp.stat(devtoolsFile);
        if (st.size > 0) {
          const port = Number((await fsp.readFile(devtoolsFile, "utf8")).split("\n")[0].trim());
          if (port > 0) return { child, port };
        }
      } catch {}
      await sleep(200);
    }
    child.kill("SIGTERM");
    await sleep(300);
  }
  throw new Error("Chrome DevToolsActivePort 未出现");
}

class Cdp {
  constructor(wsUrl) {
    this.nextId = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.openP = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP ws error")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.openP;
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function run() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.log("SKIP_NATIVE_RECORD_FILTER: 未找到 Chrome（可用 CHROME_BIN 指定）");
    process.exit(3);
  }
  let child, port;
  try {
    ({ child, port } = await launchChrome(chromeBin));
  } catch (e) {
    console.error("DRIVER_ERROR -", e.message);
    process.exit(4);
  }
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page || !page.webSocketDebuggerUrl) throw new Error("无页面 CDP target");
    const cdp = new Cdp(page.webSocketDebuggerUrl);

    const ev = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error("page eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result?.value;
    };
    const j = async (expr) => JSON.parse(await ev("JSON.stringify(" + expr + ")"));
    const waitFor = async (expr, ms = 6000, label = expr) => {
      const t0 = Date.now();
      for (;;) {
        if (await ev(`Boolean(${expr})`)) return;
        if (Date.now() - t0 > ms) throw new Error("等待超时: " + label);
        await sleep(60);
      }
    };

    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: FIXTURE_URL });
    await sleep(300);
    await waitFor("window.__TEST_STATE && window.__TEST_STATE.ready === true", 10000, "fixture ready");
    const boot = await ev("window.__TEST_STATE.bootError");
    if (boot) throw new Error("fixture 导入 windowLauncher 失败: " + boot);

    const results = [];
    let failures = 0;
    const check = (name, ok, detail) => {
      ok = Boolean(ok);
      if (!ok) failures++;
      results.push({ name, ok });
      console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok || !detail ? "" : " :: " + detail}`);
    };

    /* 1. 聊天主路由：安装后无入口无面板 */
    await ev("window.__installHistoryWindowLauncher()");
    await sleep(120);
    const s1 = await j(`(() => ({
      entry: !!document.querySelector(".anti-recall-history-entry"),
      antiRecallNodes: document.querySelectorAll("[class*='anti-recall']").length,
      recordPageVisible: !document.getElementById("record-page").hidden,
    }))()`);
    check("聊天主路由无入口且无面板", !s1.entry && s1.antiRecallNodes === 0 && !s1.recordPageVisible, JSON.stringify(s1));

    /* 2. #/record：toggle 出现，初始原生记录 */
    await ev("location.hash = '#/record'");
    await waitFor("!!document.querySelector('.anti-recall-history-entry')");
    const s2 = await j(`(() => {
      const b = document.querySelector(".anti-recall-history-entry");
      return { text: b.textContent, pressed: b.getAttribute("aria-pressed"), viewIds: window.__flat().join(",") };
    })()`);
    check("#/record 显示仅看撤回 toggle（初始原生记录）", s2.text.indexOf("仅看撤回") === 0 && s2.pressed === "false" && s2.viewIds === "native-1,native-2", JSON.stringify(s2));

    /* 3. 开启：原生非撤回列表被替换为撤回 raw 记录 */
    await ev("document.querySelector('.anti-recall-history-entry').click()");
    await waitFor("window.__TEST_STATE.apiCalls.length === 1 && window.__TEST_STATE.view.ids.length === 3 && window.__flat().length === 3");
    const s3 = await j(`(() => {
      const raw = window.__rawStoreRecords();
      const b = document.querySelector(".anti-recall-history-entry");
      return {
        viewIds: window.__TEST_STATE.view.ids.join(","),
        stringTypes: raw.every(r => typeof r.msgId === "string" && typeof r.msgSeq === "string"),
        sameRefs: raw.some(r => window.__RECALLED_REF.includes(r)),
        query: window.__TEST_STATE.apiCalls[0],
        pressed: b.getAttribute("aria-pressed"),
        jumpSame: document.querySelector(".record-all-msg").__VUE__[0].ctx.targetToChat === window.__NATIVE_TARGET_TO_CHAT,
      };
    })()`);
    check("开: 原生列表替换为撤回 raw 记录（string 类型、引用不克隆）", s3.viewIds === "recall-1001,recall-1002,recall-1003" && s3.stringTypes && s3.sameRefs, JSON.stringify({ viewIds: s3.viewIds, stringTypes: s3.stringTypes, sameRefs: s3.sameRefs }));
    check("开: 查询范围正确（peerUid g / chatType 2 / keyword 空 / offset 0）", s3.query.peerUid === "g" && s3.query.chatType === 2 && s3.query.keyword === "" && s3.query.offset === 0, JSON.stringify(s3.query));
    check("开: ctx.targetToChat 原函数未被替换且 toggle 置 on", s3.jumpSame && s3.pressed === "true", JSON.stringify({ jumpSame: s3.jumpSame, pressed: s3.pressed }));

    /* 4. 撤回行点击走原 targetToChat，raw id/seq 原样（合成数据） */
    await ev("document.querySelector(\".record-item[data-msg-id='recall-1002']\").click()");
    const s4 = await j(`window.__TEST_STATE.jumps[window.__TEST_STATE.jumps.length - 1]`);
    check("点击撤回行走原 targetToChat，raw id/seq 原样", s4 && s4.msgId === "recall-1002" && s4.msgSeq === "8" && typeof s4.msgId === "string", JSON.stringify(s4));

    /* 5. 普通 DOM 变更：零查询 */
    const callsBefore = await ev("window.__TEST_STATE.apiCalls.length");
    await ev("(() => { const d = document.createElement('div'); d.className = 'plain-native-churn'; document.body.appendChild(d); return d.className; })()");
    await sleep(280);
    const callsAfter = await ev("window.__TEST_STATE.apiCalls.length");
    check("普通消息/DOM 变更不触发查询 API", callsBefore === 1 && callsAfter === 1, `before=${callsBefore} after=${callsAfter}`);

    /* 6. 原生关键词变动：经适配器查询筛选，原生 getMsgByKeyWord 不直接执行 */
    await ev("window.__nativeKeywordChange('专有词')");
    await waitFor("window.__TEST_STATE.apiCalls.length === 2 && window.__TEST_STATE.view.ids.join(',') === 'recall-1001,recall-1003'", 6000, "keyword filtered view");
    const s6 = await j(`(() => ({
      q: window.__TEST_STATE.apiCalls[1],
      nativeKw: window.__TEST_STATE.nativeCalls.filter(c => c.fn === "getMsgByKeyWord").length,
    }))()`);
    check("active 时原生关键词变动经适配查询并筛选", s6.q.keyword === "专有词" && s6.nativeKw === 0, JSON.stringify(s6));

    /* 7. newRecall：仅显示更新按钮，不自动查询 */
    await ev("window.__emitRecallChanged({ peerUid: 'g', chatType: 2 }, { addNew: true })");
    await sleep(320);
    const s7 = await j(`(() => {
      const u = document.querySelector(".anti-recall-native-update");
      return { updMissing: !u, hidden: u && u.hidden, rects: u ? u.getClientRects().length : 0, calls: window.__TEST_STATE.apiCalls.length };
    })()`);
    check("newRecall 仅显示更新按钮且不自动查询", !s7.updMissing && s7.hidden === false && s7.rects > 0 && s7.calls === 2, JSON.stringify(s7));

    /* 8. 点击更新：显式重查 offset 0，出现新撤回记录，按钮复原隐藏 */
    await ev("document.querySelector('.anti-recall-native-update').click()");
    await waitFor("window.__TEST_STATE.apiCalls.length === 3 && window.__TEST_STATE.view.ids.includes('recall-1004')", 6000, "refresh view");
    const s8 = await j(`(() => ({
      off: window.__TEST_STATE.apiCalls[2].offset,
      kw: window.__TEST_STATE.apiCalls[2].keyword,
      updHidden: document.querySelector(".anti-recall-native-update").hidden,
    }))()`);
    check("点击更新显式重查（offset 0、按钮复原隐藏）", s8.off === 0 && s8.kw === "专有词" && s8.updHidden === true, JSON.stringify(s8));

    /* 9. 关闭：恢复原生记录与描述符；关键词变过 → 原生 getMsg 自查恢复筛选 */
    await ev("document.querySelector('.anti-recall-history-entry').click()");
    await waitFor("window.__TEST_STATE.view.ids.join(',') === 'native-2' && window.__TEST_STATE.nativeCalls.some(c => c.fn === 'getMsg' && c.args[0] && c.args[0].keyword === '专有词')", 8000, "restored native view");
    const s9 = await j(`(() => {
      const store = window.__TEST_STORE;
      const d = Object.getOwnPropertyDescriptor(store, "getMsg");
      const m = Object.getOwnPropertyDescriptor(store, "messageList");
      const b = document.querySelector(".anti-recall-history-entry");
      return {
        viewIds: window.__TEST_STATE.view.ids.join(","),
        getMsgRestored: !!(d && d.get && d.get() === window.__NATIVE_GET_MSG),
        mlDescRestored: !!(m && m.get === window.__NATIVE_ML_DESC.get && m.set === window.__NATIVE_ML_DESC.set),
        kwRestored: store.getMsgByKeyWord === window.__NATIVE_KW_FN,
        pressed: b.getAttribute("aria-pressed"),
        text: b.textContent,
      };
    })()`);
    check("关: 恢复原生记录与描述符（getMsg 访问器 / messageList 访问器 / 关键词原生函数）", s9.viewIds === "native-2" && s9.getMsgRestored && s9.mlDescRestored && s9.kwRestored, JSON.stringify(s9));
    check("关: toggle 复位为未激活", s9.pressed === "false" && s9.text.indexOf("仅看撤回") === 0, JSON.stringify({ pressed: s9.pressed, text: s9.text }));

    /* 10. 离开 record 路由：入口与 UI 全部移除 */
    await ev("location.hash = '#/main/message'");
    await waitFor("!document.querySelector('.anti-recall-history-entry') && document.getElementById('record-page').hidden", 6000, "leave route");
    const s10 = await ev("document.querySelectorAll(\"[class*='anti-recall']\").length");
    check("离开 record 路由入口与 UI 全部移除", s10 === 0, "left=" + s10);

    console.log(`\n${failures === 0 ? "NATIVE_RECORD_FILTER_TEST_OK" : "NATIVE_RECORD_FILTER_TEST_FAILED"} — ${results.length - failures}/${results.length} 通过`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error("DRIVER_ERROR -", e.message);
    process.exitCode = 4;
  } finally {
    try { child.kill("SIGTERM"); } catch {}
  }
}

run();
