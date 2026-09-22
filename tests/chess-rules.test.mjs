import test from "node:test";
import assert from "node:assert/strict";
import { Chess } from "../app/chess/vendor/chess.js";
import { candidates, outcome } from "../app/chess/ai.js";

const sans = (game) => game.moves();

test("chess rules: initial legal moves and illegal king/pinned-piece moves", () => {
  const game = new Chess();
  assert.equal(game.moves().length, 20);
  assert.throws(() => game.move({ from: "e2", to: "e5" }));
  const pinned = new Chess("k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1");
  assert.ok(!pinned.moves({ square: "e2" }).includes("Rd2"));
});

test("chess rules: both castlings move the rook and undo restores rights", () => {
  for (const [san, king, rook] of [["O-O", "g1", "f1"], ["O-O-O", "c1", "d1"]]) {
    const game = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const before = game.fen();
    assert.ok(sans(game).includes(san));
    game.move(san);
    assert.equal(game.get(king).type, "k");
    assert.equal(game.get(rook).type, "r");
    game.undo();
    assert.equal(game.fen(), before);
  }
  const attacked = new Chess("r3kr1r/8/8/8/8/8/8/R3K2R w KQ - 0 1");
  assert.ok(!sans(attacked).includes("O-O"), "cannot castle through attacked f1");
  assert.ok(sans(attacked).includes("O-O-O"));
  const checked = new Chess("k3r3/8/8/8/8/8/8/R3K2R w KQ - 0 1");
  assert.ok(!sans(checked).some((san) => san.startsWith("O-O")));
});

test("chess rules: en passant removes the pawn, expires, and cannot expose the king", () => {
  const game = new Chess("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  const before = game.fen();
  game.move("exd6");
  assert.equal(game.get("d5"), undefined);
  assert.equal(game.get("d6").type, "p");
  game.undo();
  assert.equal(game.fen(), before);
  game.move("Kf1");
  game.move("Kf7");
  assert.ok(!sans(game).includes("exd6"));
  const pinned = new Chess("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  assert.ok(!sans(pinned).includes("exd6"));
});

test("chess rules: quiet and capture promotions include queen, rook, bishop and knight", () => {
  const game = new Chess("1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  for (const to of ["a8", "b8"]) {
    const choices = game.moves({ verbose: true }).filter((move) => move.from === "a7" && move.to === to);
    assert.deepEqual(choices.map((move) => move.promotion).sort(), ["b", "n", "q", "r"]);
    for (const piece of ["q", "r", "b", "n"]) {
      game.move({ from: "a7", to, promotion: piece });
      assert.equal(game.get(to).type, piece);
      game.undo();
    }
  }
});

test("chess rules: check, mate, stalemate and insufficient material are distinct", () => {
  const mate = new Chess("7k/6Q1/5K2/8/8/8/8/8 b - - 0 1");
  assert.equal(outcome(mate).kind, "checkmate");
  assert.match(outcome(mate).text, /White wins/);
  assert.deepEqual(candidates(mate), []);
  assert.equal(outcome(new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")).kind, "stalemate");
  assert.equal(outcome(new Chess("7k/8/6K1/8/8/8/8/8 w - - 0 1")).kind, "material");
  const check = new Chess("4k3/8/8/8/8/8/4R3/K7 b - - 0 1");
  assert.equal(outcome(check).over, false);
  assert.match(outcome(check).text, /check/);
});

test("chess rules: fifty-move and repetition draws, including undo and AI enumeration", () => {
  assert.equal(outcome(new Chess("4k3/8/8/8/8/8/8/R3K3 w - - 100 51")).kind, "fifty");
  const game = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1"]) game.move(move);
  const fen = game.fen();
  const history = game.history();
  const repeat = candidates(game).find((item) => item.san === "Ng8");
  assert.equal(repeat.facts.result.kind, "repetition");
  assert.equal(game.fen(), fen);
  assert.deepEqual(game.history(), history);
  game.move("Ng8");
  assert.equal(outcome(game).kind, "repetition");
  game.undo();
  assert.equal(outcome(game).over, false);
});
