// Measure one-ply outcomes, describe them, then rank only by the classifier's P(true).
// No chess search, heuristic move score or fallback player lives here.

export const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
export const colorName = (color) => color === "w" ? "White" : "Black";
const other = (color) => color === "w" ? "b" : "w";
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const CENTER = ["d4", "e4", "d5", "e5"];

export const QUESTION = {
  good: {
    type: "noul",
    instructions: "Is this a good chess move for the moving side?",
    criteria: {
      true: "wins the game, gains material, keeps pieces safe or improves their activity",
      false: "loses material, leaves a piece vulnerable or gives up an advantage",
    },
  },
};

/** Common draws are automatic here, including the normally claimable fifty-move/repetition draws. */
export function outcome(game) {
  if (game.isCheckmate()) return { over: true, kind: "checkmate", text: `${colorName(other(game.turn()))} wins by checkmate.` };
  if (game.isStalemate()) return { over: true, kind: "stalemate", text: "Draw by stalemate." };
  if (game.isInsufficientMaterial()) return { over: true, kind: "material", text: "Draw by insufficient material." };
  if (game.isThreefoldRepetition()) return { over: true, kind: "repetition", text: "Draw by threefold repetition." };
  if (game.isDrawByFiftyMoves()) return { over: true, kind: "fifty", text: "Draw by the fifty-move rule." };
  return { over: false, kind: "playing", text: `${colorName(game.turn())} to move${game.isCheck() ? " — check" : ""}.` };
}

export const moveInput = (move) => ({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
export const moveKey = (move) => `${move.from}${move.to}${move.promotion || ""}`;

function measure(game, move) {
  const us = move.color;
  const them = other(us);
  const pieces = game.board().flat().filter(Boolean);
  const totals = { w: 0, b: 0 };
  for (const piece of pieces) totals[piece.color] += VALUES[piece.type];
  const replies = game.moves({ verbose: true });
  const capturers = [...new Set(replies.filter((reply) => {
    // En passant captures the just-moved pawn beside the destination, not on it.
    const capturedSquare = reply.flags.includes("e") ? `${reply.to[0]}${reply.from[1]}` : reply.to;
    return capturedSquare === move.to && reply.captured;
  }).map((reply) => PIECE_NAMES[reply.piece]))];
  const home = us === "w" ? "1" : "8";
  return {
    result: outcome(game),
    check: game.isCheck(),
    captured: move.captured || null,
    enPassant: move.flags.includes("e"),
    promotion: move.promotion || null,
    castle: move.flags.includes("k") ? "kingside" : move.flags.includes("q") ? "queenside" : null,
    material: totals[us] - totals[them],
    capturers,
    attacked: game.isAttacked(move.to, them),
    defended: game.isAttacked(move.to, us),
    center: CENTER.filter((square) => game.isAttacked(square, us)).length,
    develops: ["n", "b"].includes(move.piece) && move.from[1] === home && move.to[1] !== home,
    homeMinors: pieces.filter((piece) => piece.color === us && ["n", "b"].includes(piece.type) && piece.square[1] === home).length,
  };
}

export function describe(move, facts) {
  const lines = [`${colorName(move.color)} moves ${PIECE_NAMES[move.piece]} from ${move.from} to ${move.to} (${move.san}).`];
  if (facts.result.over) lines.push(facts.result.text);
  else lines.push(facts.check ? "This gives check, not checkmate." : "This does not give check.");
  lines.push(facts.captured ? `Captures an enemy ${PIECE_NAMES[facts.captured]}${facts.enPassant ? " en passant" : ""}.` : "No capture.");
  if (facts.promotion) lines.push(`Promotes to a ${PIECE_NAMES[facts.promotion]}.`);
  if (facts.castle) lines.push(`Castles ${facts.castle}, moving the king and rook.`);
  const balance = facts.material === 0 ? "equal" : `${Math.abs(facts.material)} points ${facts.material > 0 ? "ahead" : "behind"}`;
  lines.push(`Moving side's material after the move: ${balance} (pawn 1, knight/bishop 3, rook 5, queen 9).`);
  lines.push(facts.capturers.length
    ? `The moved piece can be legally captured next turn by an enemy ${facts.capturers.join(" or ")}.`
    : "The moved piece cannot be legally captured next turn.");
  lines.push(facts.attacked ? "Its square is attacked by the opponent." : "Its square is not attacked by the opponent.");
  lines.push(facts.defended ? "A friendly piece also guards its square." : "No friendly piece guards its square.");
  lines.push(`Moving side attacks ${facts.center} of the four central squares.`);
  if (facts.develops) lines.push("Develops a knight or bishop off the home rank.");
  lines.push(`${facts.homeMinors} friendly knights/bishops remain on the home rank. No future variations searched.`);
  return lines.join(" ");
}

/** Temporary moves use the same game so repetition history survives; undo even on errors. */
export function candidates(game) {
  if (outcome(game).over) return [];
  return game.moves({ verbose: true }).map((move) => {
    game.move(moveInput(move));
    try {
      const facts = measure(game, move);
      return { move: moveInput(move), key: moveKey(move), san: move.san, color: move.color, facts, state: describe(move, facts) };
    } finally {
      game.undo();
    }
  });
}

const probability = (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

export function pGood(response) {
  const rounded = response?.answers?.good?.noul;
  const raw = response?.raw_probabilities?.good;
  // Kev's noul options are [false, true] (crates/kevala/src/kev.rs). Never infer the index
  // from rounded answers: near 0.5 both options round to the same value.
  if (Array.isArray(raw) && raw.length === 2 && raw.every(probability)) return raw[1];
  if (probability(rounded)) return rounded;
  throw new Error("The classifier did not return a valid P(good move). Retry or choose another model.");
}

export function rankCandidates(items, responses) {
  if (!Array.isArray(responses) || responses.length !== items.length || !items.length) {
    throw new Error("The classifier returned an incomplete set of move scores. Retry or choose another model.");
  }
  // Stable ties retain chess.js enumeration order, not a hidden chess heuristic.
  return items.map((item, index) => ({ ...item, p: pGood(responses[index]), response: responses[index] }))
    .sort((a, b) => b.p - a.p);
}
