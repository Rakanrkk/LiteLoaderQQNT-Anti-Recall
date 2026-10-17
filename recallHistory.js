"use strict";

// Read-only recall history queries backing the renderer's history panel.
//
// The message list comes strictly from the recalled-ID index
// (deps.getKnownRecalledIds). The plain msgFlow cache is only ever consulted
// through deps.findCachedMessage to resolve records for ids that are already
// known to be recalled, or to infer the chat context of the messages that are
// currently visible on screen (getRecallHistoryContext). Normal (non-recalled)
// messages never become history items.
//
// No record owned by the anti-recall pipeline is mutated here: image
// availability is resolved through imageStore.validPreservedPath (a stat-based
// read-only check) and only preservedDir-inside files are exposed via
// imageStore.fileUrl.

const path = require("path");
const { restoreNativeRecordTypes } = require("./nativeRecord.js");

const MAX_CONTEXT_MESSAGE_IDS = 12;
const MAX_KEYWORD_LENGTH = 256;
const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 100;
// Bound concurrent db.get calls so a large persisted index never opens
// thousands of reads at once.
const MAX_LOAD_CONCURRENCY = 6;
const MAX_ENTRY_CACHE_IDS = 5000;

const VALID_CHAT_TYPES = new Set([1, 2]);
const VALID_HISTORY_TYPES = new Set(["all", "text", "image", "other"]);
const CANONICAL_TYPE_ORDER = ["text", "image", "other"];

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function getRecordPeer(record) {
  return String(record?.peerUid || record?.peerUin || record?.peer?.peerUid || "");
}

function normalizeChatType(value) {
  const numeric = Number(value);
  return VALID_CHAT_TYPES.has(numeric) ? numeric : 0;
}

// msgTime is seconds in NTQQ records; msgTimeMs (when present) is already ms
// and is trusted as-is. A zero/empty msgTimeMs must not shadow a valid
// msgTime. Unknown times are 0 and sort as the oldest entries; NaN never
// reaches the comparator.
function toUnixMs(record) {
  const msValue = Number(record?.msgTimeMs);
  if (Number.isFinite(msValue) && msValue > 0) return Math.round(msValue);
  const secValue = Number(record?.msgTime);
  if (Number.isFinite(secValue) && secValue > 0) {
    return Math.round(secValue < 1e12 ? secValue * 1000 : secValue);
  }
  return 0;
}

// Only genuine session names qualify; group sender nicknames
// (sendMemberName/sendNickName) must never become a group display name. For
// private chats the counterpart nickname is only usable when the sender of
// the record is the counterpart itself (senderUid === peerUid) — otherwise
// sendNickName would be the local user's own name.
function rawPeerName(record, chatType, peerUid) {
  const name = firstNonEmptyString(
    record?.peerName,
    record?.peer?.peerName,
    record?.peerInfo?.groupName,
    record?.peerInfo?.name,
    record?.groupName
  );
  if (name) return name;
  if (chatType === 1 && peerUid) {
    const sender = String(record?.senderUid || record?.senderUin || "");
    if (sender === peerUid) {
      return firstNonEmptyString(
        record?.sendNickName,
        record?.sendRemarkName,
        record?.sendMemberName
      );
    }
  }
  return "";
}

function peerFallbackName(chatType, peerUid) {
  return chatType === 2 ? `群聊 ${peerUid}` : `私聊 ${peerUid}`;
}

function classifyElement(element) {
  if (!element || typeof element !== "object") return null;
  if (element.picElement) return { kind: "image" };
  const textContent = element.textElement?.content;
  if (typeof textContent === "string" && textContent.trim()) {
    return { kind: "text", text: textContent };
  }
  const markdownContent = element.markdownElement?.content;
  if (typeof markdownContent === "string" && markdownContent.trim()) {
    return { kind: "text", text: markdownContent };
  }
  if (element.grayTipElement) {
    // The revoke element itself is the recall tip and is never content.
    if (element.grayTipElement.revokeElement) return null;
    return { kind: "other", label: "系统提示" };
  }
  if (element.pttElement) return { kind: "other", label: "语音" };
  if (element.videoElement) return { kind: "other", label: "视频" };
  if (element.fileElement) {
    const fileName = firstNonEmptyString(
      element.fileElement.fileName,
      element.fileElement.name
    );
    return { kind: "other", label: fileName ? `文件 ${fileName}` : "文件" };
  }
  if (element.faceElement || element.marketFaceElement) {
    return { kind: "other", label: "表情" };
  }
  if (element.arkElement) return { kind: "other", label: "卡片消息" };
  if (
    element.multiForwardMsgElement ||
    element.forwardMsgElement ||
    element.structLongMsgElement
  ) {
    return { kind: "other", label: "转发消息" };
  }
  return null;
}

function sortTypes(typeSet) {
  return CANONICAL_TYPE_ORDER.filter((type) => typeSet.has(type));
}

// Stable, content-only projection of one recalled entry. Cached per entry
// object so repeated keyword queries never re-extract text or stat files.
function buildSummary(entry) {
  const record = entry?.msg;
  const typeSet = new Set();
  const elementParts = [];
  const textParts = [];
  const labelParts = [];
  const elements = Array.isArray(record?.elements) ? record.elements : [];
  for (const [index, element] of elements.entries()) {
    const classified = classifyElement(element);
    if (!classified) continue;
    if (classified.kind === "text") {
      typeSet.add("text");
      elementParts.push({
        template: { type: "text", text: classified.text },
        element,
        index,
      });
      textParts.push(classified.text);
    } else if (classified.kind === "image") {
      typeSet.add("image");
      const pic = element.picElement;
      elementParts.push({
        template: {
          type: "image",
          fileName: String(pic?.fileName || ""),
          width: Math.max(0, Math.floor(Number(pic?.picWidth)) || 0),
          height: Math.max(0, Math.floor(Number(pic?.picHeight)) || 0),
        },
        element,
        index,
      });
    } else {
      typeSet.add("other");
      elementParts.push({
        template: { type: "other", label: classified.label },
        element,
        index,
      });
      labelParts.push(classified.label);
    }
  }
  if (typeSet.size === 0) {
    // Every item must carry at least one history type.
    typeSet.add("other");
    elementParts.push({
      template: { type: "other", label: "消息" },
      element: null,
      index: -1,
    });
    labelParts.push("消息");
  }
  const chatType = Number(record?.chatType) || 0;
  const senderName =
    firstNonEmptyString(
      record?.sendMemberName,
      record?.sendNickName,
      record?.sendRemarkName,
      record?.senderName,
      record?.senderNickName,
      record?.senderRemarkName,
      chatType === 1 ? firstNonEmptyString(record?.peerName, record?.peer?.peerName) : ""
    ) || (chatType === 2 ? "群成员" : "对方");
  const senderUid = String(record?.senderUid || record?.senderUin || "");
  const senderUin = String(record?.senderUin || "");
  const text = textParts.join("");
  return {
    id: String(entry?.id ?? record?.msgId ?? ""),
    record,
    chatType,
    peerUid: getRecordPeer(record),
    senderName,
    senderUid,
    senderUin,
    time: toUnixMs(record),
    text,
    types: sortTypes(typeSet),
    elementParts,
    keywordHaystack: [senderName, senderUin, senderUid, text, ...labelParts]
      .join("\n")
      .toLowerCase(),
  };
}

// Newest first; NaN-free because buildSummary always yields a finite number.
// Equal times keep a deterministic order via the id tiebreak.
function compareHistoryOrder(left, right) {
  if (left.time !== right.time) return right.time - left.time;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function compareById(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createRecallHistory(deps) {
  // deps: {
  //   getKnownRecalledIds(peerUid?) -> string[],
  //   findCachedMessage(id) -> Promise<{entry: {id, sender, msg}, source} | null>,
  //   imageStore: read-only validPreservedPath/fileUrl access,
  //   isSaveDbEnabled() -> boolean,
  // }
  let summaryCache = new WeakMap();
  let entryCacheById = new Map();
  // Aggregated per-peer summaries for getContext, keyed by the exact recalled
  // id set (sorted-join signature). Reused only while the set is unchanged:
  // any new or removed id changes the signature, and clearDb resets it via
  // invalidateCache(). No TTL, so results are never stale.
  let peerAggCache = null;

  function cacheEntry(cache, id, entry) {
    if (cache.has(id)) return;
    cache.set(id, entry);
    while (cache.size > MAX_ENTRY_CACHE_IDS) {
      cache.delete(cache.keys().next().value);
    }
  }

  // Resolve entries for known recalled ids with bounded concurrency. Entries
  // are cached by id for this session so repeated queries do not re-hit the
  // database; invalidateCache() swaps in a fresh map, so an in-flight load
  // captured the old map and can never repopulate the post-clear cache.
  async function loadEntries(ids, cacheAllowSet = null) {
    const cache = entryCacheById;
    const results = new Map();
    const pending = [];
    for (const id of ids) {
      const cached = cache.get(id);
      if (cached) {
        results.set(id, cached);
        continue;
      }
      pending.push(id);
    }
    let cursor = 0;
    const workerCount = Math.min(MAX_LOAD_CONCURRENCY, pending.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < pending.length) {
        const id = pending[cursor];
        cursor += 1;
        let found = null;
        try {
          found = await deps.findCachedMessage(id);
        } catch {
          found = null;
        }
        const entry = found?.entry;
        if (entry?.msg) {
          results.set(id, entry);
          // When a cacheAllowSet is supplied, only entries whose id belongs to
          // it may enter the cache. The visible-message path passes the
          // recalled-id index here: plain on-screen messages are re-resolved
          // per context call (at most MAX_CONTEXT_MESSAGE_IDS of them) and
          // must never evict recalled entries from the bounded cache.
          if (
            entryCacheById === cache &&
            (!cacheAllowSet || cacheAllowSet.has(id))
          ) {
            cacheEntry(cache, id, entry);
          }
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  function getSummary(entry) {
    let summary = summaryCache.get(entry);
    if (!summary) {
      summary = buildSummary(entry);
      summaryCache.set(entry, summary);
    }
    return summary;
  }

  function assembleItem(summary) {
    const elements = summary.elementParts.map((part) => {
      if (part.template.type !== "image") return { ...part.template };
      const filePath = part.element
        ? deps.imageStore.validPreservedPath(summary.record, part.element, part.index)
        : "";
      const fileUrl = filePath ? deps.imageStore.fileUrl(filePath) : "";
      return {
        type: "image",
        fileUrl,
        fileName: part.template.fileName || (filePath ? path.basename(filePath) : ""),
        width: part.template.width,
        height: part.template.height,
        unavailable: !filePath,
      };
    });
    return {
      id: summary.id,
      peerUid: summary.peerUid,
      chatType: summary.chatType,
      senderName: summary.senderName,
      senderUid: summary.senderUid,
      senderUin: summary.senderUin,
      time: summary.time,
      text: summary.text,
      types: summary.types.slice(),
      elements,
    };
  }

  async function getContext(payload) {
    const rawIds = Array.isArray(payload?.messageIds) ? payload.messageIds : [];
    const ids = [];
    const seenIds = new Set();
    for (const raw of rawIds.slice(0, MAX_CONTEXT_MESSAGE_IDS)) {
      const id = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
    }

    // Context comes only from the explicitly visible messages. Never from the
    // latest background message.
    const recalledIds = deps.getKnownRecalledIds();
    const recalledIdSet = new Set(recalledIds);
    const visible = await loadEntries(ids, recalledIdSet);
    const candidates = [];
    for (const id of ids) {
      const record = visible.get(id)?.msg;
      const chatType = normalizeChatType(record?.chatType);
      const peerUid = getRecordPeer(record);
      if (chatType && peerUid) candidates.push({ chatType, peerUid, record });
    }
    let currentPeer = null;
    if (candidates.length) {
      const first = candidates[0];
      const unique = candidates.every(
        (candidate) =>
          candidate.chatType === first.chatType && candidate.peerUid === first.peerUid
      );
      if (unique) {
        currentPeer = {
          peerUid: first.peerUid,
          chatType: first.chatType,
          name:
            rawPeerName(first.record, first.chatType, first.peerUid) ||
            peerFallbackName(first.chatType, first.peerUid),
        };
      }
    }

    // The peer list covers the whole shared persisted index; the UI must not
    // present it as account-isolated. It depends only on the recalled-id set,
    // so it is aggregated once per set and reused while the set is unchanged
    // (exact sorted-join signature: a new recall or a removal always changes
    // it, and clearDb goes through invalidateCache()). No TTL, no staleness.
    const signature = recalledIds.slice().sort().join("\u0000");
    let peers;
    if (peerAggCache && peerAggCache.signature === signature) {
      peers = peerAggCache.peers.slice();
    } else {
      const pairs = Array.from(await loadEntries(recalledIds)).sort(
        (left, right) => compareById(left[0], right[0])
      );
      const groups = new Map();
      for (const [id, entry] of pairs) {
        const chatType = normalizeChatType(entry.msg?.chatType);
        const peerUid = getRecordPeer(entry.msg);
        if (!chatType || !peerUid) continue;
        const key = `${chatType}:${peerUid}`;
        let group = groups.get(key);
        if (!group) {
          group = { chatType, peerUid, name: "", ids: new Set() };
          groups.set(key, group);
        }
        group.ids.add(id);
        if (!group.name) group.name = rawPeerName(entry.msg, chatType, peerUid);
      }
      peers = Array.from(groups.values())
        .map((group) => ({
          peerUid: group.peerUid,
          chatType: group.chatType,
          name: group.name || peerFallbackName(group.chatType, group.peerUid),
          total: group.ids.size,
        }))
        .sort(
          (left, right) =>
            left.chatType - right.chatType || compareById(left.peerUid, right.peerUid)
        );
      peerAggCache = { signature, peers };
    }

    return {
      currentPeer,
      peers,
      saveDb: Boolean(deps.isSaveDbEnabled?.()),
    };
  }

  // Native raw-record paging for the QQ "#/record" recalled-only view. The
  // payload is heavier than the DTO, so the default page is smaller but the
  // cap is higher.
  const NATIVE_DEFAULT_PAGE_LIMIT = 50;
  const NATIVE_MAX_PAGE_LIMIT = 200;

  // Native filter bounds accept Unix seconds or ms, like toUnixMs(). Absent
  // or invalid bounds become null (unbounded) instead of failing the query.
  function filterTimeToMs(value) {
    if (value == null) return null;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num < 1e12 ? num * 1000 : num);
  }

  // Shared recall filtering for getHistory (DTO) and getNativeRecords (raw
  // clones): the same peer/chatType verification, type filter and keyword
  // haystack, plus the native-only sender and inclusive time-range filters.
  // Always newest first with the deterministic id tiebreak.
  async function collectPeerSummaries(peerUid, chatType, type, keyword, filters = {}) {
    const ids = deps.getKnownRecalledIds(peerUid);
    const entryById = await loadEntries(ids);
    const senderSet = Array.isArray(filters.filterSendersUid)
      ? new Set(filters.filterSendersUid.filter((uid) => typeof uid === "string" && uid))
      : null;
    // The native UI sends a plain default []: an empty (or all-invalid) sender
    // list means "no sender filter", never "match nobody".
    const senderUids = senderSet && senderSet.size > 0 ? senderSet : null;
    const fromMs = filters.filterMsgFromMs ?? null;
    const toMs = filters.filterMsgToMs ?? null;
    const summaries = [];
    for (const id of ids) {
      const entry = entryById.get(id);
      if (!entry?.msg) continue;
      const summary = getSummary(entry);
      // Record-level verification isolates the same peerUid across chat types.
      if (summary.chatType !== chatType || summary.peerUid !== peerUid) continue;
      if (type !== "all" && !summary.types.includes(type)) continue;
      if (keyword && !summary.keywordHaystack.includes(keyword)) continue;
      if (
        senderUids &&
        !senderUids.has(summary.senderUid) &&
        !(summary.senderUin && senderUids.has(summary.senderUin))
      ) continue;
      if (fromMs !== null && summary.time < fromMs) continue;
      if (toMs !== null && summary.time > toMs) continue;
      summaries.push(summary);
    }
    summaries.sort(compareHistoryOrder);
    return summaries;
  }

  // Deep-clone one raw record without ever touching the source entry: clone
  // first, then normalize the clone in place, so archived-image paths are only
  // ever written to the copy. Main injects cloneForCache and
  // imageStore.normalizeRecord; without injection structuredClone (Node >= 17)
  // is used, which preserves Maps. JSON is the last-resort fallback only.
  function cloneRawRecord(record) {
    let clone;
    if (typeof deps.cloneRecord === "function") {
      clone = deps.cloneRecord(record);
    } else if (typeof structuredClone === "function") {
      clone = structuredClone(record);
    } else {
      clone = JSON.parse(JSON.stringify(record));
    }
    if (typeof deps.normalizeRecord === "function") {
      try {
        deps.normalizeRecord(clone);
      } catch {
        // A normalization failure must never drop the raw record.
      }
    }
    return restoreNativeRecordTypes(clone);
  }

  // Raw-record export backing the native store's "recalled only" view
  // (called by the main-process IPC handler getNativeRecallRecords). Same
  // strict scope rules and filters as getHistory, but every item is a full
  // clone of the stored entry.msg: msgId, msgSeq, chatType, peerUid, msgTime
  // and elements keep their original shape and values. Only the current page
  // is cloned/normalized; nothing beyond it is copied or stat'ed.
  async function getNativeRecords(query) {
    const peerUid = typeof query?.peerUid === "string" ? query.peerUid.trim() : "";
    const chatType = normalizeChatType(query?.chatType);
    let limit = Math.floor(Number(query?.limit));
    if (!Number.isFinite(limit) || limit < 1) limit = NATIVE_DEFAULT_PAGE_LIMIT;
    if (limit > NATIVE_MAX_PAGE_LIMIT) limit = NATIVE_MAX_PAGE_LIMIT;
    let offset = Math.floor(Number(query?.offset));
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    const keyword =
      typeof query?.keyword === "string"
        ? query.keyword.slice(0, MAX_KEYWORD_LENGTH).trim().toLowerCase()
        : "";
    const type = VALID_HISTORY_TYPES.has(query?.type) ? query.type : "all";

    const emptyResult = { peerUid, chatType, records: [], total: 0, hasMore: false, offset, limit };
    // Invalid scope must never fall back to a global search.
    if (!peerUid || !chatType) return emptyResult;

    const summaries = await collectPeerSummaries(peerUid, chatType, type, keyword, {
      filterSendersUid: query?.filterSendersUid,
      filterMsgFromMs: filterTimeToMs(query?.filterMsgFromTime),
      filterMsgToMs: filterTimeToMs(query?.filterMsgToTime),
    });
    const total = summaries.length;
    const page = summaries.slice(offset, offset + limit);
    const records = page.map((summary) => cloneRawRecord(summary.record));
    return {
      peerUid,
      chatType,
      records,
      total,
      hasMore: offset + limit < total,
      offset,
      limit,
    };
  }

  async function getHistory(query) {
    // Strict: a non-string peerUid yields an empty result instead of being
    // coerced into something like "[object Object]".
    const peerUid = typeof query?.peerUid === "string" ? query.peerUid.trim() : "";
    const chatType = normalizeChatType(query?.chatType);
    let limit = Math.floor(Number(query?.limit));
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_PAGE_LIMIT;
    if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT;
    let offset = Math.floor(Number(query?.offset));
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    const keyword =
      typeof query?.keyword === "string"
        ? query.keyword.slice(0, MAX_KEYWORD_LENGTH).trim().toLowerCase()
        : "";
    const type = VALID_HISTORY_TYPES.has(query?.type) ? query.type : "all";

    const emptyResult = { peerUid, chatType, items: [], total: 0, hasMore: false, offset, limit };
    // Invalid scope must never fall back to a global search.
    if (!peerUid || !chatType) return emptyResult;

    const summaries = await collectPeerSummaries(peerUid, chatType, type, keyword);
    const total = summaries.length;
    const page = summaries.slice(offset, offset + limit);
    const items = page.map(assembleItem);
    return {
      peerUid,
      chatType,
      items,
      total,
      hasMore: offset + limit < total,
      offset,
      limit,
    };
  }

  function invalidateCache() {
    entryCacheById = new Map();
    summaryCache = new WeakMap();
    peerAggCache = null;
  }

  return { getContext, getHistory, getNativeRecords, invalidateCache };
}

module.exports = { createRecallHistory };
