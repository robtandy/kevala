import { Chess } from "./vendor/chess.js";
import { candidates, moveInput, moveKey, outcome, QUESTION, rankCandidates } from "./ai.js";

/** DOM-free game and request lifecycle. Invalidating a request does NOT release its flight lock.
 * Inference cannot be cancelled, so replacements wait for it to settle; both old results and old
 * errors are ignored. Every lifecycle change has an epoch, even if the position later repeats.
 */
export class ChessController {
  constructor({ getModel = () => null, onChange = () => {}, delay = 650,
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), fen } = {}) {
    this.game = new Chess(fen);
    this.getModel = getModel;
    this.onChange = onChange;
    this.delay = delay;
    this.schedule = schedule;
    this.cancel = cancel;
    this.mode = "human";
    this.humanColor = "w";
    this.paused = false;
    this.shown = false;
    this.documentVisible = true;
    this.selected = null;
    this.promotion = null;
    this.decision = null;
    this.error = null;
    this.epoch = 0;
    this.inflight = null;
    this.timer = null;
    this.destroyed = false;
    this.model = getModel();
  }

  get result() { return outcome(this.game); }
  get modelTurn() { return this.mode === "self" || (this.mode === "human" && this.game.turn() !== this.humanColor); }
  get humanTurn() { return !this.destroyed && this.shown && this.documentVisible && !this.result.over && !this.modelTurn; }
  get busy() { return !!this.inflight; }
  get legalDestinations() {
    return this.selected ? [...new Set(this.game.moves({ square: this.selected, verbose: true }).map((move) => move.to))] : [];
  }

  #stopTimer() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  #invalidate({ clearDecision = true, clearError = true } = {}) {
    this.epoch++;
    this.#stopTimer();
    this.selected = null;
    this.promotion = null;
    if (clearError) this.error = null;
    if (clearDecision) this.decision = null;
  }

  #eligible() {
    return !this.destroyed && this.shown && this.documentVisible && !this.paused &&
      !this.error && this.modelTurn && !!this.model && this.getModel() === this.model && !this.result.over;
  }

  #emit() {
    if (this.destroyed) return;
    this.onChange(this);
    if (this.#eligible() && !this.inflight && this.timer === null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        void this.request();
      }, this.delay);
    }
  }

  syncModel() {
    const model = this.getModel();
    if (model !== this.model) {
      this.#invalidate();
      this.model = model;
    }
    this.#emit();
  }

  setShown(shown) {
    if (this.shown === shown) return;
    this.shown = shown;
    this.#invalidate({ clearDecision: false, clearError: false });
    this.#emit();
  }

  setDocumentVisible(visible) {
    if (this.documentVisible === visible) return;
    this.documentVisible = visible;
    this.#invalidate({ clearDecision: false, clearError: false });
    this.#emit();
  }

  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.#invalidate({ clearDecision: false });
    this.#emit();
  }

  /** Changing ownership keeps the position/history, but no pending selection or old scores. */
  setMode(mode, humanColor = this.humanColor) {
    if (!["human", "self", "local"].includes(mode) || !["w", "b"].includes(humanColor)) throw new Error("Invalid chess mode");
    if (mode === this.mode && humanColor === this.humanColor) return;
    this.#invalidate();
    this.mode = mode;
    this.humanColor = humanColor;
    this.#emit();
  }

  /** Optional FEN is also the browser/Node test seam; invalid input leaves the game untouched. */
  reset(fen) {
    const game = new Chess(fen);
    this.#invalidate();
    this.game = game;
    this.paused = false;
    this.#emit();
  }

  /** One ply, always pausing model play so an undone move is not instantly replayed. */
  undo() {
    this.#invalidate();
    this.paused = true;
    const move = this.game.undo();
    this.#emit();
    return move;
  }

  cancelSelection() {
    this.selected = null;
    this.promotion = null;
    this.#emit();
  }

  select(square) {
    if (!this.humanTurn || this.promotion) return false;
    if (this.selected === square) {
      this.cancelSelection();
      return false;
    }
    const options = this.selected ? this.game.moves({ square: this.selected, verbose: true }).filter((move) => move.to === square) : [];
    if (options.length) {
      if (options.some((move) => move.promotion)) {
        this.promotion = { from: this.selected, to: square, choices: options.map((move) => move.promotion) };
        this.#emit();
        return false;
      }
      return this.play(options[0]);
    }
    this.selected = this.game.get(square)?.color === this.game.turn() ? square : null;
    this.#emit();
    return false;
  }

  promote(piece) {
    if (!this.promotion?.choices.includes(piece)) return false;
    return this.play({ from: this.promotion.from, to: this.promotion.to, promotion: piece });
  }

  /** Human input cannot move the classifier's pieces, or bypass the legal-move list. */
  play(input) {
    if (!this.humanTurn) return false;
    const legal = this.game.moves({ verbose: true }).find((move) => moveKey(move) === moveKey(input));
    if (!legal) return false;
    this.#invalidate();
    this.game.move(moveInput(legal));
    this.#emit();
    return true;
  }

  retry() {
    this.#invalidate();
    this.paused = false;
    this.#emit();
  }

  async request() {
    this.#stopTimer();
    if (this.inflight || !this.#eligible()) return;
    const tag = { epoch: this.epoch, fen: this.game.fen(), model: this.model };
    const current = () => this.inflight === tag && tag.epoch === this.epoch &&
      tag.fen === this.game.fen() && tag.model === this.getModel() && this.#eligible();
    this.inflight = tag;
    this.#emit();
    try {
      const items = candidates(this.game);
      const start = performance.now();
      const responses = await tag.model.decideMany(items.map(({ state }) => ({ state, questions: QUESTION })));
      const ms = performance.now() - start;
      if (!current()) return;
      const ranked = rankCandidates(items, responses);
      const best = ranked[0];
      const legal = this.game.moves({ verbose: true }).find((move) => moveKey(move) === best.key);
      if (!legal) throw new Error("The chosen move is no longer legal. Retry from this position.");
      this.game.move(moveInput(legal));
      this.epoch++;
      this.selected = null;
      this.promotion = null;
      this.decision = { ranked, best, ms, fen: tag.fen, input: { state: best.state, questions: QUESTION } };
    } catch (error) {
      if (current()) this.error = error?.message || String(error);
    } finally {
      if (this.inflight === tag) this.inflight = null;
      this.#emit();
    }
  }

  destroy() {
    this.#invalidate();
    this.destroyed = true;
    this.onChange = () => {};
  }
}
