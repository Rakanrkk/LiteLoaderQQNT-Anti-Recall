"use strict";

// Regression tests for native record type restoration (nativeRecord.js +
// recallHistory.getNativeRecords). QQ's own native renderer calls
// msgAttrs.get() while mounting the recalled bubble; after the JSON/Level
// roundtrip a Map has degenerated into a plain object and the whole native
// mount fails with "TypeError: ... is not a function". These tests pin the
// restoration contract and prove that raw queries hand back typed clones
// without ever mutating the cached source records.

const assert = require("assert");
const path = require("path");

const PLUGIN_DIR = path.join(
  __dirname,
  ".."
);
const { restoreNativeRecordTypes } = require(path.join(PLUGIN_DIR, "nativeRecord.js"));
const { createRecallHistory } = require(path.join(PLUGIN_DIR, "recallHistory.js"));

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("ok - " + name);
  } catch (err) {
    failures += 1;
    console.error("FAIL - " + name);
    console.error(
      "  " + (err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n  ") : String(err))
    );
  }
}

function jsonRoundtrip(value) {
  return JSON.parse(JSON.stringify(value));
}

// Expected restoration of a {0: .., 1: ..}-shaped JSON byte object, as a
// plain array (comparable with Array.from(restored) via deepStrictEqual).
function bytesOf(obj) {
  return Object.keys(obj)
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => obj[key]);
}

(async () => {
  // -----------------------------------------------------------------------
  // restoreNativeRecordTypes: Map / typed-array restoration contract.
  // -----------------------------------------------------------------------

  await test("restoreNativeRecordTypes: existing Map kept by identity; JSON-lost entries unrecoverable but at least a working Map", () => {
    const existing = new Map([
      [1, "a"],
      ["k", "b"],
    ]);
    const record = restoreNativeRecordTypes({ msgAttrs: existing });
    assert.ok(record.msgAttrs instanceof Map, "existing Map must stay a Map");
    assert.strictEqual(record.msgAttrs, existing, "existing Map must be preserved by identity");

    // The storage path: JSON stringify/parse erases Map entries entirely
    // ({}), so they are unrecoverable — but the restored field must still be
    // a real Map so msgAttrs.get() exists and the native bubble can mount.
    const stored = jsonRoundtrip({ msgAttrs: existing });
    assert.deepStrictEqual(stored.msgAttrs, {}, "precondition: JSON loses Map entries");
    const restored = restoreNativeRecordTypes(stored);
    assert.ok(restored.msgAttrs instanceof Map, "plain msgAttrs must become a Map");
    assert.strictEqual(typeof restored.msgAttrs.get, "function", "Map.get must exist");
    assert.strictEqual(restored.msgAttrs.size, 0, "lost entries are unrecoverable");
  });

  await test("restoreNativeRecordTypes: plain-object numeric keys become numbers, string keys stay strings", () => {
    const record = restoreNativeRecordTypes({
      msgAttrs: { 1: "one", 22: "two", peerTag: "tag" },
    });
    assert.ok(record.msgAttrs instanceof Map);
    assert.strictEqual(record.msgAttrs.get(1), "one", "numeric key must convert to number");
    assert.strictEqual(record.msgAttrs.get(22), "two");
    assert.strictEqual(record.msgAttrs.get("peerTag"), "tag", "string key must stay a string");
    assert.deepStrictEqual(
      Array.from(record.msgAttrs.keys()).map(String).sort(),
      ["1", "22", "peerTag"],
      "key set must be complete"
    );

    // Array-of-pairs form is also a valid Map source.
    const pairs = restoreNativeRecordTypes({
      msgAttrs: [[1, "a"], ["k", "b"], ["bad"]],
    });
    assert.ok(pairs.msgAttrs instanceof Map);
    assert.strictEqual(pairs.msgAttrs.get(1), "a");
    assert.strictEqual(pairs.msgAttrs.get("k"), "b");
    assert.strictEqual(pairs.msgAttrs.size, 2, "malformed pairs are dropped");
  });

  await test("restoreNativeRecordTypes: Uint8Array from array, Buffer-like and JSON numeric object; existing bytes kept by identity", () => {
    const record = restoreNativeRecordTypes({
      msgMeta: { 0: 10, 1: 20, 2: 30 },
      generalFlags: { type: "Buffer", data: [4, 5, 6] },
      elements: [{ extBufForUI: [7, 8, 9] }],
    });
    assert.ok(record.msgMeta instanceof Uint8Array, "JSON numeric object must become Uint8Array");
    assert.deepStrictEqual(Array.from(record.msgMeta), [10, 20, 30]);
    assert.ok(record.generalFlags instanceof Uint8Array, "Buffer-like must become Uint8Array");
    assert.deepStrictEqual(Array.from(record.generalFlags), [4, 5, 6]);
    assert.ok(
      record.elements[0].extBufForUI instanceof Uint8Array,
      "array must become Uint8Array"
    );
    assert.deepStrictEqual(Array.from(record.elements[0].extBufForUI), [7, 8, 9]);

    const keptMap = new Map([[0, { url: "u" }]]);
    const keptBytes = Uint8Array.from([1, 2, 3]);
    const keptBytes2 = Uint8Array.from([9]);
    const kept = restoreNativeRecordTypes({
      msgAttrs: keptMap,
      msgMeta: keptBytes,
      elements: [{ extBufForUI: keptBytes2, picElement: { thumbPath: keptMap } }],
    });
    assert.strictEqual(kept.msgAttrs, keptMap, "already-typed Map must not be rebuilt");
    assert.strictEqual(kept.msgMeta, keptBytes, "already-typed bytes must not be rebuilt");
    assert.strictEqual(kept.elements[0].extBufForUI, keptBytes2);
    assert.strictEqual(kept.elements[0].picElement.thumbPath, keptMap);
  });

  await test("restoreNativeRecordTypes: pic.thumbPath plain object becomes a Map with numeric keys", () => {
    const record = restoreNativeRecordTypes({
      elements: [
        {
          picElement: {
            fileName: "a.png",
            thumbPath: { 0: { url: "thumb-0" }, big: { url: "b" } },
          },
        },
      ],
    });
    const thumbPath = record.elements[0].picElement.thumbPath;
    assert.ok(thumbPath instanceof Map, "thumbPath must become a Map");
    assert.deepStrictEqual(thumbPath.get(0), { url: "thumb-0" }, "numeric key converted");
    assert.deepStrictEqual(thumbPath.get("big"), { url: "b" }, "string key preserved");
  });

  await test("restoreNativeRecordTypes: empty and invalid records are tolerated", () => {
    for (const value of [null, undefined, 42, "record", true]) {
      assert.strictEqual(restoreNativeRecordTypes(value), value, "non-objects returned as-is");
    }
    const empty = restoreNativeRecordTypes({});
    assert.ok(empty.msgAttrs instanceof Map, "missing msgAttrs becomes an empty Map");
    assert.ok(empty.msgMeta instanceof Uint8Array, "missing msgMeta becomes an empty Uint8Array");
    assert.ok(empty.generalFlags instanceof Uint8Array);
    assert.strictEqual(empty.msgMeta.length, 0);

    // Malformed fields must never throw.
    const weird = restoreNativeRecordTypes({ elements: null, msgAttrs: "junk" });
    assert.ok(weird.msgAttrs instanceof Map, "junk msgAttrs still becomes a Map");
    assert.strictEqual(typeof weird.msgAttrs.get, "function");
    assert.strictEqual(restoreNativeRecordTypes({ elements: [null, undefined, "x", 3] }).elements.length, 4);
    const partial = restoreNativeRecordTypes({ elements: [{}, { picElement: null }] });
    assert.strictEqual(partial.elements[0].extBufForUI.length, 0);
    assert.strictEqual(partial.elements[1].extBufForUI.length, 0);
  });

  // -----------------------------------------------------------------------
  // getNativeRecords: typed clones, untouched sources, precise ids, DTO.
  // -----------------------------------------------------------------------

  const PEER_UID = "u_recalled_peer_01";
  const CHAT_TYPE = 1;
  const BASE_ID = 9007199254740993n; // 2^53 + 1: any Number coercion loses precision.

  const recordsById = new Map();
  const knownIds = [];
  for (let i = 0; i < 20; i += 1) {
    const msgId = (BASE_ID + BigInt(i)).toString();
    const elements = [];
    if (i % 5 === 0) {
      // Mixed text+image message.
      elements.push({ textElement: { content: `hello ${i}` } });
      elements.push({
        picElement: {
          fileName: `pic-${i}.png`,
          picWidth: 640,
          picHeight: 480,
          thumbPath: { 0: { url: `thumb://${i}` } },
        },
        extBufForUI: { 0: i % 256, 1: (i + 1) % 256 },
      });
    } else if (i % 3 === 1) {
      elements.push({
        picElement: {
          fileName: `pic-${i}.jpg`,
          picWidth: 320,
          picHeight: 240,
          thumbPath: { 0: { url: `thumb://${i}` } },
        },
        extBufForUI: { 0: i % 256 },
      });
    } else {
      elements.push({ textElement: { content: `plain text ${i}` } });
    }
    // Simulate what persistence actually hands back: every Map/typed field
    // has degenerated through the JSON roundtrip.
    const record = jsonRoundtrip({
      msgId,
      msgSeq: 100 + i,
      chatType: CHAT_TYPE,
      peerUid: PEER_UID,
      peerUin: "10001",
      senderUid: `sender-uid-${i}`,
      senderUin: String(20000 + i),
      sendNickName: `nick-${i}`,
      msgTime: 1700000000 + i,
      msgAttrs: { 1: { name: `attr-${i}` }, tag: `t-${i}` },
      msgMeta: { 0: i % 256, 1: (i + 1) % 256 },
      generalFlags: { 0: 7 },
      elements,
    });
    // One intentionally minimal record: no attrs/meta/elements at all.
    if (i === 19) {
      delete record.msgAttrs;
      delete record.msgMeta;
      delete record.generalFlags;
      record.elements = [];
    }
    recordsById.set(msgId, record);
    knownIds.push(msgId);
  }
  const expectedIds = knownIds.slice().sort();

  const history = createRecallHistory({
    getKnownRecalledIds: () => knownIds.slice(),
    findCachedMessage: async (id) =>
      recordsById.has(id)
        ? { entry: { id, msg: recordsById.get(id) }, source: "unit-test-cache" }
        : null,
    imageStore: { validPreservedPath: () => "", fileUrl: () => "" },
    isSaveDbEnabled: () => true,
  });

  await test("getNativeRecords: returns typed clones covering all 20 mixed records with precise >2^53 string ids", async () => {
    const result = await history.getNativeRecords({
      peerUid: PEER_UID,
      chatType: CHAT_TYPE,
      limit: 50,
    });
    assert.strictEqual(result.total, 20);
    assert.strictEqual(result.records.length, 20);
    assert.strictEqual(result.peerUid, PEER_UID);
    assert.strictEqual(result.chatType, CHAT_TYPE);
    assert.strictEqual(result.hasMore, false);
    assert.strictEqual(result.offset, 0);
    assert.strictEqual(result.limit, 50);

    const ids = result.records.map((record) => record.msgId);
    assert.deepStrictEqual(ids.slice().sort(), expectedIds, "every recalled id must be present");
    for (const id of ids) {
      assert.strictEqual(typeof id, "string", "msgId must stay a string");
      assert.ok(BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER), "ids must exceed 2^53");
      assert.strictEqual(String(BigInt(id)), id, "string id must be precise");
    }

    for (const record of result.records) {
      assert.ok(record.msgAttrs instanceof Map, "msgAttrs must be restored to a Map");
      assert.strictEqual(typeof record.msgAttrs.get, "function", "native mount needs msgAttrs.get");
      assert.ok(record.msgMeta instanceof Uint8Array, "msgMeta must be restored to Uint8Array");
      assert.ok(record.generalFlags instanceof Uint8Array, "generalFlags must be restored");
      for (const element of record.elements) {
        assert.ok(element.extBufForUI instanceof Uint8Array, "extBufForUI must be restored");
        if (element.picElement) {
          assert.ok(element.picElement.thumbPath instanceof Map, "thumbPath must be a Map");
        }
      }
    }

    // The minimal record (no attrs/meta/elements) must still come out typed.
    const minimal = result.records.find(
      (record) => record.msgId === (BASE_ID + 19n).toString()
    );
    assert.ok(minimal, "minimal record must be included");
    assert.ok(minimal.msgAttrs instanceof Map && minimal.msgAttrs.size === 0);
    assert.ok(minimal.msgMeta instanceof Uint8Array && minimal.msgMeta.length === 0);
    assert.deepStrictEqual(minimal.elements, []);
  });

  await test("getNativeRecords: sources are untouched and clones preserve id/seq/content exactly", async () => {
    const snapshots = new Map();
    for (const [id, record] of recordsById) {
      snapshots.set(id, JSON.stringify(record));
      assert.ok(!(record.msgAttrs instanceof Map), "precondition: source attrs is a plain object");
    }

    const result = await history.getNativeRecords({
      peerUid: PEER_UID,
      chatType: CHAT_TYPE,
      limit: 50,
    });

    for (const record of result.records) {
      const source = recordsById.get(record.msgId);
      assert.ok(source, "clone must map back to its source");
      assert.notStrictEqual(record, source, "returned record must be a clone, not the source");
      assert.strictEqual(record.msgSeq, source.msgSeq, "msgSeq unchanged");
      assert.strictEqual(record.chatType, source.chatType);
      assert.strictEqual(record.peerUid, source.peerUid);
      assert.strictEqual(record.senderUid, source.senderUid);
      assert.strictEqual(record.msgTime, source.msgTime);
      assert.strictEqual(record.elements.length, source.elements.length, "element count unchanged");

      if (source.msgAttrs) {
        assert.deepStrictEqual(
          Object.fromEntries(record.msgAttrs),
          source.msgAttrs,
          "restored attrs carry the same entries (numeric keys re-stringified)"
        );
      }
      if (source.msgMeta) {
        assert.deepStrictEqual(
          Array.from(record.msgMeta),
          bytesOf(source.msgMeta),
          "meta bytes match"
        );
      }
      source.elements.forEach((sourceElement, index) => {
        const cloneElement = record.elements[index];
        if (sourceElement.textElement) {
          assert.strictEqual(
            cloneElement.textElement.content,
            sourceElement.textElement.content,
            "text content unchanged"
          );
        }
        if (sourceElement.picElement) {
          assert.strictEqual(cloneElement.picElement.fileName, sourceElement.picElement.fileName);
          assert.strictEqual(cloneElement.picElement.picWidth, sourceElement.picElement.picWidth);
          assert.strictEqual(
            cloneElement.picElement.thumbPath.get(0).url,
            sourceElement.picElement.thumbPath["0"].url,
            "thumb url unchanged through key conversion"
          );
        }
        if (sourceElement.extBufForUI) {
          assert.deepStrictEqual(
            Array.from(cloneElement.extBufForUI),
            bytesOf(sourceElement.extBufForUI)
          );
        }
      });
    }

    // The cached sources themselves must be byte-identical to the snapshot.
    for (const [id, snapshot] of snapshots) {
      const source = recordsById.get(id);
      assert.strictEqual(JSON.stringify(source), snapshot, `source ${id} must be untouched`);
      assert.ok(!(source.msgAttrs instanceof Map), "source attrs must stay a plain object");
      assert.ok(!(source.msgMeta instanceof Uint8Array), "source meta must stay a plain object");
      assert.ok(
        !(source.elements[0] && source.elements[0].extBufForUI instanceof Uint8Array),
        "source extBufForUI must stay a plain object"
      );
    }
  });

  await test("getNativeRecords: invalid/empty scope and paging behave as before", async () => {
    for (const query of [
      null,
      {},
      { chatType: 1 },
      { peerUid: "   ", chatType: 1 },
      { peerUid: PEER_UID },
    ]) {
      const result = await history.getNativeRecords(query);
      assert.deepStrictEqual(result.records, [], "invalid scope must return no records");
      assert.strictEqual(result.total, 0);
    }
    const page = await history.getNativeRecords({
      peerUid: PEER_UID,
      chatType: CHAT_TYPE,
      limit: 5,
      offset: 5,
    });
    assert.strictEqual(page.records.length, 5);
    assert.strictEqual(page.total, 20);
    assert.strictEqual(page.hasMore, true);
    const tail = await history.getNativeRecords({
      peerUid: PEER_UID,
      chatType: CHAT_TYPE,
      limit: 5,
      offset: 18,
    });
    assert.strictEqual(tail.records.length, 2);
    assert.strictEqual(tail.hasMore, false);
  });

  await test("getHistory DTO shape is unchanged (no raw typed fields leak into the DTO)", async () => {
    const result = await history.getHistory({ peerUid: PEER_UID, chatType: CHAT_TYPE, limit: 50 });
    assert.strictEqual(result.total, 20);
    assert.strictEqual(result.items.length, 20);
    assert.deepStrictEqual(
      result.items.map((item) => item.id).sort(),
      expectedIds,
      "DTO ids must be the same precise string ids"
    );

    const DTO_KEYS = [
      "id",
      "peerUid",
      "chatType",
      "senderName",
      "senderUid",
      "senderUin",
      "time",
      "text",
      "types",
      "elements",
    ].sort();
    for (const item of result.items) {
      assert.deepStrictEqual(Object.keys(item).sort(), DTO_KEYS, "DTO keys must be unchanged");
      assert.ok(!("msgAttrs" in item) && !("msgMeta" in item), "raw record fields must not leak");
      assert.strictEqual(typeof item.id, "string");
      for (const element of item.elements) {
        if (element.type === "text") {
          assert.deepStrictEqual(Object.keys(element).sort(), ["text", "type"]);
        } else if (element.type === "image") {
          assert.deepStrictEqual(Object.keys(element).sort(), [
            "fileName",
            "fileUrl",
            "height",
            "type",
            "unavailable",
            "width",
          ]);
          assert.strictEqual(element.unavailable, true, "stub imageStore marks image unavailable");
        } else {
          // "other" placeholder elements (e.g. the empty minimal record).
          assert.deepStrictEqual(Object.keys(element).sort(), ["label", "type"]);
        }
      }
    }

    const mixed = result.items.find((item) => item.id === BASE_ID.toString());
    assert.ok(mixed, "mixed record must be present");
    assert.deepStrictEqual(mixed.types, ["text", "image"]);
    assert.deepStrictEqual(
      mixed.elements.map((element) => element.type),
      ["text", "image"]
    );
  });
})()
  .then(() => {
    console.log(
      `\nnative-record-types: ${passed} passed, ${failures} failed`
    );
    process.exitCode = failures ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
