(function () {
  "use strict";
  if (window.__bscBridge) return;
  window.__bscBridge = true;

  function isLichess() {
    return location.hostname.indexOf("lichess.org") >= 0;
  }

  function boardElement() {
    if (isLichess()) return document.querySelector("cg-board") || document.querySelector(".cg-wrap");
    return document.querySelector("wc-chess-board") ||
           document.querySelector("chess-board") ||
           document.querySelector("#board-single") ||
           document.querySelector("#board");
  }

  function lichessFullFen() {
    const candidates = [];
    try {
      if (window.lichess && window.lichess.analysis && window.lichess.analysis.node)
        candidates.push(window.lichess.analysis.node.fen);
    } catch (_) {}
    try {
      if (window.site && window.site.analysis && window.site.analysis.node)
        candidates.push(window.site.analysis.node.fen);
    } catch (_) {}
    try {
      const input = document.querySelector("input.fen");
      if (input && typeof input.value === "string") candidates.push(input.value);
    } catch (_) {}
    try {
      const board = boardElement();
      const placement = board ? board.getAttribute("data-fen") : null;
      if (placement) {
        const running = document.querySelector(".rclock.running");
        const cls = running ? String(running.className || "") : "";
        if (cls.indexOf("rclock-white") >= 0) candidates.push(placement + " w - - 0 1");
        else if (cls.indexOf("rclock-black") >= 0) candidates.push(placement + " b - - 0 1");
      }
    } catch (_) {}
    for (let i = 0; i < candidates.length; i++) {
      const value = candidates[i];
      if (typeof value !== "string") continue;
      const fields = value.trim().split(/\s+/);
      if (fields.length === 6 && /^[wb]$/.test(fields[1])) return value.trim();
    }
    return null;
  }

  function chessComFullFen() {
    const board = boardElement();
    try {
      if (board && board.game && typeof board.game.getFEN === "function") {
        const fen = String(board.game.getFEN() || "").trim();
        const fields = fen.split(/\s+/);
        if (fields.length === 6 && /^[wb]$/.test(fields[1])) return fen;
      }
    } catch (_) {}
    return null;
  }

  function report() {
    let fen = null;
    try {
      fen = isLichess() ? lichessFullFen() : chessComFullFen();
    } catch (_) {
      fen = null;
    }
    window.postMessage({
      source: "bsc-bridge",
      type: "fen",
      data: fen ? { fen: fen, site: isLichess() ? "lichess" : "chesscom" } : null
    }, "*");
  }

  report();

  const obs = new MutationObserver(function () {
    if (window.__bscBridgeDebounce) clearTimeout(window.__bscBridgeDebounce);
    window.__bscBridgeDebounce = setTimeout(report, 120);
  });

  function startObs() {
    const board = boardElement();
    if (!board) {
      setTimeout(startObs, 500);
      return;
    }
    try {
      obs.observe(board, { childList: true, subtree: true, attributes: true });
    } catch (_) {
      setTimeout(startObs, 500);
    }
  }
  startObs();

  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.source !== "bsc-content") return;
    if (ev.data.type === "ping") report();
  });
})();
