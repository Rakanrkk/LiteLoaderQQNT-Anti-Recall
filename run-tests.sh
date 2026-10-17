#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for file in main.js preload.js renderer.js imgDownloader.js rkeyManager.js imageStore.js eventParser.js priorityTaskQueue.js recallHistory.js nativeRecord.js recordStoreAdapter.js windowLauncher.js; do
    node --check "$SCRIPT_DIR/$file"
done

for test in test-priority-task-queue.js test-event-parser.js test-rkey-manager.js test-global-capture.js test-image-persistence.js test-recall-history.js test-native-record-types.js test-record-store-adapter.mjs test-native-filter-conditions.mjs; do
    node "$SCRIPT_DIR/tests/$test"
done

if [ "${RUN_NETWORK_TESTS:-0}" = "1" ]; then
    node "$SCRIPT_DIR/tests/test-img-downloader.js"
else
    printf 'SKIP: downloader loopback test (run with RUN_NETWORK_TESTS=1).\n'
fi
printf 'ALL_TESTS_OK\n'
