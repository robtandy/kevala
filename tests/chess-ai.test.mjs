import test from "node:test";
import assert from "node:assert/strict";
import { Chess } from "../app/chess/vendor/chess.js";
import { candidates, pGood, QUESTION, rankCandidates } from "../app/chess/ai.js";

const response = (noul, raw) => ({ answers: { good: { type: "noul", noul } }, ...(raw ? { raw_probabilities: { good: raw } } : {}) });

test("chess AI: enumerates every legal move without changing position or history", () => {
  const game = new Chess();
  game.move("e4");
  const fen = game.fen();
  const history = game.history();
  const items = candidates(game);
  assert.equal(items.length, game.moves().length);
  assert.equal(new Set(items.map((item) => item.key)).size, items.length);
  assert.equal(game.fen(), fen);
  assert.deepEqual(game.history(), history);
  assert.ok(items.every((item) => item.state.includes("Black moves")));
  assert.ok(items.every((item) => item.state.length < 1200), "concise descriptions, leaving room for the Laya question/template");
  assert.equal(QUESTION.good.type, "noul");
});

test("chess AI: a failed measurement still restores the position and repetition history", () => {
  const game = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1"]) game.move(move);
  const fen = game.fen();
  const history = game.history();
  game.isAttacked = () => { throw new Error("measurement failed"); };
  assert.throws(() => candidates(game), /measurement failed/);
  delete game.isAttacked;
  assert.equal(game.fen(), fen);
  assert.deepEqual(game.history(), history);
  assert.equal(game.isThreefoldRepetition(), false);
  assert.equal(candidates(game).find((item) => item.san === "Ng8").facts.result.kind, "repetition");
});

test("chess AI: capture, material and moved-piece vulnerability are measured, not ranked", () => {
  const game = new Chess("3rk3/8/8/8/8/8/3p4/3QK3 w - - 0 1");
  const item = candidates(game).find((item) => item.move.to === "d2" && item.move.from === "d1");
  assert.equal(item.facts.captured, "p");
  assert.equal(item.facts.material, 4);
  assert.ok(item.facts.capturers.includes("rook"));
  assert.match(item.state, /Captures an enemy pawn/);
  assert.match(item.state, /4 points ahead/);
  assert.match(item.state, /legally captured next turn by an enemy rook/);
  assert.equal(item.p, undefined, "measurements do not assign move scores");
});

test("chess AI: en passant capture and en passant vulnerability are both described", () => {
  const ep = candidates(new Chess("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1")).find((item) => item.san === "exd6");
  assert.equal(ep.facts.enPassant, true);
  assert.match(ep.state, /en passant/);
  const double = candidates(new Chess("4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1")).find((item) => item.san === "e4");
  assert.deepEqual(double.facts.capturers, ["pawn"]);
});

test("chess AI: castling, promotion, development, checkmate and draws appear in the state", () => {
  const castle = candidates(new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")).find((item) => item.san === "O-O");
  assert.match(castle.state, /Castles kingside/);
  const promote = candidates(new Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1"));
  assert.equal(promote.filter((item) => item.move.promotion).length, 4);
  assert.match(promote.find((item) => item.move.promotion === "n").state, /Promotes to a knight/);
  assert.match(promote.find((item) => item.move.promotion === "n").state, /insufficient material/);
  const develop = candidates(new Chess()).find((item) => item.san === "Nf3");
  assert.equal(develop.facts.develops, true);
  assert.match(develop.state, /Develops a knight/);
  assert.ok(develop.facts.center > 0);
  const mate = candidates(new Chess("7k/8/5KQ1/8/8/8/8/8 w - - 0 1")).find((item) => item.san === "Qg7#");
  assert.match(mate.state, /White wins by checkmate/);
});

test("chess AI: Kev raw noul is index 1, including rounded 0.5 and reversed criteria order", () => {
  assert.equal(pGood(response(0.5, [0.504, 0.496])), 0.496);
  assert.equal(pGood(response(0.5, [0.496, 0.504])), 0.504);
  assert.equal(pGood(response(1, [0.00007, 0.99993])), 0.99993);
  assert.equal(pGood(response(0.1234)), 0.1234);
  assert.equal(pGood(response(0.4, [NaN, 0.6])), 0.4);
  assert.throws(() => pGood(response(NaN)), /valid P/);
  assert.throws(() => pGood({}), /valid P/);
});

test("chess AI: ranking uses only model probability, full precision and stable ties", () => {
  const items = [{ san: "a", state: "loses material" }, { san: "b", state: "wins material" }, { san: "c" }];
  const ranked = rankCandidates(items, [response(0.5, [0.499, 0.501]), response(0.5, [0.501, 0.499]), response(0.5, [0.499, 0.501])]);
  assert.deepEqual(ranked.map((item) => item.san), ["a", "c", "b"]);
  assert.throws(() => rankCandidates(items, []), /incomplete/);
  assert.throws(() => rankCandidates(items, [response(0.7), {}, response(0.6)]), /valid P/);
});
