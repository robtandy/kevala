import { ChessController } from "../chess/controller.js";
import { colorName, PIECE_NAMES } from "../chess/ai.js";
import { css, esc, fmtMs, highlightJSON, modelGate } from "../ui.js";

const GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const HTML = `<div class="wrap">
  <div class="ch-head">
    <h1>Chess, scored by a decision model</h1>
    <p class="muted">Play the shared classifier, watch both sides, or play a friend on this device. Local play needs no model download.</p>
  </div>
  <div class="ch-controls card pad">
    <label class="field">Play mode<select data-mode>
      <option value="human">You vs classifier</option><option value="self">Watch classifier self-play</option><option value="local">Local two-player</option>
    </select></label>
    <label class="field" data-color-field>Your side<select data-color><option value="w">White</option><option value="b">Black</option></select></label>
    <div class="row ch-actions">
      <button type="button" class="btn" data-action="reset">New game</button>
      <button type="button" class="btn" data-action="undo" title="Undo one move (one ply) and pause model play">Undo</button>
      <button type="button" class="btn" data-action="flip">Flip board</button>
      <button type="button" class="btn" data-action="pause" aria-pressed="false">Pause model</button>
    </div>
    <p class="tiny muted ch-control-note">Mode changes keep the position. Undo takes back one move and pauses the model.</p>
  </div>
  <div data-gate-wrap><div data-gate></div></div>
  <div class="ch-layout">
    <div class="ch-play">
      <div class="ch-status" role="status" aria-live="polite" aria-atomic="true" data-status></div>
      <div class="ch-board" role="grid" aria-label="Chess board" aria-describedby="ch-instructions" data-board></div>
      <div class="ch-promotion panel" role="group" aria-label="Choose promotion piece" data-promotion hidden>
        <b>Promote pawn to…</b>
        <div class="row">${["q", "r", "b", "n"].map((piece) => `<button type="button" class="btn" data-promote="${piece}">${PIECE_NAMES[piece]}</button>`).join("")}
          <button type="button" class="btn ghost" data-action="cancel">Cancel</button>
        </div>
      </div>
      <p id="ch-instructions" class="tiny muted ch-instructions">Select a piece, then a marked destination. Keyboard: arrow keys explore, Enter/Space select, Escape cancels. Gold = last move · mint ring = selected · dots/rings = legal moves · red = check.</p>
    </div>
    <aside class="ch-side">
      <div class="card pad ch-model" aria-label="Classifier move scores">
        <h2>What the classifier chose</h2>
        <p class="small muted">P(good move) is a classifier score, <strong>not a win probability</strong>. This is an experiment, not a strong chess engine.</p>
        <p class="small" data-model-status></p>
        <div class="ch-error panel" role="alert" data-error hidden><p data-error-text></p><button type="button" class="btn" data-action="retry">Retry model turn</button><p class="tiny muted">You can also change or unload the model in the header, or switch to local play.</p></div>
        <div class="ch-metrics" data-metrics>No model move yet.</div>
        <div class="ch-score-head tiny muted"><span>Top candidates · last model turn</span><span>P(good move)</span></div>
        <ol class="ch-candidates" data-candidates><li class="muted small">All legal moves will be scored. No hidden chess engine or fallback.</li></ol>
        <details class="ch-details"><summary>Exact chosen input &amp; response</summary>
          <p class="tiny muted">The state and question sent for the chosen move, plus its unmodified response. Timing above covers the full batch.</p>
          <div class="code"><pre data-input>No decision yet.</pre></div>
        </details>
      </div>
      <div class="card pad ch-history">
        <h2>Move history</h2>
        <div class="ch-history-scroll" tabindex="0" role="region" aria-label="Move history" data-history></div>
      </div>
    </aside>
  </div>
  <div class="ch-explain grid-3">
    <div><h3>1 · Legal moves</h3><p>Locally vendored <a href="https://github.com/jhlywa/chess.js">chess.js 1.4.0</a> enforces the rules, including castling, en passant and all four promotions.</p></div>
    <div><h3>2 · Immediate facts</h3><p>Code describes captures, material, the moved piece’s safety, check, center control and development. No recursive search or handcrafted move ranking.</p></div>
    <div><h3>3 · Classifier scores</h3><p>Every legal move goes to <code>decideMany</code>. The highest P(true) plays, with full-precision Kev scores when available. Ties keep legal-move order.</p></div>
  </div>
  <p class="tiny muted">Draws: stalemate, insufficient material, threefold repetition and the fifty-move rule. Repetition and fifty-move draws are automatic here, without a claim step. Model play waits while this view or browser tab is hidden. Rules library: <a href="app/chess/vendor/LICENSE">BSD-2-Clause license</a> · <a href="app/chess/vendor/README.md">provenance</a>.</p>
</div>`;

export function mount(el, { session }) {
  css(new URL("./chess.css", import.meta.url).href);
  el.innerHTML = HTML;
  const $ = (selector) => el.querySelector(selector);
  const board = $("[data-board]");
  const promotion = $("[data-promotion]");
  const events = new AbortController();
  let flipped = false;
  let focusSquare = "e2";
  let squares = [];
  let paintedDecision;
  let historyKey = "";
  let lastPromotion = null;
  const controller = new ChessController({ getModel: () => session.ready ? session.kevala : null, onChange: render });
  const unGate = modelGate($("[data-gate]"), "play chess with the classifier");

  function makeBoard() {
    const files = [..."abcdefgh"];
    const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
    if (flipped) { files.reverse(); ranks.reverse(); }
    squares = ranks.flatMap((rank) => files.map((file) => `${file}${rank}`));
    board.setAttribute("aria-label", `Chess board, ${flipped ? "Black" : "White"} at bottom`);
    board.innerHTML = ranks.map((rank) => `<div class="ch-rank" role="row">${files.map((file) => {
      const square = `${file}${rank}`;
      const dark = (file.charCodeAt(0) - 97 + rank) % 2 === 1;
      return `<div role="gridcell"><button type="button" class="ch-square ${dark ? "dark" : "light"}" data-square="${square}" tabindex="${square === focusSquare ? "0" : "-1"}"><span class="ch-coordinate" aria-hidden="true">${square}</span><span class="ch-piece" aria-hidden="true"></span></button></div>`;
    }).join("")}</div>`).join("");
  }

  function modelStatus(c) {
    if (c.mode === "local") return "Local two-player — no model needed.";
    if (c.result.over) return "Game finished. Start a new game or undo to continue.";
    if (c.error) return "Model turn failed. The board has not changed.";
    if (c.paused) return "Model play paused. Resume when ready; human turns remain playable.";
    if (!session.ready) return session.status === "loading" ? "Model loading… local play is still available." : "Load a model above when you want classifier play. Local play is always available.";
    if (!c.modelTurn) return `Your turn as ${colorName(c.humanColor)}.`;
    if (!c.shown || !c.documentVisible) return "Model play waits while hidden.";
    if (c.busy) return c.inflight.epoch === c.epoch ? "Scoring every legal move…" : "Waiting for an older request to finish; its result will be discarded.";
    return "Classifier’s turn…";
  }

  function render() {
    const c = controller;
    const game = c.game;
    const history = game.history({ verbose: true });
    const last = history.at(-1);
    const destinations = c.legalDestinations;
    const status = c.result.text + (c.promotion ? " Choose a promotion piece." : "");
    if ($("[data-status]").textContent !== status) $("[data-status]").textContent = status;
    $("[data-mode]").value = c.mode;
    $("[data-color]").value = c.humanColor;
    $("[data-color-field]").hidden = c.mode !== "human";
    $("[data-gate-wrap]").hidden = c.mode === "local";
    $("[data-action=undo]").disabled = !history.length;
    const pause = $("[data-action=pause]");
    pause.disabled = c.mode === "local" || c.result.over;
    pause.textContent = c.paused ? "Resume model" : "Pause model";
    pause.setAttribute("aria-pressed", String(c.paused));
    $("[data-model-status]").textContent = modelStatus(c);
    $("[data-error]").hidden = !c.error;
    $("[data-error-text]").textContent = c.error || "";
    for (const button of board.querySelectorAll("[data-square]")) {
      const square = button.dataset.square;
      const piece = game.get(square);
      const selected = c.selected === square;
      const legal = destinations.includes(square);
      const lastMove = last?.from === square || last?.to === square;
      const check = piece?.type === "k" && piece.color === game.turn() && game.isCheck();
      button.classList.toggle("selected", selected);
      button.classList.toggle("legal", legal);
      button.classList.toggle("occupied", !!piece);
      button.classList.toggle("last-move", lastMove);
      button.classList.toggle("in-check", check);
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", [square, piece ? `${colorName(piece.color)} ${PIECE_NAMES[piece.type]}` : "empty", selected ? "selected" : "", legal ? "legal destination" : "", lastMove ? "last move" : "", check ? "in check" : ""].filter(Boolean).join(", "));
      const glyph = button.querySelector(".ch-piece");
      glyph.textContent = piece ? GLYPHS[piece.type] : "";
      glyph.className = `ch-piece ${piece?.color === "w" ? "white-piece" : "black-piece"}`;
    }
    promotion.hidden = !c.promotion;
    // On narrow screens the chooser is below the board; focus must reveal it.
    if (c.promotion && c.promotion !== lastPromotion) promotion.querySelector("button").focus();
    lastPromotion = c.promotion;
    if (c.decision !== paintedDecision) {
      paintedDecision = c.decision;
      const d = c.decision;
      $("[data-metrics]").textContent = d ? `${colorName(d.best.color)} chose ${d.best.san} · ${d.ranked.length} legal moves · ${fmtMs(d.ms)}` : "No model move yet.";
      $("[data-candidates]").innerHTML = d ? d.ranked.slice(0, 5).map((item, index) => `<li${index === 0 ? ' class="chosen"' : ""}><span><b>${esc(item.san)}</b> <span class="tiny muted">${esc(item.move.from)}–${esc(item.move.to)}${item.move.promotion ? `=${esc(item.move.promotion.toUpperCase())}` : ""}</span></span><span class="mono" title="${item.p}">${(item.p * 100).toFixed(2)}%</span></li>`).join("") : '<li class="muted small">All legal moves will be scored. No hidden chess engine or fallback.</li>';
      $("[data-input]").innerHTML = d ? highlightJSON(JSON.stringify({ input: d.input, response: d.best.response }, null, 2)) : "No decision yet.";
    }
    const key = history.map((move) => move.lan).join(" ");
    if (key !== historyKey || !$("[data-history]").hasChildNodes()) {
      historyKey = key;
      const rows = [];
      for (const move of history) {
        const number = move.before.split(" ")[5];
        if (move.color === "w" || !rows.length) rows.push({ number, white: "—", black: "—" });
        rows.at(-1)[move.color === "w" ? "white" : "black"] = move.san;
      }
      $("[data-history]").innerHTML = rows.length ? `<table><thead><tr><th scope="col">Move</th><th scope="col">White</th><th scope="col">Black</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${esc(row.number)}.</th><td>${esc(row.white)}</td><td>${esc(row.black)}</td></tr>`).join("")}</tbody></table>` : '<p class="small muted">No moves yet. White moves first.</p>';
      $("[data-history]").scrollTop = $("[data-history]").scrollHeight;
    }
  }

  function focus(square) {
    focusSquare = square;
    for (const button of board.querySelectorAll("[data-square]")) button.tabIndex = button.dataset.square === square ? 0 : -1;
    // Reveal the square when returning from promotion or exploring a tall board by keyboard.
    board.querySelector(`[data-square="${square}"]`)?.focus();
  }

  el.addEventListener("click", (event) => {
    const square = event.target.closest("[data-square]")?.dataset.square;
    if (square) {
      focus(square);
      controller.select(square);
      return;
    }
    const promote = event.target.closest("[data-promote]")?.dataset.promote;
    if (promote) {
      const destination = controller.promotion?.to;
      if (controller.promote(promote)) focus(destination);
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "reset") controller.reset();
    if (action === "undo") controller.undo();
    if (action === "pause") controller.setPaused(!controller.paused);
    if (action === "retry") controller.retry();
    if (action === "flip") { flipped = !flipped; makeBoard(); render(); }
    if (action === "cancel") { controller.cancelSelection(); focus(focusSquare); }
  }, { signal: events.signal });

  el.addEventListener("change", (event) => {
    if (!event.target.matches("[data-mode], [data-color]")) return;
    const mode = $("[data-mode]").value;
    const color = $("[data-color]").value;
    if (mode === "human") { flipped = color === "b"; makeBoard(); }
    controller.setMode(mode, color);
  }, { signal: events.signal });

  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (controller.selected || controller.promotion) { event.preventDefault(); controller.cancelSelection(); focus(focusSquare); }
      return;
    }
    const square = event.target.closest("[data-square]")?.dataset.square;
    if (!square) return;
    const index = squares.indexOf(square);
    const row = Math.floor(index / 8);
    const col = index % 8;
    const moves = { ArrowLeft: row * 8 + Math.max(0, col - 1), ArrowRight: row * 8 + Math.min(7, col + 1), ArrowUp: Math.max(0, row - 1) * 8 + col, ArrowDown: Math.min(7, row + 1) * 8 + col, Home: row * 8, End: row * 8 + 7 };
    if (event.key in moves) { event.preventDefault(); focus(squares[moves[event.key]]); }
  }, { signal: events.signal });

  const visibility = () => controller.setDocumentVisible(!document.hidden);
  document.addEventListener("visibilitychange", visibility, { signal: events.signal });
  const unSession = session.on(() => controller.syncModel());
  makeBoard();
  visibility();
  render();
  // Small browser smoke seam, consistent with window.tetris. No weights needed for local tests.
  const handle = { controller, reset: (fen) => controller.reset(fen), flip: () => { flipped = !flipped; makeBoard(); render(); } };
  window.chess = handle;
  return {
    controller,
    show() { visibility(); controller.syncModel(); controller.setShown(true); },
    hide() { controller.setShown(false); },
    destroy() {
      controller.destroy();
      events.abort();
      unSession();
      unGate();
      if (window.chess === handle) delete window.chess;
      el.replaceChildren();
    },
  };
}
