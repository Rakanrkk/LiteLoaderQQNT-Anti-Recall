# Verification and scope

Tested on 2026-10-17 with macOS arm64, QQ 7.0.2 build 53644 from the Mac App Store, and LiteLoaderQQNT 1.4.1. Other QQ builds, Intel Macs, Windows and Linux have not been manually verified for the native history filter.

## Native integration

The plugin adds a “仅看撤回” toggle to QQ's existing `#/record` search bar. The active per-window record store receives complete stored QQ message records grouped as `{date, list}`. QQ retains responsibility for its message rendering, search controls, sender/date controls and `targetToChat` action. Turning the filter off restores the original store descriptors and state. Ordinary incoming messages do not refresh the recalled-record view; new recalls only show an update prompt.

Manual testing identified and fixed two issues that the initial synthetic view did not model:

1. Calling a saved raw store setter bypassed Vue's reactive Proxy notification. Production writes now use the store's property assignment path, with an explicit guard for plugin updates. A dedicated reactive-store regression reproduces the original failure and verifies the fix.
2. JSON persistence erases `Map` and typed-array identity. QQ's native `showMemberLabel` called `msgAttrs.get()` and aborted message mounting. Query/recovery copies now restore `msgAttrs` and picture `thumbPath` maps, plus native byte-array fields, without changing IDs, sequence numbers, message contents or the stored source objects.

The native message renderer was observed mounting archived text and image records after type restoration. Native jump was manually exercised and the user confirmed that it worked. The user subsequently reported that the final appearance was normal. No messages were sent or recalled on the user's behalf to perform these checks.

The original group-message fallback was also changed to inherit QQ's native message column instead of adding hard-coded avatar margins twice. General wrapper CSS is scoped to chat message rows so it does not affect the native history page.

## Automated checks

`npm test` runs syntax checks and synthetic regressions for the queue, event parsing, rkey handling, cross-window capture, image persistence, history queries, native type restoration, native store adaptation, and sender/date filtering. The final native-specific suites cover:

- 9 typed-record restoration cases, including JSON round trips, maps/bytes, source immutability and string IDs above JavaScript's safe integer range.
- 13 store-adapter cases, including reversible descriptors, paging, stale results, untouched native jump methods and reactive property writes.
- 8 native sender/date condition cases, including fresh computed-array references and restoration after toggling off and on.

`tests/test-native-record-filter.mjs` runs 13 browser integration assertions against a wholly synthetic native record page. It imports the real launcher/adapter and checks query scope, native jump method identity, raw ID/sequence preservation, normal-message inactivity, explicit updates, search and restoration. It needs a repository-root static server and Chrome/Chromium.

The optional downloader suite makes only loopback HTTP requests. Mocked unit tests do not contact public rkey services. The clean `level` dependency is separately smoke-tested using a temporary database for JSON write/read and index streaming; no real QQ database is used. The inherited capture baseline writes a size-limited local diagnostic log containing event metadata and truncated identifier hashes, not message text. That runtime file is excluded from this repository.

## Publication boundary

This repository contains source, dependency metadata and synthetic tests. It excludes QQ binaries, LiteLoader's loader payload, bundled `node_modules`, chat databases, preserved images, account information, credentials, diagnostic logs, local backups and temporary runtime probes. The installed user's plugin data was retained. No upstream pull request is opened as part of this development branch.
