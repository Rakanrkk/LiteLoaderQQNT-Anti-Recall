import { createRecordStoreAdapter } from "./recordStoreAdapter.js";

let cleanup = null;
let installed = false;

function findRecordComponent() {
  return document.querySelector(".record-all-msg")?.__VUE__?.find(
    (component) => typeof component.ctx?.targetToChat === "function" && component.props?.chatInfo
  ) || null;
}

export function installHistoryWindowLauncher() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let observer = null;
  let scheduled = false;

  function disposeEntry() {
    cleanup?.();
    cleanup = null;
  }

  function mount() {
    scheduled = false;
    if (!/^#\/record(?:[/?]|$)/.test(location.hash)) return;
    const toolbar = document.querySelector(".record-search");
    const component = findRecordComponent();
    if (!toolbar || !component || toolbar.querySelector(".anti-recall-history-entry")) return;
    disposeEntry();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "q-button q-button--secondary q-button--small anti-recall-history-entry";
    button.textContent = "仅看撤回";
    button.setAttribute("aria-pressed", "false");
    button.title = "在原生聊天记录中筛选插件保存的撤回消息";
    button.style.cssText = "flex:0 0 auto;margin-left:12px;padding:4px 10px;height:24px;line-height:16px;font-size:12px;white-space:nowrap;-webkit-app-region:no-drag;";
    const update = document.createElement("button");
    update.type = "button";
    update.className = "q-button q-button--secondary q-button--small anti-recall-native-update";
    update.textContent = "更新";
    update.hidden = true;
    update.style.cssText = "flex:0 0 auto;margin-left:6px;padding:4px 8px;height:24px;font-size:12px;-webkit-app-region:no-drag;";

    const adapter = createRecordStoreAdapter({
      component,
      api: window.anti_recall,
      onState(state) {
        button.setAttribute("aria-pressed", String(Boolean(state.active)));
        button.textContent = state.loading ? "筛选中…" : state.active ? `仅看撤回 · ${state.total || 0}` : "仅看撤回";
        button.style.color = state.active ? "var(--brand_standard, #0099ff)" : "";
        button.title = state.error ? "读取失败，点击关闭筛选后重试" : "点击切换；消息样式及跳转由 QQ 原生提供";
        if (!state.active) update.hidden = true;
      },
    });

    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (adapter.active) await adapter.disable();
        else {
          const record = document.querySelector(".record")?.__VUE__?.find((item) => item.setupState?.currentTab != null);
          if (record && record.setupState.currentTab !== "all") {
            record.setupState.currentTab = "all";
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          await adapter.enable();
        }
      } catch (error) {
        button.title = "读取失败，请重试";
        console.log("[Anti-Recall] 原生撤回筛选失败", error);
      } finally {
        button.disabled = false;
      }
    });
    update.addEventListener("click", async () => {
      update.disabled = true;
      try {
        await adapter.refresh();
        update.hidden = true;
      } finally { update.disabled = false; }
    });
    const unsubscribe = window.anti_recall?.recallHistoryChanged?.((_event, info) => {
      if (!adapter.active) return;
      const peer = component.props.chatInfo;
      if (info && (String(info.peerUid) !== String(peer?.peerUid) || Number(info.chatType) !== Number(peer?.chatType))) return;
      update.hidden = false;
      update.title = "有新保存的撤回消息，点击更新；列表不会自动刷新";
    });
    toolbar.append(button, update);
    cleanup = () => {
      adapter.dispose();
      unsubscribe?.();
      button.remove();
      update.remove();
    };
  }

  function schedule(changes) {
    if (scheduled) return;
    const entry = document.querySelector(".anti-recall-history-entry");
    if (entry?.isConnected) return;
    if (changes && !changes.some((change) => change.addedNodes.length)) return;
    scheduled = true;
    queueMicrotask(mount);
  }

  function watchRoute() {
    observer?.disconnect();
    observer = null;
    if (!/^#\/record(?:[/?]|$)/.test(location.hash)) {
      disposeEntry();
      return;
    }
    mount();
    observer = new MutationObserver(schedule);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener("hashchange", watchRoute);
  window.navigation?.addEventListener("navigatesuccess", watchRoute);
  window.addEventListener("beforeunload", () => {
    observer?.disconnect();
    disposeEntry();
    window.removeEventListener("hashchange", watchRoute);
    window.navigation?.removeEventListener("navigatesuccess", watchRoute);
  }, { once: true });
  watchRoute();
}
