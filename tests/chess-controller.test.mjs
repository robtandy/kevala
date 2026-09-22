import test from "node:test";
import assert from "node:assert/strict";
import { ChessController } from "../app/chess/controller.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let id = 0;
  const tasks = new Map();
  return {
    tasks,
    schedule(fn) { tasks.set(++id, fn); return id; },
    cancel(id) { tasks.delete(id); },
  };
}
function model() {
  const calls = [];
  return { calls, decideMany(items) { const job = { ...deferred(), items }; calls.push(job); return job.promise; } };
}
const scores = (job) => job.items.map(() => ({ answers: { good: { noul: 0.5 } } }));
function setup(mode = "self") {
  const timer = clock();
  const first = model();
  let active = first;
  let notifications = 0;
  const c = new ChessController({ getModel: () => active, onChange: () => notifications++, schedule: timer.schedule, cancel: timer.cancel });
  c.setMode(mode);
  c.setShown(true);
  return { c, first, timer, setModel: (next) => { active = next; c.syncModel(); }, notifications: () => notifications };
}

test("chess controller: local play works without a model, rejects illegal moves and undoes one ply", async () => {
  const c = new ChessController();
  c.setMode("local");
  c.setShown(true);
  assert.equal(c.play({ from: "e2", to: "e5" }), false);
  c.select("e2");
  assert.deepEqual(c.legalDestinations.sort(), ["e3", "e4"]);
  assert.equal(c.select("e4"), true);
  assert.equal(c.game.turn(), "b");
  assert.equal(c.play({ from: "e7", to: "e5" }), true);
  await c.request();
  assert.equal(c.busy, false);
  c.undo();
  assert.deepEqual(c.game.history(), ["e4"]);
  assert.equal(c.paused, true);
  c.reset();
  assert.equal(c.game.history().length, 0);
  assert.equal(c.selected, null);
  c.destroy();
});

test("chess controller: human White/Black ownership, no inference on a human-owned turn", async () => {
  const { c, first, timer } = setup("human");
  await c.request();
  assert.equal(first.calls.length, 0);
  assert.equal(timer.tasks.size, 0);
  assert.equal(c.play({ from: "e2", to: "e4" }), true);
  assert.equal(c.play({ from: "e7", to: "e5" }), false);
  assert.equal(timer.tasks.size, 1);
  c.setMode("human", "b");
  assert.equal(c.humanTurn, true);
  assert.equal(timer.tasks.size, 0);
  c.reset();
  assert.equal(c.modelTurn, true);
  assert.equal(timer.tasks.size, 1);
  c.destroy();
});

test("chess controller: promotion waits for an explicit choice and mode/reset/undo clear it", () => {
  const c = new ChessController();
  c.setMode("local");
  c.setShown(true);
  const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
  for (const piece of ["q", "r", "b", "n"]) {
    c.reset(fen);
    c.select("a7");
    c.select("a8");
    assert.equal(c.game.history().length, 0);
    assert.deepEqual(c.promotion.choices.slice().sort(), ["b", "n", "q", "r"]);
    assert.equal(c.promote("k"), false);
    assert.equal(c.promote(piece), true);
    assert.equal(c.game.get("a8").type, piece);
    assert.equal(c.promotion, null);
  }
  for (const change of [() => c.setMode("human"), () => c.undo(), () => c.reset()]) {
    c.setMode("local"); c.reset(fen); c.select("a7"); c.select("a8");
    change();
    assert.equal(c.promotion, null);
    assert.equal(c.selected, null);
  }
  c.destroy();
});

test("chess controller: an invalid reset preserves the game and a valid pending request", async () => {
  const { c, first } = setup();
  const pending = c.request();
  const game = c.game;
  const fen = game.fen();
  const epoch = c.epoch;
  assert.throws(() => c.reset("not a FEN"), /FEN/);
  assert.equal(c.game, game);
  assert.equal(c.game.fen(), fen);
  assert.equal(c.epoch, epoch);
  assert.equal(c.busy, true);
  first.calls[0].resolve(scores(first.calls[0]));
  await pending;
  assert.equal(c.game.history().length, 1);
  assert.equal(c.error, null);
  c.destroy();
});

test("chess controller: one batched request in flight, legal chosen move and exact input", async () => {
  const { c, first, timer } = setup();
  const pending = c.request();
  await c.request();
  c.syncModel();
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].items.length, 20);
  assert.equal(timer.tasks.size, 0);
  first.calls[0].resolve(scores(first.calls[0]));
  await pending;
  assert.equal(c.game.history().length, 1);
  assert.equal(c.decision.ranked.length, 20);
  assert.deepEqual(c.decision.input, first.calls[0].items[0]);
  assert.ok(Number.isFinite(c.decision.ms));
  assert.equal(timer.tasks.size, 1, "self-play schedules the next turn, not a tight loop");
  c.destroy();
  assert.equal(timer.tasks.size, 0);
});

for (const [name, invalidate] of [
  ["reset", (c) => c.reset()],
  ["undo", (c) => c.undo()],
  ["mode change", (c) => c.setMode("local")],
  ["human color change", (c) => c.setMode("human", "b")],
  ["hide", (c) => c.setShown(false)],
  ["document hidden", (c) => c.setDocumentVisible(false)],
  ["pause", (c) => c.setPaused(true)],
]) {
  for (const fail of [false, true]) {
    test(`chess controller: ${name} discards stale ${fail ? "failure" : "success"} and holds flight lock`, async () => {
      const { c, first } = setup();
      const pending = c.request();
      invalidate(c);
      const fen = c.game.fen();
      await c.request();
      assert.equal(first.calls.length, 1);
      assert.equal(c.busy, true);
      if (fail) first.calls[0].reject(new Error("stale inference failure"));
      else first.calls[0].resolve(scores(first.calls[0]));
      await pending;
      assert.equal(c.game.fen(), fen);
      assert.equal(c.error, null);
      assert.equal(c.decision, null);
      assert.equal(c.busy, false);
      c.destroy();
    });
  }
}

test("chess controller: stale failure cannot stop a reset-and-resumed run", async () => {
  const { c, first, timer } = setup();
  const old = c.request();
  c.reset(); c.setPaused(true); c.setPaused(false);
  first.calls[0].reject(new Error("old"));
  await old;
  assert.equal(c.paused, false);
  assert.equal(timer.tasks.size, 1);
  const next = c.request();
  first.calls[1].resolve(scores(first.calls[1]));
  await next;
  assert.equal(c.game.history().length, 1);
  assert.equal(c.error, null);
  c.destroy();
});

for (const fail of [false, true]) {
  test(`chess controller: model switch/unload discards old ${fail ? "failure" : "result"}, then uses only the new model`, async () => {
    const { c, first, setModel, timer } = setup();
    const old = c.request();
    setModel(null);
    const nextModel = model();
    setModel(nextModel);
    await c.request();
    assert.equal(nextModel.calls.length, 0);
    if (fail) first.calls[0].reject(new Error("disposed"));
    else first.calls[0].resolve(scores(first.calls[0]));
    await old;
    assert.equal(c.game.history().length, 0);
    assert.equal(c.error, null);
    assert.equal(timer.tasks.size, 1);
    const next = c.request();
    assert.equal(nextModel.calls.length, 1);
    nextModel.calls[0].resolve(scores(nextModel.calls[0]));
    await next;
    assert.equal(c.game.history().length, 1);
    c.destroy();
  });
}

test("chess controller: hidden document/view stops scheduling and resumes only when both visible", async () => {
  const { c, first, timer } = setup();
  c.setDocumentVisible(false);
  assert.equal(timer.tasks.size, 0);
  await c.request();
  assert.equal(first.calls.length, 0);
  c.setShown(false); c.setDocumentVisible(true);
  assert.equal(timer.tasks.size, 0);
  c.setShown(true);
  assert.equal(timer.tasks.size, 1);
  c.setPaused(true); c.setShown(false); c.setShown(true);
  assert.equal(timer.tasks.size, 0, "manual pause survives view navigation");
  c.destroy();
});

test("chess controller: visibility round trip invalidates a request even when the FEN matches", async () => {
  const { c, first } = setup();
  const pending = c.request();
  c.setDocumentVisible(false); c.setDocumentVisible(true);
  first.calls[0].resolve(scores(first.calls[0]));
  await pending;
  assert.equal(c.game.history().length, 0);
  c.destroy();
});

test("chess controller: inference failure and malformed scores stop, remain visible, and can retry", async () => {
  const { c, first, timer } = setup();
  const pending = c.request();
  first.calls[0].reject(new Error("GPU lost"));
  await pending;
  assert.equal(c.error, "GPU lost");
  assert.equal(timer.tasks.size, 0);
  c.setShown(false); c.setShown(true);
  assert.equal(c.error, "GPU lost");
  c.retry();
  const bad = c.request();
  first.calls[1].resolve([]);
  await bad;
  assert.match(c.error, /incomplete/);
  assert.equal(c.game.history().length, 0);
  c.retry();
  const good = c.request();
  first.calls[2].resolve(scores(first.calls[2]));
  await good;
  assert.equal(c.error, null);
  assert.equal(c.game.history().length, 1);
  c.destroy();
});

test("chess controller: synchronous inference errors are recoverable", async () => {
  const { c, setModel } = setup();
  setModel({ decideMany() { throw new Error("sync error"); } });
  await c.request();
  assert.equal(c.error, "sync error");
  assert.equal(c.busy, false);
  c.destroy();
});

test("chess controller: terminal games never request; a mating model move stops self-play", async () => {
  const { c, first, timer } = setup();
  c.reset("7k/6Q1/5K2/8/8/8/8/8 b - - 0 1");
  await c.request();
  assert.equal(first.calls.length, 0);
  assert.equal(timer.tasks.size, 0);
  c.reset("7k/8/5KQ1/8/8/8/8/8 w - - 0 1");
  const pending = c.request();
  first.calls[0].resolve(first.calls[0].items.map((item) => ({ answers: { good: { noul: item.state.includes("Qg7#") ? 1 : 0 } } })));
  await pending;
  assert.equal(c.result.kind, "checkmate");
  assert.equal(timer.tasks.size, 0);
  c.destroy();
});

test("chess controller: destroy cleans timers and prevents late notifications or errors", async () => {
  const { c, first, timer, notifications } = setup();
  const pending = c.request();
  c.destroy();
  const count = notifications();
  first.calls[0].reject(new Error("late"));
  await pending;
  assert.equal(notifications(), count);
  assert.equal(timer.tasks.size, 0);
  assert.equal(c.game.history().length, 0);
  assert.equal(c.error, null);
});
