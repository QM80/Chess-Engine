(() => {
  "use strict";

  const api = chrome;

  const STATE = {
    running: false,
    autoPlay: false,
    showHud: true,
    lastFen: null,
    lastMove: null,
    lockedColour: null,
    side: "w",
    depth: 18,
    pending: false,
    pendingAt: 0,
    position: null,
    enginePort: null,
    requestId: 0,
    sessionId: 0,
    tracker: null,
    playDelayMin: 1400,
    playDelayMax: 3000,
    pendingMove: null,
    hudRoot: null,
    hudEl: null,
    status: "idle",
    bridgeData: null,
    lastGoodAt: 0,
    resyncAt: 0,
    connecting: false,
    obs: null,
    obsBoard: null
  };

  const FILE_MAP = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
  const FILES = "abcdefgh";
  const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  const PIECE_WORDS = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };
  const READ_GRACE_MS = 2500;

  function isLichess() {
    return location.hostname.indexOf("lichess.org") >= 0;
  }

  function siteLabel() {
    return isLichess() ? "lichess" : "chesscom";
  }

  function biggest(selector) {
    let best = null;
    let bestArea = 0;
    const nodes = document.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.closest && el.closest(".mini-board, .mini-game, .play-list")) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function getBoard() {
    if (isLichess()) return biggest("cg-board") || document.querySelector(".cg-wrap");
    return biggest("wc-chess-board, chess-board, #board-single, #board");
  }

  function boardFlipped(board) {
    if (!board) return false;
    if (isLichess()) {
      const wrap = board.closest ? (board.closest(".cg-wrap") || board) : board;
      return String(wrap.className || "").indexOf("orientation-black") >= 0;
    }
    return !!(board.classList && board.classList.contains("flipped"));
  }

  function parsePiece(el) {
    let color = null;
    let role = null;
    const classes = el.classList ? Array.from(el.classList) : [];
    for (let i = 0; i < classes.length; i++) {
      const c = String(classes[i]).toLowerCase();
      if (!c) continue;
      if (c === "white" || c === "w") { if (!color) color = "w"; continue; }
      if (c === "black" || c === "b") { if (!color) color = "b"; continue; }
      if (/^[wb][pnbrqk]$/.test(c)) { if (!color) color = c[0]; if (!role) role = c[1]; continue; }
      if (PIECE_WORDS[c]) { if (!role) role = PIECE_WORDS[c]; continue; }
      const word = c.match(/^([wb])[-\s](pawn|knight|bishop|rook|queen|king)$/);
      if (word) { if (!color) color = word[1]; if (!role) role = PIECE_WORDS[word[2]]; }
    }
    if (!color || !role) return null;
    return { color: color, role: role };
  }

  function keyFromGeometry(el, area, sqW, sqH, flipped) {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const fx = (rect.left - area.left) / sqW;
    const fy = (rect.top - area.top) / sqH;
    const vx = Math.round(fx);
    const vy = Math.round(fy);
    if (Math.abs(fx - vx) > 0.2 || Math.abs(fy - vy) > 0.2) return null;
    if (vx < 0 || vx > 7 || vy < 0 || vy > 7) return null;
    return FILES[flipped ? 7 - vx : vx] + (flipped ? vy + 1 : 8 - vy);
  }

  function squareKeyFromClasses(el) {
    const classes = el.classList ? Array.from(el.classList) : [];
    for (let i = 0; i < classes.length; i++) {
      const m = String(classes[i]).match(/^square-([1-8])([1-8])$/);
      if (m) return FILES[Number(m[1]) - 1] + m[2];
    }
    return null;
  }

  function readPlacementFromDom() {
    const board = getBoard();
    if (!board) return null;
    const area = board.getBoundingClientRect();
    if (area.width < 40 || area.height < 40) return null;
    const sqW = area.width / 8;
    const sqH = area.height / 8;
    const flipped = boardFlipped(board);
    const grid = {};

    if (!isLichess()) {
      const pieces = board.querySelectorAll(".piece");
      if (!pieces.length) return null;
      for (let i = 0; i < pieces.length; i++) {
        const el = pieces[i];
        if (el.classList.contains("dragging") || el.classList.contains("moving")) return null;
        const info = parsePiece(el);
        if (!info) continue;
        const key = squareKeyFromClasses(el) || keyFromGeometry(el, area, sqW, sqH, flipped);
        if (!key || grid[key]) return null;
        grid[key] = info.color === "w" ? info.role.toUpperCase() : info.role;
      }
    } else {
      const pieces = board.querySelectorAll("piece");
      if (!pieces.length) return null;
      for (let i = 0; i < pieces.length; i++) {
        const el = pieces[i];
        const cls = String(el.className || "");
        if (/\b(ghost|anim|dragging|fading)\b/.test(cls)) return null;
        const info = parsePiece(el);
        if (!info) continue;
        let key = null;
        try {
          if (el.cgKey && /^[a-h][1-8]$/.test(String(el.cgKey))) key = String(el.cgKey);
        } catch (_) {}
        if (!key) key = squareKeyFromClasses(el) || keyFromGeometry(el, area, sqW, sqH, flipped);
        if (!key || grid[key]) return null;
        grid[key] = info.color === "w" ? info.role.toUpperCase() : info.role;
      }
    }

    if (Object.keys(grid).length < 2) return null;
    const placement = placementFromBoard(grid);
    if (!isValidPlacement(placement) || !hasBothKings(placement)) return null;
    return { placement: placement, flipped: flipped };
  }

  function lichessClockSide() {
    if (!isLichess()) return null;
    const running = document.querySelector(".rclock.running");
    if (running) {
      const cls = String(running.className || "");
      if (cls.indexOf("rclock-white") >= 0) return "w";
      if (cls.indexOf("rclock-black") >= 0) return "b";
      const flipped = boardFlipped(getBoard());
      if (cls.indexOf("rclock-bottom") >= 0) return flipped ? "b" : "w";
      if (cls.indexOf("rclock-top") >= 0) return flipped ? "w" : "b";
    }
    const turnBottom = document.querySelector(".rclock.rclock-bottom.rclock-turn .rclock-turn__text");
    const turnTop = document.querySelector(".rclock.rclock-top.rclock-turn .rclock-turn__text");
    if (turnBottom || turnTop) {
      const flipped = boardFlipped(getBoard());
      if (turnBottom && !turnTop) return flipped ? "b" : "w";
      if (turnTop && !turnBottom) return flipped ? "w" : "b";
    }
    return null;
  }

  function chessComClockSide() {
    if (isLichess()) return null;
    const active = document.querySelector(
      ".clock-player-turn, .clock-player-turn-highlight, .clock-bottom.clock-player-turn, .clock-top.clock-player-turn"
    );
    if (!active) return null;
    let node = active;
    let position = null;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const cls = String(node.className || "");
      if (/(^|[\s-])bottom([\s-]|$)/.test(cls)) { position = "bottom"; break; }
      if (/(^|[\s-])top([\s-]|$)/.test(cls)) { position = "top"; break; }
    }
    if (!position) return null;
    const flipped = boardFlipped(getBoard());
    if (position === "bottom") return flipped ? "b" : "w";
    return flipped ? "w" : "b";
  }

  function lastMoveKeys() {
    const keys = [];
    const board = getBoard();
    if (!board) return keys;
    if (isLichess()) {
      const area = board.getBoundingClientRect();
      if (area.width < 40) return keys;
      const flipped = boardFlipped(board);
      const squares = board.querySelectorAll("square.last-move");
      for (let i = 0; i < squares.length; i++) {
        const sq = squares[i];
        let key = null;
        try {
          if (sq.cgKey && /^[a-h][1-8]$/.test(String(sq.cgKey))) key = String(sq.cgKey);
        } catch (_) {}
        if (!key) key = squareKeyFromClasses(sq) ||
          keyFromGeometry(sq, area, area.width / 8, area.height / 8, flipped);
        if (key) keys.push(key);
      }
      return keys;
    }
    const marks = board.querySelectorAll(".highlight");
    for (let i = 0; i < marks.length; i++) {
      const key = squareKeyFromClasses(marks[i]);
      if (key) keys.push(key);
    }
    return keys;
  }

  function lastMoveSide(map) {
    const keys = lastMoveKeys();
    for (let i = 0; i < keys.length; i++) {
      const piece = map[keys[i]];
      if (!piece) continue;
      return isWhitePiece(piece) ? "b" : "w";
    }
    return null;
  }

  function detectColour() {
    if (isLichess()) {
      const bottom = document.querySelector(".rclock.rclock-bottom");
      if (bottom) {
        const cls = String(bottom.className || "");
        if (cls.indexOf("rclock-white") >= 0) return "w";
        if (cls.indexOf("rclock-black") >= 0) return "b";
      }
      const board = getBoard();
      if (!board) return null;
      return boardFlipped(board) ? "b" : "w";
    }
    const board = getBoard();
    if (!board) return null;
    return board.classList.contains("flipped") ? "b" : "w";
  }

  function isValidPlacement(placement) {
    if (!placement) return false;
    const ranks = placement.split("/");
    if (ranks.length !== 8) return false;
    for (let i = 0; i < 8; i++) {
      let width = 0;
      for (const ch of ranks[i]) {
        if (ch >= "1" && ch <= "8") width += ch.charCodeAt(0) - 48;
        else if ("pnbrqkPNBRQK".indexOf(ch) >= 0) width += 1;
        else return false;
      }
      if (width !== 8) return false;
    }
    return true;
  }

  function hasBothKings(placement) {
    const K = placement.match(/K/g);
    const k = placement.match(/k/g);
    return !!(K && K.length === 1 && k && k.length === 1);
  }

  function boardFromFen(placement) {
    const map = {};
    const ranks = placement.split("/");
    if (ranks.length !== 8) return null;
    for (let r = 0; r < 8; r++) {
      let file = 0;
      for (const ch of ranks[r]) {
        if (ch >= "1" && ch <= "8") {
          file += parseInt(ch, 10);
        } else {
          const rank = 8 - r;
          if (file > 7) return null;
          map[FILES[file] + rank] = ch;
          file++;
        }
      }
      if (file !== 8) return null;
    }
    return map;
  }

  function placementFromBoard(board) {
    const ranks = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = "";
      let empty = 0;
      for (const file of FILES) {
        const piece = board[file + rank];
        if (!piece) empty++;
        else {
          if (empty) row += empty;
          empty = 0;
          row += piece;
        }
      }
      if (empty) row += empty;
      ranks.push(row);
    }
    return ranks.join("/");
  }

  function isWhitePiece(ch) {
    return ch === ch.toUpperCase() && "PNBRQK".indexOf(ch) >= 0;
  }

  function isKingInCheck(board, kingColor) {
    const wantWhiteKing = kingColor === "w";
    const kingChar = wantWhiteKing ? "K" : "k";
    let kSq = null;
    for (const sq in board) {
      if (board[sq] === kingChar) { kSq = sq; break; }
    }
    if (!kSq) return true;

    const kf = kSq.charCodeAt(0) - 97;
    const kr = parseInt(kSq[1], 10);
    const isEnemy = (ch) => ch && (isWhitePiece(ch) !== wantWhiteKing);

    const knOffsets = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [df, dr] of knOffsets) {
      const nf = kf + df, nr = kr + dr;
      if (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
        const p = board[FILES[nf] + nr];
        if (isEnemy(p) && p.toLowerCase() === "n") return true;
      }
    }

    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = kf + df, nr = kr + dr;
        if (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
          const p = board[FILES[nf] + nr];
          if (isEnemy(p) && p.toLowerCase() === "k") return true;
        }
      }
    }

    const pawnDir = wantWhiteKing ? 1 : -1;
    for (const df of [-1, 1]) {
      const nf = kf + df, nr = kr + pawnDir;
      if (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
        const p = board[FILES[nf] + nr];
        if (isEnemy(p) && p.toLowerCase() === "p") return true;
      }
    }

    const ortho = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [df, dr] of ortho) {
      let nf = kf + df, nr = kr + dr;
      while (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
        const p = board[FILES[nf] + nr];
        if (p) {
          if (isEnemy(p) && (p.toLowerCase() === "r" || p.toLowerCase() === "q")) return true;
          break;
        }
        nf += df; nr += dr;
      }
    }

    const diag = [[1,1],[1,-1],[-1,1],[-1,-1]];
    for (const [df, dr] of diag) {
      let nf = kf + df, nr = kr + dr;
      while (nf >= 0 && nf <= 7 && nr >= 1 && nr <= 8) {
        const p = board[FILES[nf] + nr];
        if (p) {
          if (isEnemy(p) && (p.toLowerCase() === "b" || p.toLowerCase() === "q")) return true;
          break;
        }
        nf += df; nr += dr;
      }
    }

    return false;
  }

  function isStrictlyLegal(fen, uci) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci || "")) return false;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return false;
    if (from === to) return false;

    const parts = String(fen).trim().split(/\s+/);
    const placement = parts[0];
    const side = parts[1] === "b" ? "b" : "w";
    const board = boardFromFen(placement);
    if (!board) return false;

    const piece = board[from];
    if (!piece) return false;

    const white = isWhitePiece(piece);
    if (side === "w" && !white) return false;
    if (side === "b" && white) return false;

    const role = piece.toLowerCase();
    const ff = from.charCodeAt(0) - 97;
    const fr = parseInt(from[1], 10);
    const tf = to.charCodeAt(0) - 97;
    const tr = parseInt(to[1], 10);
    const df = tf - ff;
    const dr = tr - fr;
    const adf = Math.abs(df);
    const adr = Math.abs(dr);
    const dest = board[to];

    if (dest && (isWhitePiece(dest) === white || dest.toLowerCase() === "k")) return false;
    const promotion = uci.length === 5;
    if (promotion !== (role === "p" && (tr === 1 || tr === 8))) return false;

    function clearPath() {
      const stepF = df === 0 ? 0 : df / adf;
      const stepR = dr === 0 ? 0 : dr / adr;
      const steps = Math.max(adf, adr);
      for (let i = 1; i < steps; i++) {
        const sq = String.fromCharCode(97 + ff + stepF * i) + (fr + stepR * i);
        if (board[sq]) return false;
      }
      return true;
    }

    let ok = false;
    if (role === "k") {
      if (adf <= 1 && adr <= 1) ok = true;
      else if (adr === 0 && adf === 2 && fr === tr && (fr === 1 || fr === 8) && from[0] === "e") {
        const right = white ? (tf === 6 ? "K" : "Q") : (tf === 6 ? "k" : "q");
        const rook = board[(tf === 6 ? "h" : "a") + fr];
        const transit = Object.assign({}, board);
        delete transit[from];
        transit[(tf === 6 ? "f" : "d") + fr] = piece;
        ok = parts[2] !== undefined && parts[2].includes(right) && rook === (white ? "R" : "r") && clearPath() &&
          !isKingInCheck(board, side) && !isKingInCheck(transit, side);
      }
    } else if (role === "n") {
      ok = (adf === 1 && adr === 2) || (adf === 2 && adr === 1);
    } else if (role === "b") {
      ok = adf === adr && adf > 0 && clearPath();
    } else if (role === "r") {
      ok = ((df === 0 && dr !== 0) || (dr === 0 && df !== 0)) && clearPath();
    } else if (role === "q") {
      ok = ((adf === adr && adf > 0) || (df === 0 && dr !== 0) || (dr === 0 && df !== 0)) && clearPath();
    } else if (role === "p") {
      const dir = white ? 1 : -1;
      const start = white ? 2 : 7;
      if (df === 0 && !dest) {
        if (dr === dir) ok = true;
        else if (fr === start && dr === 2 * dir && !board[from[0] + (fr + dir)]) ok = true;
      } else if (adf === 1 && dr === dir) {
        ok = !!dest || (parts[3] === to && board[to[0] + fr] === (white ? "p" : "P"));
      }
    }

    if (!ok) return false;

    const nextBoard = Object.assign({}, board);
    delete nextBoard[from];
    if (role === "p" && adf === 1 && !dest) {
      delete nextBoard[to[0] + fr];
    }
    if (role === "k" && adf === 2) {
      if (tf === 6) { nextBoard["f" + fr] = nextBoard["h" + fr]; delete nextBoard["h" + fr]; }
      if (tf === 2) { nextBoard["d" + fr] = nextBoard["a" + fr]; delete nextBoard["a" + fr]; }
    }
    const promo = uci.length > 4 ? uci[4] : null;
    nextBoard[to] = promo ? (white ? promo.toUpperCase() : promo.toLowerCase()) : piece;

    return !isKingInCheck(nextBoard, side);
  }

  function nextFen(fen, move) {
    if (!isStrictlyLegal(fen, move)) return null;
    const parts = fen.split(/\s+/);
    const board = boardFromFen(parts[0]);
    const from = move.slice(0, 2), to = move.slice(2, 4);
    const piece = board[from], target = board[to];
    const white = isWhitePiece(piece), role = piece.toLowerCase();
    delete board[from];
    if (role === "p" && from[0] !== to[0] && !target) delete board[to[0] + from[1]];
    if (role === "k" && Math.abs(FILES.indexOf(from[0]) - FILES.indexOf(to[0])) === 2) {
      const rookFrom = (to[0] === "g" ? "h" : "a") + from[1];
      const rookTo = (to[0] === "g" ? "f" : "d") + from[1];
      board[rookTo] = board[rookFrom];
      delete board[rookFrom];
    }
    board[to] = move[4] ? (white ? move[4].toUpperCase() : move[4]) : piece;
    let rights = parts[2] === "-" ? "" : parts[2];
    if (role === "k") rights = rights.replace(white ? /[KQ]/g : /[kq]/g, "");
    const cornerRights = { a1: "Q", h1: "K", a8: "q", h8: "k" };
    if (cornerRights[from]) rights = rights.replace(cornerRights[from], "");
    if (cornerRights[to]) rights = rights.replace(cornerRights[to], "");
    const ep = role === "p" && Math.abs(Number(to[1]) - Number(from[1])) === 2
      ? from[0] + ((Number(to[1]) + Number(from[1])) / 2) : "-";
    const half = role === "p" || target ? 0 : Number(parts[4]) + 1;
    const full = Number(parts[5]) + (white ? 0 : 1);
    return [placementFromBoard(board), white ? "b" : "w", rights || "-", ep, half, full].join(" ");
  }

  function fullFenOf(raw) {
    const parts = String(raw).trim().split(/\s+/);
    if (parts.length < 6) return null;
    if (!isValidPlacement(parts[0]) || !hasBothKings(parts[0])) return null;
    if (!/^[wb]$/.test(parts[1])) return null;
    if (!/^(-|K?Q?k?q?)$/.test(parts[2])) return null;
    if (!/^(-|[a-h][36])$/.test(parts[3])) return null;
    if (!/^\d+$/.test(parts[4]) || !/^[1-9]\d*$/.test(parts[5])) return null;
    return parts.slice(0, 6).join(" ");
  }

  function movesFrom(fen) {
    const placements = [];
    const board = boardFromFen(fen.split(" ")[0]);
    if (!board) return placements;
    const side = fen.split(" ")[1];
    for (const from in board) {
      if ((isWhitePiece(board[from]) ? "w" : "b") !== side) continue;
      for (const file of FILES) {
        for (let rank = 1; rank <= 8; rank++) {
          const to = file + rank;
          const promos = board[from].toLowerCase() === "p" && (rank === 1 || rank === 8)
            ? ["q", "r", "b", "n"] : [""];
          for (const suffix of promos) {
            const next = nextFen(fen, from + to + suffix);
            if (next) placements.push(next);
          }
        }
      }
    }
    return placements;
  }

  function resyncTracker(placement, sideHint) {
    if (!STATE.tracker) return null;
    const now = Date.now();
    if (now - STATE.resyncAt < 400) return null;
    STATE.resyncAt = now;

    let match = null;
    const onePly = movesFrom(STATE.tracker);
    for (let i = 0; i < onePly.length; i++) {
      if (onePly[i].split(" ")[0] !== placement) continue;
      if (match && match !== onePly[i]) return null;
      match = onePly[i];
    }
    if (match) return match;

    match = null;
    for (let i = 0; i < onePly.length; i++) {
      const twoPly = movesFrom(onePly[i]);
      for (let j = 0; j < twoPly.length; j++) {
        if (twoPly[j].split(" ")[0] !== placement) continue;
        if (sideHint && twoPly[j].split(" ")[1] !== sideHint) continue;
        if (match && match !== twoPly[j]) return null;
        match = twoPly[j];
      }
    }
    return match;
  }

  function completeFen(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    const parts = text.split(/\s+/);
    const placement = parts[0];
    if (!isValidPlacement(placement) || !hasBothKings(placement)) return null;
    const sideIn = /^[wb]$/.test(parts[1] || "") ? parts[1] : null;

    const full = fullFenOf(text);
    if (full && (!sideIn || full.split(" ")[1] === sideIn)) {
      STATE.tracker = full;
      return full;
    }

    if (placement === START_PLACEMENT && (!sideIn || sideIn === "w")) {
      STATE.tracker = START_PLACEMENT + " w KQkq - 0 1";
      return STATE.tracker;
    }

    if (STATE.tracker) {
      const tracked = STATE.tracker.split(" ");
      if (tracked[0] === placement && (!sideIn || tracked[1] === sideIn)) return STATE.tracker;
      const resynced = resyncTracker(placement, sideIn);
      if (resynced) {
        STATE.tracker = resynced;
        return resynced;
      }
    }

    const side = sideIn || (STATE.side === "w" ? "b" : "w");
    const synth = placement + " " + side + " - - 0 1";
    STATE.tracker = synth;
    return synth;
  }

  function readBoardRaw() {
    const dom = readPlacementFromDom();
    if (!dom) return null;
    const map = boardFromFen(dom.placement);
    if (!map) return null;

    const bridge = STATE.bridgeData;
    if (bridge && typeof bridge.fen === "string" && bridge.fen) {
      const fields = bridge.fen.trim().split(/\s+/);
      if (fields[0] === dom.placement) {
        const full = fullFenOf(bridge.fen);
        if (full) return full;
        if (/^[wb]$/.test(fields[1] || "")) return dom.placement + " " + fields[1];
      }
    }

    let side = isLichess() ? lichessClockSide() : chessComClockSide();
    if (!side) side = lastMoveSide(map);
    return side ? dom.placement + " " + side : dom.placement;
  }

  function ensureHud() {
    if (STATE.hudRoot && document.contains(STATE.hudRoot)) return;
    const host = document.createElement("div");
    host.id = "bsc-" + Math.random().toString(36).slice(2, 8);
    host.style.cssText = "all:initial;position:fixed;top:10px;right:10px;z-index:2147483646;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Onest:wght@100..900&display=swap'); .p{font:12px/1.35 "Onest",sans-serif;color:#e8eaed;border-radius:4px;padding:8px 10px;background-image:linear-gradient(-45deg,#1F0001,#090000);min-width:155px;user-select:none}.m{font-size:17px;font-weight:600;color:#f28b82}.d{font-size:10px;color:#9aa0a6;margin-top:2px}.r{display:flex;gap:6px;margin-top:6px}button{flex:1;font-size:11px;font-family:inherit;padding:5px 8px;cursor:pointer;background:rgba(255,255,255,.04);color:#e8eaed;border:1px solid transparent;border-radius:6px;box-shadow:none;outline:none;appearance:none;transition:all .2s ease}button:hover{background:#f28b821f}button.on{background:#7a282859;color:#f28b82}button.on:hover{background:#7a28288c}      </style>
      <div class="p">
        <div class="m" id="m">—</div>
        <div class="d" id="d">idle</div>
        <div class="r">
          <button id="a">Auto off</button>
          <button id="h">Hide</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    STATE.hudRoot = host;
    STATE.hudEl = shadow;
    shadow.getElementById("a").onclick = () => {
      STATE.autoPlay = !STATE.autoPlay;
      updateHudBtns();
      if (STATE.autoPlay && STATE.lastMove && isOurTurn()) schedulePlay(STATE.lastMove);
    };
    shadow.getElementById("h").onclick = () => {
      STATE.showHud = false;
      host.style.display = "none";
    };
  }

  function updateHudBtns() {
    if (!STATE.hudEl) return;
    const b = STATE.hudEl.getElementById("a");
    if (b) {
      b.innerHTML = STATE.autoPlay ? "Auto on" : "Auto off";
      b.classList.toggle("on", STATE.autoPlay);
    }
  }

  function setHud(move, text) {
    STATE.status = text || STATE.status;
    if (!STATE.showHud) return;
    ensureHud();
    if (STATE.hudRoot) STATE.hudRoot.style.display = "";
    const m = STATE.hudEl.getElementById("m");
    const d = STATE.hudEl.getElementById("d");
    if (move && move.length >= 4) {
      const promo = move.length > 4 ? "=" + move[4].toUpperCase() : "";
      m.innerHTML = `<span style="color: #7A2828;">${move.slice(0, 2)}</span> <span style="color: #F2B600;"> → </span> <span style="color: #00813e;">${move.slice(2, 4)}${promo}</span>`;
    } else if (move === null) {
      m.innerHTML = "<span style='color: #F3F6FB;'>—</span>";
    }
    d.innerHTML = text || "";
    updateHudBtns();
  }

  function removeHud() {
    if (STATE.hudRoot) {
      try { STATE.hudRoot.remove(); } catch (_) {}
      STATE.hudRoot = null;
      STATE.hudEl = null;
    }
    clearMarks();
  }

  function clearMarks() {
    document.querySelectorAll("[data-bsc-mark], #bsc-board-overlay").forEach(n => n.remove());
  }

  function paint(uci) {
    clearMarks();
    if (!uci || uci.length < 4) return;
    const board = getBoard();
    if (!board) return;
    const rect = board.getBoundingClientRect();
    if (!rect || rect.width < 20 || rect.height < 20) return;
    const flipped = boardFlipped(board);

    const overlay = document.createElement("div");
    overlay.id = "bsc-board-overlay";
    overlay.setAttribute("data-bsc-mark", "1");
    overlay.dataset.flipped = String(flipped);
    overlay.style.cssText =
      "position:fixed;" +
      "left:" + rect.left + "px;" +
      "top:" + rect.top + "px;" +
      "width:" + rect.width + "px;" +
      "height:" + rect.height + "px;" +
      "pointer-events:none;" +
      "z-index:2147483640;";

    [{ sq: uci.slice(0, 2) }, { sq: uci.slice(2, 4) }].forEach(({ sq }) => {
      const file = FILES.indexOf(sq[0]);
      const rank = parseInt(sq[1], 10) - 1;
      if (file < 0 || rank < 0 || rank > 7) return;
      const col = flipped ? (7 - file) : file;
      const row = flipped ? rank : (7 - rank);
      const box = document.createElement("div");
      box.setAttribute("data-bsc-mark", "1");
      box.style.cssText =
        "position:absolute;" +
        "left:" + (col * 12.5) + "%;" +
        "top:" + (row * 12.5) + "%;" +
        "width:12.5%;" +
        "height:12.5%;" +
        "box-sizing:border-box;" +
        "background:rgba(255, 0, 0, 0.5);" +
        "pointer-events:none;";
      overlay.appendChild(box);
    });

    document.documentElement.appendChild(overlay);
  }

  function repositionOverlay() {
    if (!STATE.running || !STATE.lastMove) return;
    const overlay = document.getElementById("bsc-board-overlay");
    if (!overlay) {
      paint(STATE.lastMove);
      return;
    }
    const board = getBoard();
    if (!board) return;
    if (overlay.dataset.flipped !== String(boardFlipped(board))) {
      paint(STATE.lastMove);
      return;
    }
    const rect = board.getBoundingClientRect();
    if (rect && rect.width >= 20) {
      overlay.style.left = rect.left + "px";
      overlay.style.top = rect.top + "px";
      overlay.style.width = rect.width + "px";
      overlay.style.height = rect.height + "px";
    }
  }

  window.addEventListener("scroll", repositionOverlay, { passive: true });
  window.addEventListener("resize", repositionOverlay, { passive: true });

  function squarePoint(board, sq) {
    const rect = board.getBoundingClientRect();
    const file = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10);
    if (file < 0 || !rank) return null;
    if (!isLichess()) {
      const el = board.querySelector(".square-" + FILE_MAP[sq[0]] + rank);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    const size = Math.min(rect.width, rect.height) / 8;
    const flipped = boardFlipped(board);
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank - 1 : 8 - rank;
    return { x: rect.left + col * size + size / 2, y: rect.top + row * size + size / 2 };
  }

  function fire(el, type, x, y) {
    const o = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, pointerId: 1, pointerType: "mouse",
      isPrimary: true, buttons: type.indexOf("up") >= 0 ? 0 : 1, button: 0
    };
    try { el.dispatchEvent(new PointerEvent(type, o)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), o)); } catch (_) {}
  }

  function clickSq(board, sq) {
    const pt = squarePoint(board, sq);
    if (!pt) return;
    const t = document.elementFromPoint(pt.x, pt.y) || board;
    fire(t, "pointerdown", pt.x, pt.y);
    fire(t, "mousedown", pt.x, pt.y);
    fire(t, "pointerup", pt.x, pt.y);
    fire(t, "mouseup", pt.x, pt.y);
    fire(t, "click", pt.x, pt.y);
  }

  function isOurTurn() {
    if (!STATE.lockedColour) return false;
    return STATE.side === STATE.lockedColour;
  }

  function pieceSideOn(fen, uci) {
    if (!fen || !uci || uci.length < 2) return null;
    const board = boardFromFen(String(fen).split(/\s+/)[0]);
    if (!board) return null;
    const piece = board[uci.slice(0, 2)];
    if (!piece) return null;
    return isWhitePiece(piece) ? "w" : "b";
  }

  function placementOf(fen) {
    if (!fen) return null;
    return String(fen).trim().split(/\s+/)[0] || null;
  }

  function readCurrentFen() {
    let raw = null;
    try { raw = readBoardRaw(); } catch (_) { raw = null; }
    return raw ? completeFen(raw) : null;
  }

  function playUci(uci, placement) {
    const board = getBoard();
    if (!board || !uci || uci.length < 4) return;
    if (!isOurTurn()) return;
    clickSq(board, uci.slice(0, 2));
    setTimeout(() => {
      if (!STATE.running || !STATE.autoPlay || !isOurTurn()) return;
      const now = readCurrentFen();
      if (now && placement && placementOf(now) !== placement) return;
      clickSq(board, uci.slice(2, 4));
      if (uci.length > 4) {
        setTimeout(() => {
          const p = document.querySelector(".promotion-piece, [class*='promotion'] piece");
          if (p) p.click();
        }, 220);
      }
    }, 120 + Math.random() * 140);
  }

  // Validates the queued move against a fresh board read at fire time. It never
  // depends on STATE.position / STATE.lastMove, which transient DOM reads rewrite
  // (that used to silently cancel any play scheduled more than ~1.5s ahead).
  function fireScheduled() {
    const job = STATE.pendingMove;
    if (!job) return;
    if (!STATE.autoPlay || !STATE.running) {
      STATE.pendingMove = null;
      return;
    }
    if (!isOurTurn()) {
      // The board can lag a fraction of a second behind the game state; give the
      // turn flag a moment to settle before giving up on the queued move.
      if (job.tries < 4) {
        job.tries++;
        STATE._pt = setTimeout(fireScheduled, 300);
        return;
      }
      STATE.pendingMove = null;
      setHud(job.uci, "skipped — not <b>" + STATE.lockedColour + "</b>");
      return;
    }
    const now = readCurrentFen();
    if (!now) {
      if (job.tries >= 12) {
        STATE.pendingMove = null;
        setHud(job.uci, "skipped — board unreadable");
        return;
      }
      job.tries++;
      STATE._pt = setTimeout(fireScheduled, 250);
      return;
    }
    if (job.placement && placementOf(now) !== job.placement) {
      STATE.pendingMove = null;
      setHud(job.uci, "skipped — board changed");
      return;
    }
    const mover = pieceSideOn(now, job.uci);
    if (mover && mover !== STATE.lockedColour) {
      STATE.pendingMove = null;
      setHud(job.uci, "skipped — not your piece");
      return;
    }
    STATE.pendingMove = null;
    playUci(job.uci, job.placement);
    setHud(job.uci, "played " + STATE.lockedColour);
  }

  function schedulePlay(uci) {
    if (!STATE.autoPlay || !STATE.running) return;
    if (!STATE.lockedColour) return;
    if (!isOurTurn()) {
      setHud(uci, "locked <b>" + STATE.lockedColour + "</b> opponent turn");
      return;
    }
    if (!uci || uci.length < 4) return;
    const expectedFen = STATE.lastFen || STATE.position;
    const wait = STATE.playDelayMin + Math.random() * (STATE.playDelayMax - STATE.playDelayMin);
    setHud(uci, "auto <b>" + STATE.lockedColour + "</b> in " + (wait / 1000).toFixed(1) + "s");
    if (STATE._pt) clearTimeout(STATE._pt);
    STATE.pendingMove = { uci: uci, placement: placementOf(expectedFen), tries: 0 };
    STATE._pt = setTimeout(fireScheduled, wait);
  }

  function clearAnalysis(text) {
    if (STATE.lastMove) {
      try {
        api.runtime.sendMessage({ type: "analysisResult", move: null, depth: null, fen: null },
          () => { void api.runtime.lastError; });
      } catch (_) {}
    }
    STATE.lastMove = null;
    STATE.lastFen = null;
    clearMarks();
    setHud(null, text);
  }

  function analyze(rawFen) {
    if (!STATE.running || !STATE.lockedColour) return;

    if (!rawFen) {
      if (STATE.lastGoodAt && Date.now() - STATE.lastGoodAt < READ_GRACE_MS) return;
      if (STATE.position !== null || STATE.pending || STATE.lastMove) {
        STATE.requestId++;
        STATE.pending = false;
        STATE.pendingAt = 0;
        if (STATE.enginePort) {
          try { STATE.enginePort.postMessage({ type: "cancel" }); } catch (_) {}
        }
      }
      STATE.position = null;
      clearAnalysis("waiting for the board…");
      return;
    }

    let fen = completeFen(rawFen);
    if (!fen) return;
    // A real move always changes the placement. If only the side-to-move field
    // flipped (clock/highlight/animation read glitch), keep the side we already
    // had — otherwise the extension flips itself to "opponent turn" and drops
    // the queued auto-play.
    const prevParts = STATE.position ? STATE.position.split(/\s+/) : null;
    const parts = fen.split(/\s+/);
    if (prevParts && parts.length > 1 && prevParts[0] === parts[0] &&
        prevParts[1] !== parts[1] && (prevParts[1] === "w" || prevParts[1] === "b")) {
      parts[1] = prevParts[1];
      fen = parts.join(" ");
    }
    STATE.lastGoodAt = Date.now();
    const side = fen.split(" ")[1];
    STATE.side = side;

    if (fen !== STATE.position) {
      STATE.position = fen;
      STATE.requestId++;
      STATE.pending = false;
      STATE.pendingAt = 0;
      if (STATE.enginePort) {
        try { STATE.enginePort.postMessage({ type: "cancel" }); } catch (_) {}
      }
      clearAnalysis(side === STATE.lockedColour ? "position changed" : "opponent turn");
    }

    if (side !== STATE.lockedColour || STATE.pending || STATE.lastFen === fen) return;
    if (!STATE.enginePort) {
      connectEngine(STATE.sessionId);
      setHud(null, "starting local engine…");
      return;
    }
    STATE.pending = true;
    STATE.pendingAt = Date.now();
    setHud(null, "local eval d" + STATE.depth + "…");
    try {
      STATE.enginePort.postMessage({ type: "eval", id: STATE.requestId, fen: fen, depth: STATE.depth, movetime: 1500 });
    } catch (_) {
      STATE.pending = false;
      STATE.pendingAt = 0;
    }
  }

  function handleEngineMessage(msg) {
    if (!STATE.running || !msg || typeof msg !== "object") return;
    if (msg.type === "pong") return;
    if (msg.type === "error") {
      STATE.pending = false;
      STATE.pendingAt = 0;
      clearAnalysis(msg.error || "local engine unavailable");
      return;
    }
    if (msg.type !== "result" || msg.id !== STATE.requestId || msg.fen !== STATE.position) return;
    STATE.pending = false;
    STATE.pendingAt = 0;
    if (!msg.move || !isStrictlyLegal(msg.fen, msg.move)) {
      clearAnalysis(msg.move ? "engine returned an invalid move" : "no legal move");
      STATE.lastFen = msg.fen;
      return;
    }
    STATE.lastFen = msg.fen;
    STATE.lastMove = msg.move;
    paint(msg.move);
    const ours = pieceSideOn(msg.fen, msg.move) === STATE.lockedColour && isOurTurn();
    setHud(msg.move, `local depth ${msg.depth || "—"} <b>${STATE.lockedColour.toUpperCase()}</b>`);
    try {
      api.runtime.sendMessage({ type: "analysisResult", move: msg.move, depth: msg.depth, fen: msg.fen },
        () => { void api.runtime.lastError; });
    } catch (_) {}
    if (STATE.autoPlay && ours) schedulePlay(msg.move);
  }

  function connectEngine(generation) {
    if (STATE.connecting) return;
    STATE.connecting = true;
    api.runtime.sendMessage({ type: "prepareEngine" }, (response) => {
      STATE.connecting = false;
      if (!STATE.running || generation !== STATE.sessionId) return;
      if (api.runtime.lastError || !response || !response.ok) {
        setHud(null, (response && response.error) || "engine host unavailable — retrying");
        setTimeout(() => {
          if (STATE.running && generation === STATE.sessionId && !STATE.enginePort) connectEngine(generation);
        }, 1500);
        return;
      }
      let port;
      try {
        port = api.runtime.connect({ name: "bsc-engine-client" });
      } catch (_) {
        setTimeout(() => {
          if (STATE.running && generation === STATE.sessionId && !STATE.enginePort) connectEngine(generation);
        }, 1500);
        return;
      }
      STATE.enginePort = port;
      port.onMessage.addListener(handleEngineMessage);
      port.onDisconnect.addListener(() => {
        void api.runtime.lastError;
        if (STATE.enginePort !== port) return;
        STATE.enginePort = null;
        STATE.pending = false;
        STATE.pendingAt = 0;
        if (!STATE.running || generation !== STATE.sessionId) return;
        setHud(null, "reconnecting engine…");
        setTimeout(() => {
          if (STATE.running && generation === STATE.sessionId && !STATE.enginePort) connectEngine(generation);
        }, 600);
      });
      if (STATE.position) analyze(STATE.position);
    });
  }

  function ensureObserver() {
    const board = getBoard();
    if (STATE.obs && STATE.obsBoard === board) return;
    if (STATE.obs) {
      try { STATE.obs.disconnect(); } catch (_) {}
      STATE.obs = null;
    }
    STATE.obsBoard = board;
    if (!board) return;
    const obs = new MutationObserver(() => {
      if (STATE._mt) clearTimeout(STATE._mt);
      STATE._mt = setTimeout(tick, 60);
    });
    try {
      obs.observe(board, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["class", "style", "transform"]
      });
    } catch (_) {
      return;
    }
    STATE.obs = obs;
  }

  function tick() {
    if (!STATE.running) return;
    if (!STATE.lockedColour) {
      const colour = detectColour();
      if (!colour) return;
      STATE.lockedColour = colour;
      STATE.side = colour;
      setHud(null, siteLabel() + " LOCKED " + colour.toUpperCase() + " (d" + STATE.depth + ")");
    }
    ensureObserver();
    repositionOverlay();

    if (STATE.pending && STATE.pendingAt && Date.now() - STATE.pendingAt > 12000) {
      STATE.requestId++;
      STATE.pending = false;
      STATE.pendingAt = 0;
      if (STATE.enginePort) {
        try { STATE.enginePort.postMessage({ type: "cancel" }); } catch (_) {}
      }
      setHud(null, "engine restarting…");
    }

    let raw = null;
    try { raw = readBoardRaw(); } catch (_) { raw = null; }
    analyze(raw);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== "bsc-bridge") return;
    if (ev.data.type !== "fen") return;
    const data = ev.data.data;
    if (data && typeof data.fen === "string") STATE.bridgeData = data;
    else if (!data) STATE.bridgeData = null;
    if (STATE._mt) clearTimeout(STATE._mt);
    STATE._mt = setTimeout(tick, 40);
  });


  function stopAll() {
    if (STATE.lastMove) clearAnalysis("stopped");
    STATE.running = false;
    STATE.pending = false;
    STATE.pendingAt = 0;
    STATE.position = null;
    STATE.tracker = null;
    STATE.requestId++;
    STATE.sessionId++;
    STATE.lastFen = null;
    STATE.lastMove = null;
    STATE.lastGoodAt = 0;
    STATE.bridgeData = null;
    STATE.obsBoard = null;
    if (STATE.enginePort) {
      try { STATE.enginePort.disconnect(); } catch (_) {}
      STATE.enginePort = null;
    }
    if (STATE._pt) clearTimeout(STATE._pt);
    STATE.pendingMove = null;
    if (STATE._poll) clearInterval(STATE._poll);
    if (STATE._hb) clearInterval(STATE._hb);
    if (STATE._mt) clearTimeout(STATE._mt);
    if (STATE.obs) {
      try { STATE.obs.disconnect(); } catch (_) {}
      STATE.obs = null;
    }
    clearMarks();
    removeHud();
  }

  function startAll(opts) {
    stopAll();
    STATE.depth = Math.max(1, Math.min(100, Number(opts.depth) || 18));
    STATE.autoPlay = !!opts.autoPlay;
    STATE.showHud = opts.showHud !== false;
    STATE.playDelayMin = Number(opts.delayMin) || 1400;
    STATE.playDelayMax = Number(opts.delayMax) || 3000;
    STATE.running = true;

    const colour = detectColour();
    STATE.lockedColour = colour;
    STATE.side = colour || "w";

    if (STATE.showHud) {
      ensureHud();
      setHud(null, siteLabel() + (colour
        ? " LOCKED " + colour.toUpperCase()
        : " waiting for board") + " (d" + STATE.depth + ")");
    }

    const generation = STATE.sessionId;
    connectEngine(generation);
    ensureObserver();
    tick();
    STATE._poll = setInterval(tick, 400);
    STATE._hb = setInterval(() => {
      if (!STATE.enginePort) return;
      try { STATE.enginePort.postMessage({ type: "ping" }); } catch (_) {}
    }, 20000);
  }

  api.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "start") {
      startAll(msg);
      sendResponse({ ok: true, running: true, lockedColour: STATE.lockedColour });
      return true;
    }
    if (msg.type === "stop") {
      stopAll();
      STATE.lockedColour = null;
      sendResponse({ ok: true, running: false });
      return true;
    }
    if (msg.type === "status") {
      sendResponse({
        ok: true,
        running: STATE.running,
        depth: STATE.depth,
        autoPlay: STATE.autoPlay,
        showHud: STATE.showHud,
        fen: STATE.lastFen,
        move: STATE.lastMove,
        status: STATE.status,
        lockedColour: STATE.lockedColour,
        side: STATE.side
      });
      return true;
    }
    if (msg.type === "setDepth") {
      STATE.depth = Math.max(1, Math.min(100, Number(msg.depth) || 18));
      STATE.requestId++;
      STATE.pending = false;
      STATE.pendingAt = 0;
      if (STATE.enginePort) {
        try { STATE.enginePort.postMessage({ type: "cancel" }); } catch (_) {}
      }
      clearAnalysis("depth set to d" + STATE.depth);
      sendResponse({ ok: true, depth: STATE.depth });
      if (STATE.running && STATE.position) analyze(STATE.position);
      return true;
    }
    if (msg.type === "setAuto") {
      STATE.autoPlay = !!msg.value;
      updateHudBtns();
      if (STATE.autoPlay && STATE.lastMove && isOurTurn()) schedulePlay(STATE.lastMove);
      sendResponse({ ok: true, autoPlay: STATE.autoPlay });
      return true;
    }
    if (msg.type === "setHud") {
      STATE.showHud = !!msg.value;
      if (STATE.showHud) {
        ensureHud();
        setHud(STATE.lastMove, STATE.status);
      } else if (STATE.hudRoot) {
        STATE.hudRoot.remove();
        STATE.hudRoot = null;
        STATE.hudEl = null;
      }
      sendResponse({ ok: true, showHud: STATE.showHud });
      return true;
    }
  });

  document.querySelectorAll("[data-bsc-mark],.cheat-highlight,[data-analysis-mark]").forEach(n => n.remove());
})();
