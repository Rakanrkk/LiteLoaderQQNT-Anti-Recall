"use strict";

function nativeMap(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) return new Map(value.filter((entry) => Array.isArray(entry) && entry.length === 2));
  return new Map(Object.entries(value && typeof value === "object" ? value : {}).map(([key, item]) => [
    /^\d+$/.test(key) && Number.isSafeInteger(Number(key)) ? Number(key) : key,
    item,
  ]));
}

function nativeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value?.type === "Buffer" && Array.isArray(value.data)) return Uint8Array.from(value.data);
  const entries = Object.entries(value && typeof value === "object" ? value : {})
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right));
  return Uint8Array.from(entries.map(([, item]) => item));
}

// Level's JSON encoding erases Map and typed-array identity. QQ's own message
// renderer calls msgAttrs.get() while mounting; a plain object makes the entire
// native bubble fail to mount. Restore types on the query/recovery copy only.
function restoreNativeRecordTypes(record) {
  if (!record || typeof record !== "object") return record;
  record.msgAttrs = nativeMap(record.msgAttrs);
  record.msgMeta = nativeBytes(record.msgMeta);
  record.generalFlags = nativeBytes(record.generalFlags);
  for (const element of Array.isArray(record.elements) ? record.elements : []) {
    if (!element || typeof element !== "object") continue;
    element.extBufForUI = nativeBytes(element.extBufForUI);
    if (element.picElement) element.picElement.thumbPath = nativeMap(element.picElement.thumbPath);
  }
  return record;
}

module.exports = { restoreNativeRecordTypes };
