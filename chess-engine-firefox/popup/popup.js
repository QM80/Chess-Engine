(() => {
  "use strict";
  const api = chrome;

  const depthInput = document.getElementById("depth");
  const hudCheck = document.getElementById("hud");
  const autoCheck = document.getElementById("auto");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const moveDisplay = document.getElementById("moveDisplay");
  const metaDisplay = document.getElementById("metaDisplay");
  const statusLine = document.getElementById("statusLine");

  function getDepth() {
    const v = parseInt(depthInput.value, 10);
    if (isNaN(v)) return 18;
    return Math.max(1, Math.min(100, v));
  }

  function setStatus(text, on) {
    statusLine.innerHTML = text;
    statusLine.classList.toggle("on", !!on);
  }

  function showMove(move, depth) {
    if (!move) {
      moveDisplay.innerHTML = "<span style='color: #F3F6FB;'>—</span>";
      metaDisplay.innerHTML = "waiting";
      return;
    }
    const promo = move.length > 4 ? "=" + move[4].toUpperCase() : "";
    moveDisplay.innerHTML = `<span style="color: #7A2828;">${move.slice(0, 2)}</span> <span style="color: #F2B600;"> → </span> <span style="color: #00813e;">${move.slice(2, 4)}${promo}</span>`;
    metaDisplay.innerHTML = `local depth reached <b>${depth || "—"}</b>`;
  }

  function send(type, extra = {}) {
    return new Promise((resolve) => {
      try {
        api.runtime.sendMessage({ type, ...extra }, (resp) => {
          if (api.runtime.lastError) {
            resolve({ ok: false, error: api.runtime.lastError.message });
          } else {
            resolve(resp || { ok: true });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  btnStart.addEventListener("click", async () => {
    setStatus("starting…", false);
    const d = getDepth();
    depthInput.value = d;
    const r = await send("start", {
      depth: d,
      showHud: hudCheck.checked,
      autoPlay: autoCheck.checked,
      delayMin: 1400,
      delayMax: 3000
    });
    if (r && r.ok) setStatus("Engine running...", true);
    else setStatus(r?.error || "open a chess.com or lichess game tab", false);
  });

  btnStop.addEventListener("click", async () => {
    await send("stop");
    setStatus("Engine stopped...", false);
    showMove(null);
  });

  const onDepthChange = () => {
    const d = getDepth();
    depthInput.value = d;
    send("setDepth", { depth: d });
  };
  depthInput.addEventListener("change", onDepthChange);
  depthInput.addEventListener("input", onDepthChange);
  autoCheck.addEventListener("change", () => send("setAuto", { value: autoCheck.checked }));
  hudCheck.addEventListener("change", () => send("setHud", { value: hudCheck.checked }));

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "liveMove") {
      showMove(msg.move, msg.depth);
      setStatus("running (local engine)", true);
    }
  });

  (async () => {
    const st = await send("status");
    if (st?.running) {
      setStatus("running (local engine)", true);
      if (st.depth) depthInput.value = st.depth;
      if (typeof st.autoPlay === "boolean") autoCheck.checked = st.autoPlay;
      if (typeof st.showHud === "boolean") hudCheck.checked = st.showHud;
      if (st.move) showMove(st.move, st.depth);
    } else {
      setStatus(st?.error || "Engine idle...", false);
    }
  })();
})();