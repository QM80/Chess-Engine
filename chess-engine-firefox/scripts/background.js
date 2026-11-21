const api = chrome;
const LAST = { move: null, depth: null, fen: null, ts: 0 };
let engineHostStarting = null;

async function ensureEngineHost() {
  if (!api.offscreen) return;
  const url = api.runtime.getURL("scripts/engine-host.html");
  if (api.runtime.getContexts) {
    const contexts = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (contexts.length) return;
  } else if (await api.offscreen.hasDocument()) return;
  if (!engineHostStarting) {
    engineHostStarting = api.offscreen.createDocument({
      url: "scripts/engine-host.html", reasons: ["WORKERS"],
      justification: "Run the bundled chess engine in a local worker"
    }).finally(() => { engineHostStarting = null; });
  }
  await engineHostStarting;
}


function storageSet(obj) {
  if (api.storage && api.storage.session) {
    return api.storage.session.set(obj).catch(() => api.storage.local.set(obj));
  }
  return api.storage.local.set(obj);
}

function storageGet(key) {
  if (api.storage && api.storage.session) {
    return api.storage.session.get(key).catch(() => api.storage.local.get(key));
  }
  return api.storage.local.get(key);
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "prepareEngine") {
    ensureEngineHost().then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (msg.type === "analysisResult") {
    LAST.move = msg.move;
    LAST.depth = msg.depth;
    LAST.fen = msg.fen;
    LAST.ts = Date.now();
    storageSet({ lastAnalysis: LAST }).catch(() => {});
    try {
      api.runtime.sendMessage({
        type: "liveMove",
        move: msg.move,
        depth: msg.depth
      }, () => { void api.runtime.lastError; });
    } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "getLast") {
    storageGet("lastAnalysis").then((data) => {
      sendResponse({ ok: true, data: (data && data.lastAnalysis) || LAST });
    }).catch(() => sendResponse({ ok: true, data: LAST }));
    return true;
  }

  if (msg.type === "start" || msg.type === "stop" || msg.type === "status" ||
      msg.type === "setDepth" || msg.type === "setAuto" || msg.type === "setHud") {
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        sendResponse({ ok: false, error: "no active tab" });
        return;
      }
      const u = tab.url || "";
      if (!(u.includes("chess.com") || u.includes("lichess.org"))) {
        sendResponse({ ok: false, error: "open chess.com or lichess" });
        return;
      }
      api.tabs.sendMessage(tab.id, msg, (resp) => {
        if (api.runtime.lastError) {
          sendResponse({ ok: false, error: "Refresh tab | Wait for game to load" });
        } else {
          sendResponse(resp || { ok: true });
        }
      });
    });
    return true;
  }
});