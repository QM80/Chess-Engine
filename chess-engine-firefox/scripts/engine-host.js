"use strict";

const engineApi = chrome;

engineApi.runtime.onConnect.addListener((port) => {
  if (port.name !== "bsc-engine-client") return;

  let worker = null;
  let ready = false;
  let active = null;
  let queued = null;
  let lastDepth = 0;
  let activeAt = 0;
  let stopSent = false;

  function spawn() {
    ready = false;
    try {
      const script = engineApi.runtime.getURL("engine/stockfish-19-lite-single.js");
      const wasm = engineApi.runtime.getURL("engine/stockfish-19-lite-single.wasm");
      worker = new Worker(script + "#" + encodeURIComponent(wasm));
    } catch (error) {
      worker = null;
      port.postMessage({ type: "error", error: "Local engine unavailable: " + error.message });
      return false;
    }
    worker.onmessage = onWorkerMessage;
    worker.onerror = (event) => {
      port.postMessage({ type: "error", error: "Local engine failed: " + (event.message || "worker error") });
    };
    try { worker.postMessage("uci"); } catch (_) {}
    return true;
  }

  function start() {
    if (!ready || active || !queued || !worker) return;
    active = queued;
    queued = null;
    lastDepth = 0;
    activeAt = Date.now();
    stopSent = false;
    try {
      worker.postMessage("position fen " + active.fen);
      worker.postMessage("go depth " + active.depth + " movetime " + active.movetime);
    } catch (_) {}
  }

  function onWorkerMessage(event) {
    const line = String(event.data || "");
    if (line === "uciok") {
      try { worker.postMessage("isready"); } catch (_) {}
      return;
    }
    if (line === "readyok") {
      ready = true;
      start();
      return;
    }
    if (line.indexOf("BSC_ENGINE_ERR:") === 0) {
      port.postMessage({ type: "error", error: line.slice(15) });
      return;
    }
    if (line.indexOf("info depth ") === 0) {
      const match = line.match(/^info depth (\d+)/);
      if (match) lastDepth = Number(match[1]);
      return;
    }
    if (line.indexOf("bestmove") === 0) {
      const job = active;
      active = null;
      stopSent = false;
      if (job) {
        const match = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)/i);
        try {
          port.postMessage({
            type: "result",
            id: job.id,
            fen: job.fen,
            move: match ? match[1].toLowerCase() : null,
            depth: lastDepth
          });
        } catch (_) {}
      }
      start();
    }
  }

  const watchdog = setInterval(() => {
    if (!active) return;
    const elapsed = Date.now() - activeAt;
    if (elapsed > 6000 && !stopSent) {
      stopSent = true;
      try { worker.postMessage("stop"); } catch (_) {}
      return;
    }
    if (elapsed > 10000) {
      const job = active;
      active = null;
      stopSent = false;
      queued = queued || (job ? { id: job.id, fen: job.fen, depth: job.depth, movetime: job.movetime } : null);
      try { port.postMessage({ type: "error", error: "engine timed out — restarting" }); } catch (_) {}
      try { worker.terminate(); } catch (_) {}
      worker = null;
      spawn();
    }
  }, 500);

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ping") {
      try { port.postMessage({ type: "pong" }); } catch (_) {}
      return;
    }
    if (!worker && !spawn()) return;
    if (msg.type === "eval") {
      queued = {
        id: msg.id,
        fen: msg.fen,
        depth: Math.max(1, Math.min(100, Number(msg.depth) || 18)),
        movetime: Math.max(200, Math.min(10000, Number(msg.movetime) || 1500))
      };
      if (active) {
        try { worker.postMessage("stop"); } catch (_) {}
      } else {
        start();
      }
    } else if (msg.type === "cancel") {
      queued = null;
      if (active) {
        try { worker.postMessage("stop"); } catch (_) {}
      }
    }
  });

  port.onDisconnect.addListener(() => {
    clearInterval(watchdog);
    try { void engineApi.runtime.lastError; } catch (_) {}
    if (worker) {
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }
  });
});
