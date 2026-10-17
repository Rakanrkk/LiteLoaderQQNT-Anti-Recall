"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const PLUGIN_DIR = path.join(
  __dirname,
  ".."
);
const MAIN_PATH = path.join(PLUGIN_DIR, "main.js");
const PRELOAD_PATH = path.join(PLUGIN_DIR, "preload.js");
const RECALL_HISTORY_PATH = path.join(PLUGIN_DIR, "recallHistory.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(25);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared mocks: one temp data dir, one in-memory Level-compatible db, one
// electron mock shared by main.js and preload.js.
// ---------------------------------------------------------------------------

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anti-recall-history-test-"));
const pluginDataDir = path.join(testDataDir, "anti_recall");
const preservedDir = path.join(pluginDataDir, "preserved-images");
fs.mkdirSync(pluginDataDir, { recursive: true });
fs.writeFileSync(
  path.join(pluginDataDir, "config.json"),
  JSON.stringify({
    mainColor: "#ff6d6d",
    saveDb: true,
    enableShadow: true,
    enableTip: true,
    isAntiRecallSelfMsg: false,
    maxMsgSaveLimit: 10000,
    deleteMsgCountPerTime: 500,
  })
);
global.LiteLoader = { path: { data: testDataDir } };

const stored = new Map();
const db = {
  open(callback) { setImmediate(() => callback(null)); },
  put(key, value, callback) {
    stored.set(String(key), JSON.parse(JSON.stringify(value)));
    callback?.(null);
  },
  async get(key) {
    if (!stored.has(String(key))) {
      const error = new Error("NotFound");
      error.notFound = true;
      error.status = 404;
      throw error;
    }
    return JSON.parse(JSON.stringify(stored.get(String(key))));
  },
  async clear() { stored.clear(); },
  async close() {},
  createValueStream() {
    const listeners = new Map();
    const stream = {
      on(name, handler) {
        listeners.set(name, handler);
        if (name === "end") {
          setImmediate(() => {
            for (const value of stored.values()) {
              listeners.get("data")?.(JSON.parse(JSON.stringify(value)));
            }
            handler();
          });
        }
        return stream;
      },
      once(name, handler) { return stream.on(name, handler); },
    };
    return stream;
  },
};

const handlers = new Map();
const appHandlers = new Map();
const ipcListeners = new Map();
const exposedBridges = [];
const ipcRendererSubscriptions = [];
const ipcRendererRemovals = [];
const electronMock = {
  app: { on(name, handler) { appHandlers.set(name, handler); } },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: {
    handle(channel, handler) { handlers.set(channel, handler); },
    listeners(channel) { return ipcListeners.get(channel) || []; },
  },
  contextBridge: {
    exposeInMainWorld(name, api) { exposedBridges.push({ name, api }); },
  },
  ipcRenderer: {
    invoke: async (channel, payload) => ({ channel, payload }),
    on(channel, callback) { ipcRendererSubscriptions.push([channel, callback]); },
    removeListener(channel, callback) {
      ipcRendererRemovals.push([channel, callback]);
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronMock;
  if (request === "./imgDownloader.js") return { ImgDownloader: class {} };
  if (request === "level-party" || request === "level") return () => db;
  return originalLoad.call(this, request, parent, isMain);
};

function loadMain() {
  return require(MAIN_PATH);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createWindow(plugin, id) {
  const sent = [];
  const webContents = {
    id,
    getURL: () => "file:///renderer/index.html#/main/message",
    isDestroyed: () => false,
    // The plugin registers chat windows on "did-stop-loading"; fire it at
    // once so sendChatWindowsMessage broadcasts reach the recorder.
    on(eventName, handler) {
      if (eventName === "did-stop-loading") handler();
    },
  };
  // Installed before onBrowserWindowCreated so the patched send wraps this
  // recorder and every plugin broadcast lands in `sent`.
  webContents.send = (channel, ...args) => { sent.push([channel, ...args]); };
  const window = { id, webContents, isDestroyed: () => false, once() {} };
  plugin.onBrowserWindowCreated(window);
  return { window, webContents, sent };
}

async function sendOriginal(pluginTargets, record) {
  const { webContents, windowId } = pluginTargets;
  await webContents.send(
    `RM_IPCFROM_MAIN${windowId}`,
    { type: "event" },
    { cmdName: "NodeIKernelMsgListener/onRecvMsg", payload: { msgList: [record] } }
  );
}

async function sendRecall(pluginTargets, msgId, chatType, peerUid, msgSeq) {
  const { webContents, windowId } = pluginTargets;
  await webContents.send(
    `RM_IPCFROM_MAIN${windowId}`,
    { type: "event" },
    {
      cmdName: "NodeIKernelMsgListener/onMsgInfoListUpdate",
      payload: {
        msgList: [{
          msgId,
          msgSeq: msgSeq ?? "1",
          chatType,
          peerUid,
          msgType: 5,
          elements: [{
            elementType: 8,
            grayTipElement: { revokeElement: { isSelfOperate: false } },
          }],
        }],
      },
    }
  );
}

function textRecord(id, chatType, peerUid, overrides = {}) {
  return {
    msgId: id,
    msgSeq: overrides.msgSeq ?? id,
    chatType,
    peerUid,
    msgType: 2,
    elements: [{
      elementId: `${id}-element`,
      elementType: 1,
      textElement: { content: overrides.text ?? id },
    }],
    ...overrides.extra,
  };
}

function imageRecord(id, chatType, peerUid, pic, overrides = {}) {
  return {
    msgId: id,
    msgSeq: overrides.msgSeq ?? id,
    chatType,
    peerUid,
    msgType: 2,
    elements: [{
      elementId: `${id}-element`,
      elementType: 2,
      picElement: {
        fileName: pic.fileName,
        fileSize: pic.fileSize ?? 256,
        md5HexStr: pic.md5,
        picWidth: pic.width ?? 640,
        picHeight: pic.height ?? 480,
        sourcePath: pic.sourcePath,
        thumbPath: {},
      },
    }],
    ...overrides.extra,
  };
}

async function getRecallHistory(params) {
  return handlers.get("LiteLoader.anti_recall.getRecallHistory")?.({}, params);
}

async function getRecallHistoryContext(messageIds) {
  return handlers.get("LiteLoader.anti_recall.getRecallHistoryContext")?.(
    {}, { messageIds }
  );
}

const RECALL_HISTORY_CHANGED = "LiteLoader.anti_recall.mainWindow.recallHistoryChanged";

function historyChangedPayloads(sent) {
  return sent.filter(([channel]) => channel === RECALL_HISTORY_CHANGED);
}

// ---------------------------------------------------------------------------
// Phase A: in-session behavior with saveDb enabled
// ---------------------------------------------------------------------------

(async () => {
  const plugin = loadMain();
  const targets = { ...createWindow(plugin, 41), windowId: 41 };

  // -- fixtures ------------------------------------------------------------
  const PEER1 = "peer-10001";

  const idZzz = textRecord("id-zzz", 1, PEER1, {
    text: "hello world",
    extra: { sendNickName: "Alice", senderUin: "10001", peerName: "老王", msgTime: 1000 },
  });
  const idBob = textRecord("id-bob", 1, PEER1, {
    text: "second message",
    extra: { sendNickName: "Bob", peerName: "老王", msgTimeMs: 1000700 },
  });
  const idAaa = textRecord("id-aaa", 1, PEER1, {
    text: "third",
    extra: { sendNickName: "Alice", senderUin: "10003", msgTime: 1000 },
  });
  const idNotime = textRecord("id-notime", 1, PEER1, {
    text: "no time",
    extra: { sendNickName: "Carl" },
  });
  const imgLost = imageRecord("img-lost", 1, PEER1, {
    md5: "0123456789abcdef0123456789abcdef",
    fileName: "lost.png",
    sourcePath: path.join(testDataDir, "qq-cache", "lost.png"),
    width: 100,
    height: 50,
  }, { extra: { sendNickName: "Dana", msgTime: 900 } });
  const imgReal = imageRecord("img-real", 1, PEER1, {
    md5: "fedcba9876543210fedcba9876543210",
    fileName: "real.png",
    sourcePath: path.join(testDataDir, "qq-cache", "real.png"),
  }, { extra: { sendNickName: "Eve", msgTime: 950 } });

  const normalMsg = textRecord("normal-msg", 1, PEER1, {
    text: "just chatting",
    extra: { peerName: "老王" },
  });
  const backgroundMsg = textRecord("bg-msg", 1, "peer-3000", { text: "background" });

  const SHARED_PEER = "peer-shared";
  const privShared = textRecord("priv-shared", 1, SHARED_PEER, {
    text: "private note",
    extra: { msgTime: 800 },
  });
  const grpShared = textRecord("grp-shared", 2, SHARED_PEER, {
    text: "group note",
    extra: { sendMemberName: "山海不可平", msgTime: 700 },
  });

  const GROUP_ID = "group-900";
  const grpCombo = imageRecord("grp-combo", 2, GROUP_ID, {
    md5: "11223344556677889900aabbccddeeff",
    fileName: "combo.jpg",
    sourcePath: path.join(testDataDir, "qq-cache", "combo.jpg"),
  }, { extra: {
    sendMemberName: "群友甲",
    msgTime: 600,
    elements: [
      {
        elementId: "grp-combo-pic",
        elementType: 2,
        picElement: {
          fileName: "combo.jpg",
          fileSize: 256,
          md5HexStr: "11223344556677889900aabbccddeeff",
          picWidth: 300,
          picHeight: 200,
          sourcePath: path.join(testDataDir, "qq-cache", "combo.jpg"),
          thumbPath: {},
        },
      },
      {
        elementId: "grp-combo-text",
        elementType: 1,
        textElement: { content: "看图说话" },
      },
    ],
  } });

  // Pre-archive img-real into durable storage before its recall so the
  // history path resolves a genuine preserved file.
  fs.mkdirSync(preservedDir, { recursive: true });
  const realArchivedPath = path.join(
    preservedDir,
    "fedcba9876543210fedcba9876543210.png"
  );
  fs.writeFileSync(realArchivedPath, Buffer.alloc(256, 7));

  // -- send originals and recalls ------------------------------------------
  for (const record of [idZzz, idBob, idAaa, idNotime, imgLost, imgReal, normalMsg, backgroundMsg, privShared, grpShared, grpCombo]) {
    await sendOriginal(targets, record);
  }
  const recallSequence = [
    ["id-zzz", 1, PEER1],
    ["id-bob", 1, PEER1],
    ["id-aaa", 1, PEER1],
    ["id-notime", 1, PEER1],
    ["img-lost", 1, PEER1],
    ["img-real", 1, PEER1],
    ["priv-shared", 1, SHARED_PEER],
    ["grp-shared", 2, SHARED_PEER],
    ["grp-combo", 2, GROUP_ID],
  ];
  for (const [msgId, chatType, peerUid] of recallSequence) {
    await sendRecall(targets, msgId, chatType, peerUid);
    await sleep(25);
  }
  await sleep(50);

  // -- basic wiring --------------------------------------------------------
  assert(typeof handlers.get("LiteLoader.anti_recall.getRecallHistory") === "function",
    "getRecallHistory IPC handler must be registered");
  assert(typeof handlers.get("LiteLoader.anti_recall.getRecallHistoryContext") === "function",
    "getRecallHistoryContext IPC handler must be registered");

  // -- normal messages never become history --------------------------------
  const allP1 = await getRecallHistory({ peerUid: PEER1, chatType: 1 });
  assert.equal(allP1.total, 6, "only the six recalled messages count for peer-10001");
  assert(!allP1.items.some((item) => item.id === "normal-msg"),
    "a plain msgFlow message must not appear in history");
  assert(!allP1.items.some((item) => item.id === "bg-msg"),
    "background messages from other peers must not appear");

  // -- same peer, different chatType isolation ------------------------------
  const sharedPrivate = await getRecallHistory({ peerUid: SHARED_PEER, chatType: 1 });
  const sharedGroup = await getRecallHistory({ peerUid: SHARED_PEER, chatType: 2 });
  assert.equal(sharedPrivate.total, 1, "private list must be isolated per chatType");
  assert.deepEqual(sharedPrivate.items.map((item) => item.id), ["priv-shared"]);
  assert.equal(sharedGroup.total, 1, "group list must be isolated per chatType");
  assert.deepEqual(sharedGroup.items.map((item) => item.id), ["grp-shared"]);

  // -- persisted + in-memory same id counts once ----------------------------
  assert.equal(allP1.total, 6,
    "in-session recalls exist in memory and db but must be counted once");

  // -- stable ordering across seconds, milliseconds and missing times -------
  assert.deepStrictEqual(
    allP1.items.map((item) => item.id),
    ["id-bob", "id-aaa", "id-zzz", "img-real", "img-lost", "id-notime"],
    "desc by time with a deterministic id tiebreak; unknown time last"
  );
  assert.equal(allP1.items[0].time, 1000700, "msgTimeMs is treated as Unix ms");
  assert.equal(allP1.items[1].time, 1000000, "msgTime seconds are converted to ms");
  assert.equal(allP1.items[5].time, 0, "unknown time must be 0");

  // repeat query gives the identical order
  const allP1Again = await getRecallHistory({ peerUid: PEER1, chatType: 1 });
  assert.deepEqual(allP1Again.items.map((item) => item.id),
    allP1.items.map((item) => item.id), "ordering must be stable across queries");

  // -- unknown / empty peer and invalid chatType ----------------------------
  const emptyPeer = await getRecallHistory({ peerUid: "", chatType: 1 });
  assert.equal(emptyPeer.total, 0, "empty peer must yield an empty result");
  assert.deepEqual(emptyPeer.items, []);
  const ghostPeer = await getRecallHistory({ peerUid: "ghost", chatType: 1 });
  assert.equal(ghostPeer.total, 0, "unknown peer must yield an empty result");
  assert.equal(ghostPeer.peerUid, "ghost");
  const badChatType = await getRecallHistory({ peerUid: PEER1, chatType: 3 });
  assert.equal(badChatType.total, 0,
    "invalid chatType must yield an empty result, never a global fallback");
  assert.deepEqual(badChatType.items, []);

  // -- keyword on sender and content ---------------------------------------
  const bySender = await getRecallHistory({ peerUid: PEER1, chatType: 1, keyword: "alice" });
  assert.deepEqual(bySender.items.map((item) => item.id).sort(), ["id-aaa", "id-zzz"],
    "keyword must match the sender name case-insensitively");
  const byContent = await getRecallHistory({ peerUid: PEER1, chatType: 1, keyword: "hello" });
  assert.deepEqual(byContent.items.map((item) => item.id), ["id-zzz"],
    "keyword must match the message content");
  const byUin = await getRecallHistory({ peerUid: PEER1, chatType: 1, keyword: "10001" });
  assert.deepEqual(byUin.items.map((item) => item.id), ["id-zzz"],
    "keyword must match the sender uin");
  const keywordMiss = await getRecallHistory({ peerUid: PEER1, chatType: 1, keyword: "nomatchxyz" });
  assert.equal(keywordMiss.total, 0);

  // -- filtered pagination over more than one page --------------------------
  const page0 = await getRecallHistory({ peerUid: PEER1, chatType: 1, type: "text", limit: 2, offset: 0 });
  const page1 = await getRecallHistory({ peerUid: PEER1, chatType: 1, type: "text", limit: 2, offset: 2 });
  const page2 = await getRecallHistory({ peerUid: PEER1, chatType: 1, type: "text", limit: 2, offset: 4 });
  assert.equal(page0.limit, 2);
  assert.equal(page0.offset, 0);
  assert.deepEqual(page0.items.map((item) => item.id), ["id-bob", "id-aaa"]);
  assert.equal(page0.total, 4, "only text items count for the text filter");
  assert.equal(page0.hasMore, true);
  assert.deepEqual(page1.items.map((item) => item.id), ["id-zzz", "id-notime"]);
  assert.equal(page1.hasMore, false);
  assert.deepEqual(page2.items, []);
  assert.equal(page2.total, 4);
  assert.equal(page2.hasMore, false);

  const walked = [];
  for (let offset = 0; ; offset += 2) {
    const page = await getRecallHistory({ peerUid: PEER1, chatType: 1, limit: 2, offset });
    walked.push(...page.items.map((item) => item.id));
    if (!page.hasMore) break;
  }
  assert.equal(walked.length, 6, "walking pages must cover every recalled item");
  assert.equal(new Set(walked).size, 6, "pagination must not duplicate items");

  // -- image availability ---------------------------------------------------
  const realItem = allP1.items.find((item) => item.id === "img-real");
  assert(realItem, "img-real must be present");
  const realElement = realItem.elements.find((element) => element.type === "image");
  assert.equal(realElement.unavailable, false, "a real archived image is available");
  assert(realElement.fileUrl.startsWith("file://"),
    "archived images are exposed as file URLs inside the preserved dir");
  assert(realElement.fileUrl.includes("preserved-images"),
    "fileUrl must point into the preserved image directory");
  assert.equal(realElement.fileName, "real.png");
  assert.equal(realElement.width, 640);
  assert.equal(realElement.height, 480);
  assert.deepEqual(realItem.types, ["image"]);

  const lostItem = allP1.items.find((item) => item.id === "img-lost");
  const lostElement = lostItem.elements.find((element) => element.type === "image");
  assert.equal(lostElement.unavailable, true, "a missing archive must be unavailable");
  assert.equal(lostElement.fileUrl, "", "unavailable images expose no URL");

  // -- group image + text hit both filters ---------------------------------
  const groupAll = await getRecallHistory({ peerUid: GROUP_ID, chatType: 2 });
  const comboItem = groupAll.items.find((item) => item.id === "grp-combo");
  assert.deepEqual(comboItem.types, ["text", "image"],
    "a mixed message carries both types");
  assert.equal(comboItem.text, "看图说话", "text keeps the full original content");
  assert.equal(comboItem.senderName, "群友甲");
  const asText = await getRecallHistory({ peerUid: GROUP_ID, chatType: 2, type: "text" });
  assert.equal(asText.total, 1, "mixed message matches the text filter");
  const asImage = await getRecallHistory({ peerUid: GROUP_ID, chatType: 2, type: "image" });
  assert.equal(asImage.total, 1, "the same mixed message matches the image filter");
  const groupKeyword = await getRecallHistory({ peerUid: GROUP_ID, chatType: 2, keyword: "看图" });
  assert.equal(groupKeyword.total, 1);

  // -- other-type placeholder ----------------------------------------------
  const otherAll = await getRecallHistory({ peerUid: SHARED_PEER, chatType: 2 });
  assert.deepEqual(otherAll.items[0].types, ["text"]);

  // -- item hygiene: string ids, no remote/data URLs, no local path leak ----
  const serialized = JSON.stringify(allP1.items) +
    JSON.stringify(groupAll.items) +
    JSON.stringify(sharedPrivate.items) +
    JSON.stringify(sharedGroup.items);
  for (const item of allP1.items) {
    assert.equal(typeof item.id, "string", "message ids must stay strings");
    assert.equal(typeof item.peerUid, "string");
    assert(Array.isArray(item.types) && item.types.length >= 1,
      "every item carries at least one type");
    assert(["all", "text", "image", "other"].includes("text"));
  }
  assert(!serialized.includes("http"), "no remote URLs may be returned");
  assert(!serialized.includes("data:"), "no data URLs may be returned");
  assert(!serialized.includes("sourcePath"), "raw record fields must not leak");
  assert(!serialized.includes("localPath"), "arbitrary local paths must not leak");
  assert(!serialized.includes("qq-cache"), "QQ cache paths must not leak");

  // -- recallHistoryChanged broadcast ---------------------------------------
  const broadcasts = historyChangedPayloads(targets.sent);
  assert(broadcasts.length >= 1, "a successful recall must broadcast history change");
  const lastBroadcast = broadcasts[broadcasts.length - 1];
  assert.deepEqual(lastBroadcast[1], { peerUid: GROUP_ID, chatType: 2 },
    "the broadcast carries {peerUid, chatType} of the recalled message");

  // -- context --------------------------------------------------------------
  const ctx = await getRecallHistoryContext(["normal-msg", "id-zzz"]);
  assert.deepEqual(ctx.currentPeer, { peerUid: PEER1, chatType: 1, name: "老王" },
    "context comes only from the visible message ids");
  assert.equal(ctx.saveDb, true);
  const peerEntry = ctx.peers.find((peer) => peer.peerUid === PEER1 && peer.chatType === 1);
  assert.equal(peerEntry.total, 6, "peer totals are deduplicated recalled ids");
  assert.equal(peerEntry.name, "老王");
  const sharedGroupEntry = ctx.peers.find((peer) => peer.peerUid === SHARED_PEER && peer.chatType === 2);
  assert.equal(sharedGroupEntry.total, 1);
  assert.equal(sharedGroupEntry.name, "群聊 peer-shared",
    "a group without a real group name falls back to 群聊 <id>," +
    " never to a sender nickname");
  const sharedPrivateEntry = ctx.peers.find((peer) => peer.peerUid === SHARED_PEER && peer.chatType === 1);
  assert.equal(sharedPrivateEntry.name, "私聊 peer-shared");
  assert(!ctx.peers.some((peer) => peer.peerUid === "peer-3000"),
    "normal non-recalled chats must not appear in the peers list");

  const ctxConflict = await getRecallHistoryContext(["priv-shared", "grp-shared"]);
  assert.equal(ctxConflict.currentPeer, null,
    "conflicting visible chats must produce null currentPeer");
  const ctxEmpty = await getRecallHistoryContext([]);
  assert.equal(ctxEmpty.currentPeer, null, "an empty id list must produce null");
  const ctxUnknown = await getRecallHistoryContext(["nonexistent-id"]);
  assert.equal(ctxUnknown.currentPeer, null,
    "unknown ids must not be guessed from background traffic");
  const ctxLimit = await getRecallHistoryContext(
    Array.from({ length: 20 }, (_, index) => `extra-${index}`)
  );
  assert.deepEqual(ctxLimit.currentPeer, null);
  const ctxCurrentPeerNoRecall = await getRecallHistoryContext(["bg-msg"]);
  assert.deepEqual(ctxCurrentPeerNoRecall.currentPeer,
    { peerUid: "peer-3000", chatType: 1, name: "私聊 peer-3000" },
    "currentPeer is returned even when that chat has no recalls");

  // ---------------------------------------------------------------------------
  // Phase B: restart — persisted index reloads from the db
  // ---------------------------------------------------------------------------

  delete require.cache[MAIN_PATH];
  const restartedPlugin = loadMain();
  const restartedTargets = { ...createWindow(restartedPlugin, 42), windowId: 42 };

  assert(await waitFor(async () => {
    const ids = await handlers.get("LiteLoader.anti_recall.getRecalledMsgIds")?.({}, null);
    return Array.isArray(ids) && ids.length >= 9;
  }), "the restarted instance must rebuild the persisted recall index");

  const restartedHistory = await getRecallHistory({ peerUid: PEER1, chatType: 1 });
  assert.equal(restartedHistory.total, 6,
    "persisted recalls are listed after a restart");
  assert.deepEqual(
    restartedHistory.items.map((item) => item.id),
    allP1.items.map((item) => item.id),
    "restart must not change ordering or membership"
  );
  const restartedReal = restartedHistory.items.find((item) => item.id === "img-real");
  const restartedRealElement = restartedReal.elements.find((element) => element.type === "image");
  assert.equal(restartedRealElement.unavailable, false,
    "the archived image still resolves after restart");
  assert(restartedRealElement.fileUrl.startsWith("file://"));
  const restartedLost = restartedHistory.items.find((item) => item.id === "img-lost");
  const restartedLostElement = restartedLost.elements.find((element) => element.type === "image");
  assert.equal(restartedLostElement.unavailable, true);

  const restartedContext = await getRecallHistoryContext(["id-bob"]);
  assert.deepEqual(restartedContext.currentPeer,
    { peerUid: PEER1, chatType: 1, name: "老王" },
    "context works from persisted records after restart");

  // -- clearDb: cache invalidation + historyChanged(null) -------------------
  await handlers.get("LiteLoader.anti_recall.clearDb")?.({}, null);
  await sleep(30);
  assert.equal(stored.size, 0, "clearDb removes database entries");
  const clearedBroadcasts = historyChangedPayloads(restartedTargets.sent);
  assert(clearedBroadcasts.some(([, payload]) => payload === null),
    "clearDb must broadcast recallHistoryChanged(null) so panels refetch");
  const clearedHistory = await getRecallHistory({ peerUid: PEER1, chatType: 1 });
  assert.equal(clearedHistory.total, 0,
    "a stale query cache must not resurrect cleared recalls");
  const clearedIds = await handlers.get("LiteLoader.anti_recall.getRecalledMsgIds")?.({}, null);
  assert.equal(clearedIds.length, 0,
    "after clearDb the persisted index is empty");

  // ---------------------------------------------------------------------------
  // Phase C: pure in-memory module (saveDb false semantics) + preload contract
  // ---------------------------------------------------------------------------

  const { createRecallHistory } = require(RECALL_HISTORY_PATH);
  const { ImageStore } = require(path.join(PLUGIN_DIR, "imageStore.js"));

  const memoryEntries = new Map();
  function putMemoryEntry(id, chatType, peerUid, overrides = {}) {
    const record = {
      msgId: id,
      chatType,
      peerUid,
      elements: overrides.elements ?? [{
        elementId: `${id}-element`,
        elementType: 1,
        textElement: { content: overrides.text ?? `content-${id}` },
      }],
      ...overrides.extra,
    };
    memoryEntries.set(id, { id, sender: peerUid, msg: record });
    return record;
  }

  const unitStore = new ImageStore(pluginDataDir, (record) => String(record?.msgId || ""));
  const unitDeps = {
    getKnownRecalledIds(peerUid = "") {
      return Array.from(memoryEntries.values())
        .filter((entry) => !peerUid || entry.sender === peerUid)
        .map((entry) => entry.id);
    },
    async findCachedMessage(id) {
      return memoryEntries.has(id)
        ? { entry: memoryEntries.get(id), source: "memory" }
        : null;
    },
    imageStore: unitStore,
    isSaveDbEnabled: () => false,
  };
  const unitHistory = createRecallHistory(unitDeps);

  const recordA = putMemoryEntry("mem-a", 1, "u-peer", {
    text: "Hello World",
    extra: { sendNickName: "甲", msgTime: 500 },
  });
  putMemoryEntry("mem-b", 1, "u-peer", {
    text: "mixed item",
    extra: {
      msgTimeMs: 400500,
      elements: [
        {
          elementId: "mem-b-pic",
          elementType: 2,
          picElement: {
            fileName: "mixed.png",
            fileSize: 128,
            md5HexStr: "aabbccdd00112233aabbccdd00112233",
            picWidth: 32,
            picHeight: 32,
            thumbPath: {},
          },
        },
        { elementId: "mem-b-text", elementType: 1, textElement: { content: "mixed item" } },
      ],
    },
  });
  putMemoryEntry("mem-c", 2, "u-peer", { text: "group side", extra: { msgTime: 300 } });
  putMemoryEntry("mem-d", 2, "u-peer2", { elements: [], extra: {} }); // no time, no text

  const unitAll = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 1 });
  assert.equal(unitAll.total, 2, "in-memory recalls are listed");
  assert.deepEqual(unitAll.items.map((item) => item.id), ["mem-a", "mem-b"]);

  const unitIsolation = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 2 });
  assert.deepEqual(unitIsolation.items.map((item) => item.id), ["mem-c"],
    "same peerUid, other chatType stays isolated in memory mode");

  const unitKeyword = await unitHistory.getHistory({
    peerUid: "u-peer", chatType: 1, keyword: "HELLO",
  });
  assert.equal(unitKeyword.total, 1, "keyword matching is case-insensitive");

  const unitText = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 1, type: "text" });
  assert.equal(unitText.total, 2, "mixed item matches the text filter");
  const unitImage = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 1, type: "image" });
  assert.deepEqual(unitImage.items.map((item) => item.id), ["mem-b"],
    "mixed item matches the image filter");
  const unitOther = await unitHistory.getHistory({ peerUid: "u-peer2", chatType: 2 });
  assert.deepEqual(unitOther.items[0].types, ["other"],
    "an empty record still carries the other placeholder");
  assert.deepEqual(unitOther.items[0].elements, [{ type: "other", label: "消息" }]);
  assert.equal(unitOther.items[0].time, 0);

  const clamped = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 1, limit: 1000, offset: -5 });
  assert.equal(clamped.limit, 100, "limit clamps to 100");
  assert.equal(clamped.offset, 0, "negative offset clamps to 0");
  const defaultPage = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 1 });
  assert.equal(defaultPage.limit, 30, "default limit is 30");

  const unitEmpty = await unitHistory.getHistory({ peerUid: "", chatType: 1 });
  assert.equal(unitEmpty.total, 0);
  const unitBadType = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 9 });
  assert.equal(unitBadType.total, 0);
  const unitGhost = await unitHistory.getHistory({ peerUid: "ghost", chatType: 1 });
  assert.equal(unitGhost.total, 0);
  const unitNonStringPeer = await unitHistory.getHistory({ peerUid: 12345, chatType: 1 });
  assert.equal(unitNonStringPeer.total, 0,
    "a non-string peerUid must yield an empty result, not be coerced");

  // msgTimeMs=0 must not shadow a valid msgTime (seconds).
  putMemoryEntry("mem-time", 1, "u-peer", {
    text: "time fallback",
    extra: { msgTimeMs: 0, msgTime: 700 },
  });
  const unitTime = await unitHistory.getHistory({ peerUid: "u-peer", chatType: 1 });
  const timeItem = unitTime.items.find((item) => item.id === "mem-time");
  assert.equal(timeItem.time, 700000, "a zero msgTimeMs falls back to msgTime");

  // Private-chat peer display name: the counterpart nickname only counts when
  // the record's sender is the counterpart; a self-sent record must not leak
  // the local user's own nickname as the peer name.
  putMemoryEntry("mem-counterpart", 1, "u-peer3", {
    text: "from them",
    extra: { sendNickName: "对端昵称", senderUid: "u-peer3" },
  });
  putMemoryEntry("mem-selfsent", 1, "u-peer4", {
    text: "from me",
    extra: { sendNickName: "我的昵称", senderUid: "self-uid" },
  });
  const unitPeerContext = await unitHistory.getContext({ messageIds: [] });
  const counterpartEntry = unitPeerContext.peers.find((peer) => peer.peerUid === "u-peer3");
  assert.equal(counterpartEntry.name, "对端昵称",
    "a private chat may use the counterpart nickname when they sent the record");
  const selfSentEntry = unitPeerContext.peers.find((peer) => peer.peerUid === "u-peer4");
  assert.equal(selfSentEntry.name, "私聊 u-peer4",
    "a self-sent record must never use the local nickname as the peer name");

  const unitContext = await unitHistory.getContext({
    messageIds: ["mem-a", "mem-b"],
  });
  assert.deepEqual(unitContext.currentPeer.peerUid, "u-peer");
  assert.equal(unitContext.currentPeer.chatType, 1);
  assert.equal(unitContext.saveDb, false, "saveDb false is reported");
  const unitConflict = await unitHistory.getContext({ messageIds: ["mem-a", "mem-c"] });
  assert.equal(unitConflict.currentPeer, null,
    "mixed chatTypes for the same peer conflict");
  assert(unitContext.peers.some((peer) => peer.peerUid === "u-peer2" && peer.total === 1),
    "the peers list covers every recalled chat with dedup totals");

  // A genuinely archived image resolves through the read-only imageStore.
  fs.mkdirSync(unitStore.preservedDir, { recursive: true });
  fs.writeFileSync(
    path.join(unitStore.preservedDir, "aabbccdd00112233aabbccdd00112233.png"),
    Buffer.alloc(128, 3)
  );
  const unitArchived = await unitHistory.getHistory({
    peerUid: "u-peer", chatType: 1, type: "image",
  });
  const unitArchivedElement = unitArchived.items[0].elements.find((element) => element.type === "image");
  assert.equal(unitArchivedElement.unavailable, false);
  assert(unitArchivedElement.fileUrl.startsWith("file://"));
  assert.equal(unitArchivedElement.fileName, "mixed.png");

  // ---------------------------------------------------------------------------
  // Phase C2: native raw-record export (getNativeRecords for the #/record view)
  // ---------------------------------------------------------------------------

  const nativeEntries = new Map();
  let nativeNormalizeCalls = 0;
  function nativeDeepClone(value, seen = new WeakMap()) {
    if (value == null || typeof value !== "object") return value;
    if (value instanceof Map) {
      const copy = new Map();
      seen.set(value, copy);
      for (const [key, item] of value) copy.set(key, nativeDeepClone(item, seen));
      return copy;
    }
    if (Array.isArray(value)) return value.map((item) => nativeDeepClone(item, seen));
    const copy = {};
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) copy[key] = nativeDeepClone(item, seen);
    return copy;
  }
  const nativeHistory = createRecallHistory({
    getKnownRecalledIds() { return Array.from(nativeEntries.keys()); },
    async findCachedMessage(id) {
      return nativeEntries.has(id)
        ? { entry: nativeEntries.get(id), source: "memory" }
        : null;
    },
    imageStore: unitStore,
    isSaveDbEnabled: () => false,
    cloneRecord: nativeDeepClone,
    normalizeRecord: (record) => {
      nativeNormalizeCalls += 1;
      return unitStore.normalizeRecord(record);
    },
  });

  function putNativeEntry(id, overrides = {}) {
    const record = {
      msgId: id,
      msgSeq: id,
      chatType: 1,
      peerUid: "native-peer",
      senderUid: `u-sender-${id}`,
      msgTime: 1000000,
      elements: [{
        elementId: `${id}-e`, elementType: 1, textElement: { content: `native-${id}` },
      }],
      ...overrides,
    };
    const entry = { id, sender: record.senderUid, msg: record };
    nativeEntries.set(id, entry);
    return entry;
  }

  const NATIVE_BULK = 55;
  // ids beyond 2^53 must be built as exact even steps: plain +i collapses odd
  // indices into the same double above 2^53.
  const nativeBulkId = (i) => String(9500000000000000 + i * 2);
  for (let i = 0; i < NATIVE_BULK; i += 1) {
    putNativeEntry(nativeBulkId(i), {
      msgTime: 1000000 + (NATIVE_BULK - i),
      senderUid: i % 2 === 0 ? "u-alice" : "u-bob",
    });
  }
  const mapEntry = putNativeEntry("9600000000000001", {
    msgTime: 2000000,
    senderUid: "u-map",
    elements: [{
      elementId: "map-e", elementType: 2,
      picElement: {
        fileName: "mapped.png",
        md5HexStr: "aabbccdd00112233aabbccdd00112233",
        picWidth: 10,
        picHeight: 10,
        sourcePath: "/qq-cache-original/mapped.png",
      },
    }],
    localExtra: new Map([["thumb", "abc"]]),
  });
  putNativeEntry("9800000000000001", {
    msgTime: 2500000, senderUid: "u-uid-only", senderUin: "88888888",
  });
  putNativeEntry("9700000000000001", { msgTimeMs: 1750000000000, senderUid: "u-dto" });
  const nativeTotal = NATIVE_BULK + 3;
  const expectedNativeOrder = [
    "9700000000000001", "9800000000000001", "9600000000000001",
    ...Array.from({ length: NATIVE_BULK }, (_, i) => nativeBulkId(i)),
  ];

  // -- first native page: 50 raw records, stable newest-first order ---------
  const nativePage1 = await nativeHistory.getNativeRecords({ peerUid: "native-peer", chatType: 1 });
  assert.equal(nativePage1.limit, 50, "native default limit is 50");
  assert.equal(nativePage1.offset, 0);
  assert.equal(nativePage1.total, nativeTotal);
  assert.equal(nativePage1.records.length, 50, "the first native page holds 50 records");
  assert.equal(nativePage1.hasMore, true);
  assert.equal(nativePage1.peerUid, "native-peer");
  assert.equal(nativePage1.chatType, 1);
  const nativePage2 = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, offset: 50,
  });
  assert.equal(nativePage2.records.length, nativeTotal - 50);
  assert.equal(nativePage2.hasMore, false, "the walk ends after the full set");
  assert.deepStrictEqual(
    nativePage1.records.map((record) => record.msgId)
      .concat(nativePage2.records.map((record) => record.msgId)),
    expectedNativeOrder,
    "native records are stable newest-first across pages"
  );
  for (const record of [...nativePage1.records, ...nativePage2.records]) {
    assert.equal(typeof record.msgId, "string");
    assert.equal(typeof record.msgSeq, "string");
    assert.equal(record.chatType, 1);
    assert.equal(record.peerUid, "native-peer");
    assert.equal(typeof record.msgTime, "number");
    assert(Array.isArray(record.elements) && record.elements.length >= 1);
  }
  const firstBulk = nativePage1.records[3];
  assert.equal(firstBulk.msgId, "9500000000000000");
  assert.equal(firstBulk.elements[0].textElement.content, "native-9500000000000000",
    "raw elements keep their full original shape");
  assert(Number(nativePage1.records[0].msgId) > Number.MAX_SAFE_INTEGER,
    "ids beyond 2^53 stay exact strings, never numbers");

  const nativeClamped = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, limit: 5000,
  });
  assert.equal(nativeClamped.limit, 200, "native limit clamps to 200");
  const nativeTrimmed = await nativeHistory.getNativeRecords({
    peerUid: "  native-peer  ", chatType: 1, limit: 1,
  });
  assert.equal(nativeTrimmed.records.length, 1, "peerUid whitespace is trimmed");
  const nativeBadPeer = await nativeHistory.getNativeRecords({ peerUid: 555, chatType: 1 });
  assert.equal(nativeBadPeer.total, 0, "non-string peerUid yields an empty native result");
  assert.deepEqual(nativeBadPeer.records, []);
  const nativeBadChat = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 3,
  });
  assert.equal(nativeBadChat.total, 0, "invalid chatType yields an empty native result");

  // -- sender and time-range filters ---------------------------------------
  const byAlice = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: ["u-alice"],
  });
  assert.equal(byAlice.total, 28, "the 28 even-indexed bulk records come from u-alice");
  assert(byAlice.records.every((record) => record.senderUid === "u-alice"));
  const byAliceNoisy = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: ["u-alice", "", 42],
  });
  assert.equal(byAliceNoisy.total, 28, "non-string filter entries are ignored, not fatal");
  const byBob = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: ["u-bob"],
  });
  assert.equal(byBob.total, 27);
  const byBoth = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: ["u-alice", "u-bob"],
  });
  assert.equal(byBoth.total, NATIVE_BULK);
  const nativeByUin = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: ["88888888"],
  });
  assert.equal(nativeByUin.total, 1, "the sender filter also matches senderUin");
  assert.equal(nativeByUin.records[0].msgId, "9800000000000001");
  const byEmptySenders = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: [],
  });
  assert.equal(byEmptySenders.total, nativeTotal,
    "an empty (native-default) sender filter filters nothing");
  const byEmptyTimes = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterMsgFromTime: "", filterMsgToTime: "",
  });
  assert.equal(byEmptyTimes.total, nativeTotal,
    "empty-string time bounds are unbounded, not epoch");
  const byZeroTimes = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterMsgFromTime: "0", filterMsgToTime: 0,
  });
  assert.equal(byZeroTimes.total, nativeTotal,
    "native-default '0'/0 time bounds mean no filter, never an epoch window");

  const byRangeSec = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1,
    filterMsgFromTime: 1000020, filterMsgToTime: 1000030,
  });
  assert.equal(byRangeSec.total, 11, "a seconds-based inclusive range matches 11 records");
  const rangeTimes = byRangeSec.records.map((record) => record.msgTime);
  assert(rangeTimes.every((time) => time >= 1000020 && time <= 1000030));
  assert.deepStrictEqual(rangeTimes, [...rangeTimes].sort((a, b) => b - a),
    "range results stay newest-first");
  const byRangeMs = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1,
    filterMsgFromTime: 1749999999000, filterMsgToTime: 1750000001000,
  });
  assert.equal(byRangeMs.total, 1, "ms bounds above 1e12 are used as ms");
  assert.equal(byRangeMs.records[0].msgId, "9700000000000001");
  const byAliceRange = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1,
    filterSendersUid: ["u-alice"], filterMsgFromTime: 1000020, filterMsgToTime: 1000030,
  });
  assert.equal(byAliceRange.total, 5, "sender and range filters compose");
  const byInvertedRange = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1,
    filterMsgFromTime: 1000040, filterMsgToTime: 1000010,
  });
  assert.equal(byInvertedRange.total, 0, "an inverted range matches nothing");

  // -- keyword uses the same generic haystack -------------------------------
  const nativeKeyword = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, keyword: "NATIVE-9500000000000010",
  });
  assert.equal(nativeKeyword.total, 1, "native keyword matching is case-insensitive");
  assert.equal(nativeKeyword.records[0].msgId, "9500000000000010");

  // -- clone-not-source: Maps survive, sources are never mutated ------------
  const mapReplacer = (key, value) =>
    value instanceof Map ? { __map: Array.from(value.entries()) } : value;
  const sourceSnapshot = JSON.stringify(mapEntry.msg, mapReplacer);
  const nativeMapped = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: ["u-map"],
  });
  assert.equal(nativeMapped.total, 1);
  const mappedClone = nativeMapped.records[0];
  assert(mappedClone !== mapEntry.msg, "the returned record is a clone, not the cached entry");
  assert(mappedClone.localExtra instanceof Map, "cloning preserves Map payloads");
  assert.equal(mappedClone.localExtra.get("thumb"), "abc");
  assert(nativeNormalizeCalls >= 1, "the injected normalizeRecord runs on the clone");
  assert(JSON.stringify(mappedClone.elements[0].picElement).includes("preserved-images"),
    "archived-image normalization lands on the clone");
  assert.equal(JSON.stringify(mapEntry.msg, mapReplacer), sourceSnapshot,
    "the source entry is byte-identical after clone + normalize");
  assert.equal(mapEntry.msg.elements[0].picElement.sourcePath, "/qq-cache-original/mapped.png",
    "the source keeps its original raw path");
  assert.equal(mapEntry.msg.localExtra.get("thumb"), "abc", "the source Map is untouched");
  mappedClone.msgTime = -1;
  const nativeAgain = await nativeHistory.getNativeRecords({
    peerUid: "native-peer", chatType: 1, filterSendersUid: ["u-map"],
  });
  assert.equal(nativeAgain.records[0].msgTime, 2000000,
    "mutating one result never leaks into later queries");

  // -- default-injection path (structuredClone) -----------------------------
  const unitNative = await unitHistory.getNativeRecords({ peerUid: "u-peer", chatType: 1 });
  assert.equal(unitNative.total, 3, "no-injection native export works via structuredClone");
  assert.deepEqual(unitNative.records.map((record) => record.msgId),
    ["mem-time", "mem-a", "mem-b"]);
  const unitNativeB = unitNative.records.find((record) => record.msgId === "mem-b");
  assert.equal(unitNativeB.elements.length, 2, "raw multi-element shapes are preserved");

  // -- DTO regression on the same shared cache ------------------------------
  const dtoDefault = await nativeHistory.getHistory({ peerUid: "native-peer", chatType: 1 });
  assert.equal(dtoDefault.limit, 30, "the DTO keeps its own default paging");
  assert.equal(dtoDefault.total, nativeTotal, "DTO and native share the same index");
  const dtoPage = await nativeHistory.getHistory({ peerUid: "native-peer", chatType: 1, limit: 3 });
  assert.deepEqual(dtoPage.items.map((item) => item.id), expectedNativeOrder.slice(0, 3),
    "DTO and native agree on order");
  const dtoJson = JSON.stringify(dtoPage.items);
  assert(!dtoJson.includes("localExtra"), "DTO items never carry raw record fields");
  assert(!dtoJson.includes("sourcePath"), "DTO items never leak raw paths");

  nativeHistory.invalidateCache();
  const nativeReloaded = await nativeHistory.getNativeRecords({ peerUid: "native-peer", chatType: 1 });
  assert.equal(nativeReloaded.total, nativeTotal,
    "invalidateCache keeps native results correct after reload");

  // ---------------------------------------------------------------------------
  // Phase D: recall-history performance hygiene (synthetic call counters)
  // ---------------------------------------------------------------------------

  // A standalone index/store pair so the counters measure only recallHistory's
  // own caching behavior, mirroring main.js: getKnownRecalledIds lists only
  // recalled ids; findCachedMessage can also resolve plain visible messages.
  const perfRecalled = new Map();
  const perfVisible = new Map();
  const PERF_RECALLED = 5000; // == MAX_ENTRY_CACHE_IDS: everything fits
  for (let i = 0; i < PERF_RECALLED; i += 1) {
    const id = `perf-r${i}`;
    perfRecalled.set(id, {
      id,
      sender: "perf-peer",
      msg: {
        msgId: id,
        chatType: 1,
        peerUid: "perf-peer",
        msgTime: 1000000,
        elements: [{ elementId: `${id}-e`, elementType: 1, textElement: { content: `t${i}` } }],
      },
    });
  }
  for (let i = 0; i < 24; i += 1) {
    const id = `perf-v${i}`;
    perfVisible.set(id, {
      id,
      sender: "perf-sender",
      msg: {
        msgId: id,
        chatType: 1,
        peerUid: "perf-visible-peer",
        msgTime: 1000000,
        elements: [{ elementId: `${id}-e`, elementType: 1, textElement: { content: `v${i}` } }],
      },
    });
  }
  let perfFindCalls = 0;
  let perfRecalledFindCalls = 0;
  const perfStore = new ImageStore(pluginDataDir, (record) => String(record?.msgId || ""));
  const perfHistory = createRecallHistory({
    getKnownRecalledIds() {
      return Array.from(perfRecalled.keys());
    },
    async findCachedMessage(id) {
      perfFindCalls += 1;
      if (perfRecalled.has(id)) {
        perfRecalledFindCalls += 1;
        return { entry: perfRecalled.get(id), source: "recalled" };
      }
      if (perfVisible.has(id)) return { entry: perfVisible.get(id), source: "window" };
      return null;
    },
    imageStore: perfStore,
    isSaveDbEnabled: () => false,
  });

  const perfIds = (offset) =>
    Array.from({ length: 12 }, (_, k) => `perf-v${(offset + k) % 24}`);

  // Cold open: every recalled id and every visible id resolved exactly once.
  const perfCtx1 = await perfHistory.getContext({ messageIds: perfIds(0) });
  assert.equal(perfFindCalls, PERF_RECALLED + 12,
    "a cold context resolves each recalled entry once plus the visible ids");
  assert.equal(perfRecalledFindCalls, PERF_RECALLED);
  assert.equal(perfCtx1.peers.length, 1);
  assert.equal(perfCtx1.peers[0].total, PERF_RECALLED);

  // Warm open with different visible ids: the peer aggregate is reused and
  // the recalled entries are not re-resolved.
  const perfBefore2 = perfFindCalls;
  const perfRecalledBefore2 = perfRecalledFindCalls;
  const perfCtx2 = await perfHistory.getContext({ messageIds: perfIds(12) });
  assert.equal(perfFindCalls - perfBefore2, 12,
    "a warm context resolves only the 12 visible ids (no aggregate rescan)");
  assert.equal(perfRecalledFindCalls - perfRecalledBefore2, 0,
    "recalled entries must not be re-resolved on warm opens");
  assert.deepEqual(perfCtx2.peers, perfCtx1.peers,
    "an unchanged recalled-id set yields an identical peer list");

  // Repeating the same visible ids proves plain messages never entered the
  // entry cache, so they cannot evict recalled entries.
  const perfBefore3 = perfFindCalls;
  await perfHistory.getContext({ messageIds: perfIds(0) });
  assert.equal(perfFindCalls - perfBefore3, 12,
    "plain visible messages are re-resolved per open instead of polluting the entry cache");

  // A new recall must invalidate the aggregate without any explicit reset:
  // the signature changes, the new id is resolved once, and its group total
  // grows immediately (no TTL, no stale peers).
  perfRecalled.set("perf-rnew", {
    id: "perf-rnew",
    sender: "perf-peer",
    msg: {
      msgId: "perf-rnew",
      chatType: 1,
      peerUid: "perf-peer",
      msgTime: 1000001,
      elements: [{ elementId: "perf-rnew-e", elementType: 1, textElement: { content: "new" } }],
    },
  });
  const perfBefore4 = perfFindCalls;
  const perfCtx4 = await perfHistory.getContext({ messageIds: [] });
  assert.equal(perfFindCalls - perfBefore4, 1,
    "only the new recalled id is resolved after a signature change");
  assert.equal(perfCtx4.peers[0].total, PERF_RECALLED + 1,
    "the aggregate includes the new recall immediately");

  // clearDb semantics without invalidateCache: an emptied index recomputes to
  // an empty peer list all by itself.
  const perfSavedEntry = perfRecalled.get("perf-r0");
  perfRecalled.clear();
  const perfCtx5 = await perfHistory.getContext({ messageIds: [] });
  assert.deepEqual(perfCtx5.peers, [], "an emptied recalled index yields no peers");

  // invalidateCache (the real clearDb path) drops the entry cache too: the
  // next aggregate reloads everything from findCachedMessage.
  perfRecalled.set("perf-r0", perfSavedEntry);
  perfHistory.invalidateCache();
  const perfBefore6 = perfFindCalls;
  const perfCtx6 = await perfHistory.getContext({ messageIds: [] });
  assert.equal(perfFindCalls - perfBefore6, 1,
    "invalidateCache (clearDb path) drops the entry cache: the next open reloads from the source");
  assert.equal(perfCtx6.peers.length, 1);
  assert.equal(perfCtx6.peers[0].total, 1);

  // getHistory stays consistent with the aggregate on the same fixture.
  const perfHist = await perfHistory.getHistory({ peerUid: "perf-peer", chatType: 1 });
  assert.equal(perfHist.total, 1);
  assert.deepEqual(perfHist.items.map((item) => item.id), ["perf-r0"]);

  // -- preload contract ----------------------------------------------------
  require(PRELOAD_PATH);
  assert.equal(exposedBridges.length, 1, "preload exposes exactly one bridge");
  assert.equal(exposedBridges[0].name, "anti_recall");
  const api = exposedBridges[0].api;
  assert.equal(typeof api.getRecallHistoryContext, "function");
  assert.equal(typeof api.getRecallHistory, "function");
  assert.equal(typeof api.recallHistoryChanged, "function");

  const contextInvoke = await api.getRecallHistoryContext({ messageIds: ["x"] });
  assert.equal(contextInvoke.channel, "LiteLoader.anti_recall.getRecallHistoryContext");
  assert.deepEqual(contextInvoke.payload, { messageIds: ["x"] });
  const historyInvoke = await api.getRecallHistory({ peerUid: "p", chatType: 1, limit: 5 });
  assert.equal(historyInvoke.channel, "LiteLoader.anti_recall.getRecallHistory");
  assert.deepEqual(historyInvoke.payload, { peerUid: "p", chatType: 1, limit: 5 });

  let receivedEvent;
  let receivedPayload;
  let receivedArgCount = -1;
  const unsubscribe = api.recallHistoryChanged((...args) => {
    receivedArgCount = args.length;
    receivedEvent = args[0];
    receivedPayload = args[1];
  });
  assert.equal(typeof unsubscribe, "function", "subscription returns an unsubscribe fn");
  assert.equal(ipcRendererSubscriptions.length, 1);
  assert.equal(ipcRendererSubscriptions[0][0], RECALL_HISTORY_CHANGED);
  ipcRendererSubscriptions[0][1]({ sender: {} }, { peerUid: "p", chatType: 2 });
  assert.equal(receivedEvent, null,
    "the callback's first argument is null, never the Electron event");
  assert.deepEqual(receivedPayload, { peerUid: "p", chatType: 2 },
    "the callback receives the recallHistoryChanged payload as (event, info)");
  assert.equal(receivedArgCount, 2);
  unsubscribe();
  assert.equal(ipcRendererRemovals.length, 1,
    "unsubscribe removes the ipcRenderer listener");
  assert.equal(ipcRendererRemovals[0][0], RECALL_HISTORY_CHANGED);
  assert.equal(ipcRendererRemovals[0][1], ipcRendererSubscriptions[0][1]);

  Module._load = originalLoad;
  await appHandlers.get("quit")?.();
  console.log("RECALL_HISTORY_TEST_OK");
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error.stack || error);
  process.exitCode = 1;
});
