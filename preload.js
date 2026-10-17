const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("anti_recall", {
    clearDb: () => ipcRenderer.invoke("LiteLoader.anti_recall.clearDb"),
    getNowConfig: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getNowConfig"),
    saveConfig: (config) =>
        ipcRenderer.invoke("LiteLoader.anti_recall.saveConfig", config),
    getRecalledMsgIds: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getRecalledMsgIds"),
    getRecalledGroupImageIds: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getRecalledGroupImageIds"),
    getRecalledGroupImages: (msgId) =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getRecalledGroupImages", msgId),
    getRecallHistoryContext: (payload) =>
        ipcRenderer.invoke(
            "LiteLoader.anti_recall.getRecallHistoryContext",
            payload
        ),
    getRecallHistory: (query) =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getRecallHistory", query),
    getNativeRecallRecords: (query) =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getNativeRecallRecords", query),
    recallHistoryChanged: (callback) => {
        if (typeof callback !== "function") return () => {};
        // Contract: callback(null, payload) — payload is {peerUid, chatType}
        // or null after clearDb. The Electron event is never forwarded.
        const listener = (_event, payload) => callback(null, payload);
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.recallHistoryChanged",
            listener
        );
        return () => {
            ipcRenderer.removeListener(
                "LiteLoader.anti_recall.mainWindow.recallHistoryChanged",
                listener
            );
        };
    },
    repatchCss: (callback) =>
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.repatchCss",
            callback
        ),
    recallTip: (callback) =>
        ipcRenderer.on("LiteLoader.anti_recall.mainWindow.recallTip", callback),
    recallTipList: (callback) =>
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.recallTipList",
            callback
        ),
    recalledImageReady: (callback) =>
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.recalledImageReady",
            callback
        )
});
