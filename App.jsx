import React, { useState, useEffect, useRef } from "react";
import { db } from "./firebase.js";
import { ref, set, get, remove, onValue } from "firebase/database";

/* ============================== THEME ============================== */
const T = {
  felt: "#0B3D2E",
  feltDark: "#082A20",
  feltLine: "#0F4A37",
  brass: "#C9A227",
  brassLight: "#E6C766",
  brassDim: "#8A7220",
  cream: "#F7F3E8",
  ink: "#1C1B18",
  red: "#A3312A",
  black: "#1C1B18",
  panel: "#0E3B2C",
  active: "#2F6B4F",
};
const DISPLAY_FONT = '"Iowan Old Style", "Palatino Linotype", Georgia, serif';

/* Fixed per-seat colors (by position in turnOrder, not by name) so every
   player has a stable color for the life of the table, up to 10 players. */
const SEAT_COLORS = [
  "#E6C766", // brass/gold
  "#7FB8A4", // teal-green
  "#E8956B", // coral
  "#8FA8E6", // periwinkle
  "#D97BAE", // rose
  "#A8D46F", // lime
  "#C77DD9", // lavender
  "#66C7C2", // aqua
  "#E0A5E6", // orchid
  "#B0B8C4", // slate
];
function seatColor(room, pid) {
  const i = room.turnOrder.indexOf(pid);
  return SEAT_COLORS[i >= 0 ? i % SEAT_COLORS.length : 0];
}
function ColorDot({ color, size = 8 }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 99,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "9px 2px",
      }}
    >
      <span style={{ fontSize: 14, color: T.ink, fontFamily: DISPLAY_FONT }}>{label}</span>
      <button
        onClick={onChange}
        aria-pressed={checked}
        aria-label={label}
        style={{
          width: 44,
          height: 26,
          borderRadius: 99,
          border: "none",
          padding: 3,
          background: checked ? T.brass : "#d8d0ba",
          display: "flex",
          justifyContent: checked ? "flex-end" : "flex-start",
          transition: "background 150ms ease",
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 99,
            background: "#fff",
            display: "block",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            transition: "transform 150ms ease",
          }}
        />
      </button>
    </div>
  );
}

/* ============================== CARD ENGINE ============================== */
const SUITS = ["C", "D", "H", "S"];
const SUIT_SYMBOL = { C: "♣", D: "♦", H: "♥", S: "♠" };
const SUIT_NAME = { C: "Clubs", D: "Diamonds", H: "Hearts", S: "Spades" };
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const RANK_LABEL = { T: "10", J: "J", Q: "Q", K: "K", A: "A" };

function rankValue(r) {
  return RANKS.indexOf(r) + 2;
}
function cardId(c) {
  return c.rank + c.suit;
}
function isRedSuit(suit) {
  return suit === "H" || suit === "D";
}
function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  return deck;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const si = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    if (si !== 0) return si;
    return rankValue(a.rank) - rankValue(b.rank);
  });
}

const ROUND_META = {
  1: { label: "Tricks", detail: "10 pts per trick won" },
  2: { label: "Queens", detail: "25 pts per queen captured" },
  3: { label: "Hearts", detail: "10 pts per heart captured" },
  4: { label: "King of Spades", detail: "100 pts for capturing K♠" },
  5: { label: "Last Trick", detail: "100 pts for winning the final trick" },
  6: { label: "Everything Counts", detail: "All previous rules combined" },
};

function canPlayCard(hand, card, leadSuit, forcedCard) {
  if (forcedCard) return card.rank === forcedCard.rank && card.suit === forcedCard.suit;
  if (!leadSuit) return true;
  const hasLead = hand.some((c) => c.suit === leadSuit);
  if (hasLead) return card.suit === leadSuit;
  return true;
}

/* The round always opens on clubs, led with the lowest club actually in a
   hand (the 2♣ leads unless it landed in the kitty, in which case the next
   lowest club in play leads, and so on). The kitty is always smaller than
   a full suit, so a club in someone's hand is guaranteed to exist. */
function findForcedOpener(hands, turnOrder) {
  for (const r of RANKS) {
    for (const pid of turnOrder) {
      if (hands[pid].some((c) => c.suit === "C" && c.rank === r)) {
        return { playerId: pid, card: { rank: r, suit: "C" } };
      }
    }
  }
  return { playerId: turnOrder[0], card: null };
}

function computeRoundPoints(round, tricksWon, capturedCards, pid, lastTrickWinner) {
  let pts = 0;
  const wantsTricks = round === 1 || round === 6;
  const wantsQueens = round === 2 || round === 6;
  const wantsHearts = round === 3 || round === 6;
  const wantsKingSpades = round === 4 || round === 6;
  const wantsLastTrick = round === 5 || round === 6;
  if (wantsTricks) pts += tricksWon * 10;
  if (wantsQueens) pts += capturedCards.filter((c) => c.rank === "Q").length * 25;
  if (wantsHearts) pts += capturedCards.filter((c) => c.suit === "H").length * 10;
  if (wantsKingSpades && capturedCards.some((c) => c.rank === "K" && c.suit === "S")) pts += 100;
  if (wantsLastTrick && pid === lastTrickWinner) pts += 100;
  return pts;
}

/* ============================== ROOM STATE HELPERS (Firebase) ============================== */
function roomRef(code) {
  return ref(db, "rooms/" + code);
}

/* Firebase Realtime Database silently drops empty arrays/objects (a []
   or {} written to a path simply doesn't exist when read back). The game
   logic assumes hands/capturedCards/currentTrick/log/kitty are always
   arrays (or turnOrder-keyed objects of arrays), so every room pulled out
   of Firebase gets normalized back into that shape before it touches any
   game logic or renders. */
function hydrateRoom(raw) {
  if (!raw) return raw;
  const room = { ...raw };
  room.turnOrder = room.turnOrder || [];
  room.players = room.players || [];
  room.log = room.log || [];
  room.kitty = room.kitty || [];
  room.currentTrick = room.currentTrick || [];
  room.scores = room.scores || {};
  room.hands = room.hands || {};
  room.capturedCards = room.capturedCards || {};
  room.tricksWon = room.tricksWon || {};
  room.turnOrder.forEach((pid) => {
    room.hands[pid] = room.hands[pid] || [];
    room.capturedCards[pid] = room.capturedCards[pid] || [];
    room.tricksWon[pid] = room.tricksWon[pid] || 0;
    room.scores[pid] = room.scores[pid] || {};
  });
  return room;
}

/* Player-typed names become object keys and path segments in Firebase,
   which forbids . # $ [ ] / in keys. Strip anything unsafe. */
function sanitizeId(str) {
  return str.trim().replace(/[.#$/[\]]/g, "").slice(0, 24);
}

/* Remember the last table this device was at, so a dropped connection,
   an accidental tab close, or a phone restart can rejoin automatically
   instead of forcing a retype of name + room code. */
const SESSION_KEY = "texasChiliSession";
function saveSession(code, name) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code, name }));
  } catch (e) {
    /* ignore — private browsing etc. */
  }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {
    /* ignore */
  }
}

/* Turn chime / turn flash on-off preferences — per-device, not shared
   game state, so these live in localStorage rather than the room. */
const CHIME_PREF_KEY = "texasChiliChimeEnabled";
const FLASH_PREF_KEY = "texasChiliFlashEnabled";
const DOUBLE_TAP_PREF_KEY = "texasChiliDoubleTapEnabled";
function loadBoolPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch (e) {
    return fallback;
  }
}
function saveBoolPref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (e) {
    /* ignore */
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function loadRoom(code) {
  try {
    const snap = await get(roomRef(code));
    if (!snap.exists()) return null;
    const room = hydrateRoom(snap.val());
    if (room.createdAt && Date.now() - room.createdAt > THIRTY_DAYS_MS) {
      await remove(roomRef(code));
      return null;
    }
    return room;
  } catch (e) {
    console.error("load failed", e);
    return null;
  }
}
async function saveRoom(code, room) {
  try {
    await set(roomRef(code), room);
  } catch (e) {
    console.error("save failed", e);
  }
  return room;
}
async function deleteRoom(code) {
  try {
    await remove(roomRef(code));
  } catch (e) {
    console.error("delete failed", e);
  }
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function pushLog(room, msg) {
  room.log = [msg, ...(room.log || [])].slice(0, 6);
}

/* Deals a fresh round into an existing room object (mutates + returns) */
function startRound(room, roundNumber) {
  const n = room.turnOrder.length;
  const deck = shuffle(buildDeck());

  // Kitty = the natural leftover from dealing 52 cards to n players.
  // Only forced to a fixed 4 when the deck divides evenly (no natural
  // leftover) — in the 3-10 player range that's just n=4 (52/4=13 even).
  const remainder = 52 % n;
  const kittySize = remainder === 0 ? 4 : remainder;

  const kitty = deck.slice(0, kittySize);
  const dealPool = deck.slice(kittySize);
  const perPlayer = dealPool.length / n; // always divides evenly by construction

  const hands = {};
  room.turnOrder.forEach((pid, i) => {
    hands[pid] = sortHand(dealPool.slice(i * perPlayer, (i + 1) * perPlayer));
  });

  const opener = findForcedOpener(hands, room.turnOrder);

  room.round = roundNumber;
  room.hands = hands;
  room.kitty = kitty;
  room.kittyAwarded = false;
  room.kittyReveal = null;
  room.awaitingTrickClear = false;
  room.trickWinnerId = null;
  room.currentTrick = [];
  room.leadSuit = null;
  room.forcedOpenCard = opener.card;
  room.leaderId = opener.playerId;
  room.currentTurnId = opener.playerId;
  room.trickNumber = 1;
  room.tricksWon = {};
  room.capturedCards = {};
  room.turnOrder.forEach((pid) => {
    room.tricksWon[pid] = 0;
    room.capturedCards[pid] = [];
  });
  room.lastTrickWinner = null;
  room.status = "playing";
  room.roundEndInfo = null;
  const dealerName = room.players.find((p) => p.id === opener.playerId)?.name || opener.playerId;
  const openCardLabel = opener.card ? `${RANK_LABEL[opener.card.rank] || opener.card.rank}${SUIT_SYMBOL[opener.card.suit]}` : "?";
  pushLog(room, `Round ${roundNumber} dealt (${kittySize}-card kitty set aside). ${dealerName} leads with ${openCardLabel}.`);
  return room;
}

function playCard(room, playerId, card) {
  if (room.status !== "playing") return room;
  if (room.awaitingTrickClear) return room; // paused showing the trick winner — no plays yet
  if (room.currentTurnId !== playerId) return room;
  const hand = room.hands[playerId] || [];
  const idx = hand.findIndex((c) => c.rank === card.rank && c.suit === card.suit);
  if (idx === -1) return room;

  const forcedOpen = room.trickNumber === 1 && room.currentTrick.length === 0 ? room.forcedOpenCard : null;
  if (!canPlayCard(hand, card, room.leadSuit, forcedOpen)) return room;

  hand.splice(idx, 1);
  room.hands[playerId] = hand;

  if (room.currentTrick.length === 0) room.leadSuit = card.suit;
  room.currentTrick.push({ playerId, card });

  const playerName = room.players.find((p) => p.id === playerId)?.name || playerId;
  pushLog(room, `${playerName} played ${RANK_LABEL[card.rank] || card.rank}${SUIT_SYMBOL[card.suit]}`);

  const n = room.turnOrder.length;
  if (room.currentTrick.length < n) {
    const curIdx = room.turnOrder.indexOf(playerId);
    room.currentTurnId = room.turnOrder[(curIdx + 1) % n];
    return room;
  }

  // Trick complete — mark the winner but leave all 4 cards on the table.
  // The actual capture/clear/advance happens in resolveTrickAfterPause,
  // triggered client-side after a short delay so everyone can see who won.
  const leadSuit = room.leadSuit;
  let winning = room.currentTrick[0];
  for (const play of room.currentTrick) {
    if (play.card.suit === leadSuit && rankValue(play.card.rank) > rankValue(winning.card.rank)) {
      winning = play;
    }
  }
  room.trickWinnerId = winning.playerId;
  room.awaitingTrickClear = true;
  const winnerName = room.players.find((p) => p.id === winning.playerId)?.name || winning.playerId;
  pushLog(room, `${winnerName} won the trick.`);

  return room;
}

/* Runs after the trick-winner pause: captures the cards, awards the kitty
   if this was the first trick, advances the turn, and checks for a round
   end. Safe to call from multiple clients — it's a no-op once awaitingTrickClear
   has already been cleared, and every client computes the same result from
   the same frozen state, so a harmless duplicate write is the worst case. */
function resolveTrickAfterPause(room) {
  if (!room.awaitingTrickClear) return room;
  const winnerId = room.trickWinnerId;
  const wonCards = room.currentTrick.map((p) => p.card);
  room.capturedCards[winnerId] = (room.capturedCards[winnerId] || []).concat(wonCards);
  room.tricksWon[winnerId] = (room.tricksWon[winnerId] || 0) + 1;
  room.lastTrickWinner = winnerId;

  if (!room.kittyAwarded && room.kitty.length > 0) {
    room.capturedCards[winnerId] = room.capturedCards[winnerId].concat(room.kitty);
    room.kittyAwarded = true;
    room.kittyRevealSeq = (room.kittyRevealSeq || 0) + 1;
    room.kittyReveal = { id: room.kittyRevealSeq, winnerId, cards: room.kitty };
  }

  room.currentTrick = [];
  room.leadSuit = null;
  room.leaderId = winnerId;
  room.currentTurnId = winnerId;
  room.trickNumber += 1;
  room.awaitingTrickClear = false;
  room.trickWinnerId = null;

  const handsEmpty = room.turnOrder.every((pid) => (room.hands[pid] || []).length === 0);
  const earlyEnd = checkEarlyRoundEnd(room);
  if (handsEmpty || earlyEnd.done) {
    if (earlyEnd.done && !handsEmpty) pushLog(room, earlyEnd.reason);
    // Score the round
    const breakdown = {};
    room.turnOrder.forEach((pid) => {
      const pts = computeRoundPoints(room.round, room.tricksWon[pid] || 0, room.capturedCards[pid] || [], pid, room.lastTrickWinner);
      breakdown[pid] = pts;
      room.scores[pid] = room.scores[pid] || {};
      room.scores[pid][room.round] = pts;
    });
    room.roundEndInfo = { round: room.round, breakdown, earlyReason: earlyEnd.done && !handsEmpty ? earlyEnd.reason : null };
    room.status = room.round >= 6 ? "game-end" : "round-end";
    pushLog(room, room.status === "game-end" ? "Final round scored. Game over." : `Round ${room.round} scored.`);
  }

  return room;
}

/* Rounds 2, 3, and 4 only score specific cards — once every card that could
   ever score has been captured, nothing left in hand matters, so the round
   ends immediately rather than playing out empty tricks. */
function checkEarlyRoundEnd(room) {
  const allCaptured = Object.values(room.capturedCards).flat();
  if (room.round === 2) {
    const queensSeen = allCaptured.filter((c) => c.rank === "Q").length;
    if (queensSeen >= 4) return { done: true, reason: "All four queens have been captured — round ends early." };
  }
  if (room.round === 3) {
    const heartsSeen = allCaptured.filter((c) => c.suit === "H").length;
    if (heartsSeen >= 13) return { done: true, reason: "All thirteen hearts have been captured — round ends early." };
  }
  if (room.round === 4) {
    const kingCaptured = allCaptured.some((c) => c.rank === "K" && c.suit === "S");
    if (kingCaptured) return { done: true, reason: "The King of Spades has been captured — round ends early." };
  }
  return { done: false, reason: null };
}

/* ============================== BOT AI ==============================
   Every scoring rule in this game is a penalty, not a reward, so the bot's
   whole posture is defensive by default: avoid winning, dump danger cards
   the moment it's safe to, never volunteer a disaster. Round 5 flips that
   for most of the round (winning keeps the lead, which lets the bot choose
   what gets led), and hearts get a deliberate baiting exception. The bot
   only ever reasons from information a real player would actually have —
   its own hand plus everything publicly captured/played — never anyone
   else's hand contents. */

function getUnseenCards(room, botId) {
  const seen = new Set();
  (room.hands[botId] || []).forEach((c) => seen.add(cardId(c)));
  Object.values(room.capturedCards || {}).forEach((arr) => arr.forEach((c) => seen.add(cardId(c))));
  (room.currentTrick || []).forEach((p) => seen.add(cardId(p.card)));
  return buildDeck().filter((c) => !seen.has(cardId(c)));
}

function highestRank(cards) {
  return cards.length ? Math.max(...cards.map((c) => rankValue(c.rank))) : 0;
}

function chooseBotCard(room, botId) {
  const hand = room.hands[botId] || [];
  if (hand.length === 1) return hand[0]; // forced — the round's true "last trick" moment

  const round = room.round;
  const wantsQueens = round === 2 || round === 6;
  const wantsHearts = round === 3 || round === 6;
  const wantsKingSpades = round === 4 || round === 6;
  const wantsLastTrick = round === 5 || round === 6;

  const leadSuit = room.leadSuit;
  const isLeading = room.currentTrick.length === 0;
  const forcedOpen = room.trickNumber === 1 && isLeading ? room.forcedOpenCard : null;
  if (forcedOpen) {
    return hand.find((c) => c.rank === forcedOpen.rank && c.suit === forcedOpen.suit) || hand[0];
  }

  const unseen = getUnseenCards(room, botId);
  const tricksLeft = hand.length;

  function isDanger(c) {
    return (
      (wantsKingSpades && c.rank === "K" && c.suit === "S") ||
      (wantsHearts && c.suit === "H") ||
      (wantsQueens && c.rank === "Q")
    );
  }
  // A card this bot is guaranteed to win with whenever it's eventually
  // played into a trick of its own suit — no unseen card of that suit
  // outranks it. Worth protecting for a Round 5 endgame strike.
  function isControlCard(c) {
    const rivalRanks = unseen.filter((u) => u.suit === c.suit);
    return rankValue(c.rank) > highestRank(rivalRanks);
  }
  const byRankAsc = (a, b) => rankValue(a.rank) - rankValue(b.rank);
  const byRankDesc = (a, b) => rankValue(b.rank) - rankValue(a.rank);

  // Winning the second-to-last trick of the round means YOU lead the true
  // last trick — and since it's forced (one card each), whatever single
  // card you have left sets the suit everyone else measures against. If
  // that leftover card isn't a genuine control card, leading it is close
  // to a coin-flip loss. So at exactly two tricks left, only chase a win
  // if doing so leaves a guaranteed winner behind for the real finale.
  function setsUpFinalWin(candidateCard) {
    if (tricksLeft !== 2) return true;
    const remaining = hand.filter((c) => !(c.rank === candidateCard.rank && c.suit === candidateCard.suit));
    return remaining.length === 1 && isControlCard(remaining[0]);
  }

  /* ---------------- LEADING ---------------- */
  if (isLeading) {
    // Heart-baiting: holding just one or two low hearts is worth leading —
    // it forces every other heart-holder to follow suit into this trick,
    // and whoever's sitting on the high hearts gets stuck capturing them.
    if (wantsHearts) {
      const hearts = hand.filter((c) => c.suit === "H");
      if (hearts.length > 0 && hearts.length <= 2) {
        const lowest = hearts.slice().sort(byRankAsc)[0];
        if (rankValue(lowest.rank) <= 8) return lowest;
      }
    }

    // Round 5 control play: with tricks still to spare, take the lead using
    // a card that's both safe and not a protected control card — winning
    // cheaply here costs nothing and keeps the choice of suit in our hands.
    // At exactly two tricks left, only do this if it sets up a guaranteed
    // win on the true final trick (see setsUpFinalWin above).
    if (wantsLastTrick && tricksLeft > 1) {
      const safe = hand.filter((c) => !isDanger(c) && !isControlCard(c) && setsUpFinalWin(c));
      if (safe.length > 0) return safe.slice().sort(byRankDesc)[0];
    }

    // Otherwise: never volunteer a danger card, and hold control cards back.
    const safeLeads = hand.filter((c) => !isDanger(c));
    const pool = safeLeads.length > 0 ? safeLeads : hand;
    const nonControl = pool.filter((c) => !isControlCard(c));
    const finalPool = nonControl.length > 0 ? nonControl : pool;
    return finalPool.slice().sort(byRankAsc)[0];
  }

  /* ---------------- FOLLOWING ---------------- */
  const followCards = hand.filter((c) => c.suit === leadSuit);
  const isVoid = followCards.length === 0;

  if (isVoid) {
    // No off-suit card can ever win — this is the safest possible moment
    // to unload whatever's most dangerous to be caught holding.
    if (wantsKingSpades) {
      const ks = hand.find((c) => c.rank === "K" && c.suit === "S");
      if (ks) return ks;
    }
    if (wantsQueens) {
      const queens = hand.filter((c) => c.rank === "Q");
      if (queens.length > 0) return queens[0];
    }
    if (wantsHearts) {
      const hearts = hand.filter((c) => c.suit === "H");
      if (hearts.length > 0) return hearts.slice().sort(byRankDesc)[0];
    }
    const nonControl = hand.filter((c) => !isControlCard(c));
    const pool = nonControl.length > 0 ? nonControl : hand;
    return pool.slice().sort(byRankDesc)[0];
  }

  // Must follow suit — decide whether to duck under or take the trick.
  const highestSoFar = room.currentTrick.reduce(
    (best, p) => (p.card.suit === leadSuit && rankValue(p.card.rank) > rankValue(best.rank) ? p.card : best),
    { rank: "2" }
  );
  const threshold = rankValue(highestSoFar.rank);
  const losers = followCards.filter((c) => rankValue(c.rank) < threshold);
  const winners = followCards.filter((c) => rankValue(c.rank) > threshold);

  let preferWin = wantsLastTrick && tricksLeft > 1;
  let winPool = winners;
  if (wantsLastTrick && tricksLeft === 2) {
    const setupWinners = winners.filter((c) => setsUpFinalWin(c));
    preferWin = setupWinners.length > 0;
    winPool = setupWinners;
  }

  if (losers.length > 0 && !preferWin) {
    // Burn the highest card that still safely loses.
    return losers.slice().sort(byRankDesc)[0];
  }
  if (preferWin && winPool.length > 0) {
    // Win as cheaply as possible among the winning options that are
    // actually worth taking, protecting control cards where we can.
    const nonControlWinners = winPool.filter((c) => !isControlCard(c));
    const pool = nonControlWinners.length > 0 ? nonControlWinners : winPool;
    return pool.slice().sort(byRankAsc)[0];
  }
  if (winners.length > 0) {
    // No losers available (forced to win) — take it as cheaply as possible.
    const nonControlWinners = winners.filter((c) => !isControlCard(c));
    const pool = nonControlWinners.length > 0 ? nonControlWinners : winners;
    return pool.slice().sort(byRankAsc)[0];
  }
  if (losers.length > 0) return losers.slice().sort(byRankDesc)[0];
  return followCards[0];
}

/* ============================== SMALL UI PIECES ============================== */
function PlayingCard({ card, size = "md", faceDown, dim, onClick, selected, won }) {
  const dims = {
    sm: { w: 40, h: 56, font: 13, corner: 10 },
    md: { w: 58, h: 82, font: 20, corner: 13 },
    lg: { w: 68, h: 96, font: 24, corner: 14 },
  }[size];
  const color = card && isRedSuit(card.suit) ? T.red : T.black;

  if (faceDown) {
    return (
      <div
        style={{
          width: dims.w,
          height: dims.h,
          borderRadius: 8,
          background: `repeating-linear-gradient(45deg, ${T.feltDark}, ${T.feltDark} 4px, ${T.brassDim} 4px, ${T.brassDim} 5px)`,
          border: `1.5px solid ${T.brassDim}`,
          boxShadow: "0 2px 4px rgba(0,0,0,0.4)",
        }}
      />
    );
  }

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        width: dims.w,
        height: dims.h,
        borderRadius: 8,
        background: T.cream,
        border: selected || won ? `2px solid ${T.brassLight}` : "1.5px solid #cfc6ac",
        boxShadow: won
          ? `0 0 0 3px ${T.brassLight}88, 0 0 16px 3px ${T.brassLight}99, 0 4px 8px rgba(0,0,0,0.45)`
          : selected
          ? `0 0 0 2px ${T.brassLight}55, 0 4px 8px rgba(0,0,0,0.45)`
          : "0 2px 5px rgba(0,0,0,0.35)",
        position: "relative",
        opacity: dim ? 0.4 : 1,
        cursor: onClick ? "pointer" : "default",
        transform: selected ? "translateY(-8px)" : "none",
        transition: "transform 120ms ease, opacity 120ms ease",
        padding: 0,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: 5,
          fontFamily: DISPLAY_FONT,
          fontSize: dims.corner,
          fontWeight: 700,
          color,
          lineHeight: 1,
          textAlign: "left",
        }}
      >
        <div>{RANK_LABEL[card.rank] || card.rank}</div>
        <div style={{ fontSize: dims.corner - 1 }}>{SUIT_SYMBOL[card.suit]}</div>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: dims.font,
          color,
        }}
      >
        {SUIT_SYMBOL[card.suit]}
      </div>
    </button>
  );
}

function KittyFlash({ event, nameOf }) {
  if (!event) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        padding: 20,
      }}
    >
      <div
        style={{
          background: "rgba(8,42,32,0.96)",
          border: `2px solid ${T.brassLight}`,
          borderRadius: 18,
          padding: "20px 22px",
          textAlign: "center",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          animation: "kittyPop 3.2s ease forwards",
          maxWidth: 360,
        }}
      >
        <div style={{ fontSize: 11, letterSpacing: 2, color: T.brassLight, marginBottom: 6 }}>KITTY AWARDED</div>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 16, color: T.cream, marginBottom: 14, fontWeight: 700 }}>
          {nameOf(event.winnerId)} takes the {event.cards.length}-card kitty
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {event.cards.map((c, i) => (
            <div key={i} style={{ animation: `kittyCardIn 380ms ease ${i * 90}ms both` }}>
              <PlayingCard card={c} size="md" />
            </div>
          ))}
        </div>
      </div>
      <style>{`
        @keyframes kittyPop {
          0% { opacity: 0; transform: scale(0.85); }
          8% { opacity: 1; transform: scale(1); }
          80% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(0.97); }
        }
        @keyframes kittyCardIn {
          0% { opacity: 0; transform: translateY(14px) rotate(-6deg); }
          100% { opacity: 1; transform: translateY(0) rotate(0deg); }
        }
      `}</style>
    </div>
  );
}

function RoundInfoOverlay({ round, onClose }) {
  const meta = ROUND_META[round];
  return (
    <div style={overlayWrap} onClick={onClose}>
      <div style={overlayCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 11, color: T.brassLight, letterSpacing: 2 }}>ROUND {round} / 6</div>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 22, color: T.cream, fontWeight: 700, marginBottom: 14 }}>
          {meta.label}
        </div>
        {round === 6 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 13, color: T.cream, opacity: 0.75 }}>Every rule from Rounds 1–5, all at once:</div>
            {[1, 2, 3, 4, 5].map((r) => (
              <div key={r} style={{ fontSize: 14, color: T.cream }}>
                <span style={{ color: T.brassLight, fontWeight: 700 }}>{ROUND_META[r].label} — </span>
                {ROUND_META[r].detail}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 15, color: T.cream, lineHeight: 1.5 }}>{meta.detail}</div>
        )}
        <button onClick={onClose} style={{ ...buttonPrimary, width: "100%", marginTop: 18 }}>
          Got it
        </button>
      </div>
    </div>
  );
}

const SHUFFLE_PHASE_MS = 720;
const DEAL_PHASE_MS = 900;

/* Owns its own lifecycle: phase switching, both sound effects, and calling
   onDone when finished. Keeping the sequencing here rather than in the
   parent effect means a re-render or a StrictMode double-mount can't strand
   the overlay on screen or silently swallow the deal sound. */
function ShuffleOverlay({ onDone, soundEnabled, playShuffle, playDeal }) {
  const [phase, setPhase] = useState("shuffle");
  const startedRef = useRef(false);

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      if (soundEnabled) playShuffle();
    }
    const toDeal = setTimeout(() => {
      setPhase("deal");
      if (soundEnabled) playDeal();
    }, SHUFFLE_PHASE_MS);
    const finish = setTimeout(() => {
      if (onDone) onDone();
    }, SHUFFLE_PHASE_MS + DEAL_PHASE_MS);
    return () => {
      clearTimeout(toDeal);
      clearTimeout(finish);
    };
  }, []);

  const cardBack = {
    width: 42,
    height: 60,
    borderRadius: 6,
    background: `repeating-linear-gradient(45deg, ${T.feltDark}, ${T.feltDark} 4px, ${T.brassDim} 4px, ${T.brassDim} 5px)`,
    border: `1.2px solid ${T.brassDim}`,
    boxShadow: "0 3px 8px rgba(0,0,0,0.5)",
    position: "absolute",
    inset: 0,
  };
  // Four upward-angled streams — a stylized deal rather than tracking every
  // actual player position, which stays reliable at any table size (3-10).
  const directions = [
    { dx: -150, dy: -230, rot: -22 },
    { dx: -55, dy: -270, rot: -8 },
    { dx: 55, dy: -270, rot: 8 },
    { dx: 150, dy: -230, rot: 22 },
  ];
  const [pieces] = useState(() =>
    directions.flatMap((dir, dIdx) =>
      Array.from({ length: 3 }).map((_, i) => ({
        id: `${dIdx}-${i}`,
        dx: dir.dx + (Math.random() * 14 - 7),
        dy: dir.dy + (Math.random() * 14 - 7),
        rot: dir.rot + (Math.random() * 10 - 5),
        delay: dIdx * 0.05 + i * 0.06,
      }))
    )
  );
  // Each riffle card fans a different distance and direction — stacking
  // them with identical motion just reads as one card wobbling.
  const riffleCards = [0, 1, 2, 3, 4, 5].map((i) => {
    const dir = i % 2 === 0 ? -1 : 1;
    return {
      id: i,
      sx: dir * (18 + i * 6),
      sr: dir * (7 + i * 3),
      delay: i * 0.035,
    };
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 72,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div style={{ position: "relative", width: 42, height: 60 }}>
        {phase === "shuffle" ? (
          <>
            <div style={cardBack} />
            {riffleCards.map((c) => (
              <div
                key={`s${c.id}`}
                style={{
                  ...cardBack,
                  "--sx": `${c.sx}px`,
                  "--sr": `${c.sr}deg`,
                  animation: `riffleCard 0.18s ease-in-out ${c.delay}s 4 alternate both`,
                }}
              />
            ))}
          </>
        ) : (
          <>
            <div style={{ ...cardBack, animation: "deckFade 0.45s ease-out 0.25s both" }} />
            {pieces.map((p) => (
              <div
                key={p.id}
                style={{
                  ...cardBack,
                  "--dx": `${p.dx}px`,
                  "--dy": `${p.dy}px`,
                  "--rot": `${p.rot}deg`,
                  animation: `dealCard 0.6s cubic-bezier(0.16,0.8,0.3,1) ${p.delay}s both`,
                }}
              />
            ))}
          </>
        )}
      </div>
      <div style={{ fontFamily: DISPLAY_FONT, fontSize: 12, color: T.brassLight, opacity: 0.8, marginTop: 18, letterSpacing: 1 }}>
        {phase === "shuffle" ? "Shuffling…" : "Dealing…"}
      </div>
      <style>{`
        @keyframes riffleCard {
          0% { transform: translateX(0) rotate(0deg); }
          100% { transform: translateX(var(--sx)) rotate(var(--sr)); }
        }
        @keyframes dealCard {
          0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
          12% { opacity: 1; }
          100% { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); opacity: 0; }
        }
        @keyframes deckFade {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function CapturedView({ room, myId, nameOf, onClose }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 65,
        display: "flex",
        alignItems: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.cream,
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
          borderRadius: "16px 16px 0 0",
          borderTop: `3px solid ${T.brass}`,
          padding: "18px 14px calc(24px + env(safe-area-inset-bottom))",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: 700, color: T.ink }}>Cards Captured</div>
          <button onClick={onClose} className="text-sm" style={{ color: T.ink, opacity: 0.6 }}>
            Close
          </button>
        </div>
        <div style={{ fontSize: 11, color: T.ink, opacity: 0.55, marginBottom: 16 }}>
          Every card won in a trick so far this round — resets when the next round deals.
        </div>
        {room.turnOrder.map((pid) => {
          const cards = (room.capturedCards?.[pid] || [])
            .slice()
            .sort((a, b) => {
              const si = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
              if (si !== 0) return si;
              return rankValue(a.rank) - rankValue(b.rank);
            });
          return (
            <div key={pid} style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontFamily: DISPLAY_FONT,
                  fontSize: 14,
                  fontWeight: 700,
                  color: T.ink,
                  marginBottom: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <ColorDot color={seatColor(room, pid)} />
                {nameOf(pid)}
                {pid === myId ? " (you)" : ""} — {cards.length} card{cards.length === 1 ? "" : "s"}
              </div>
              {cards.length === 0 ? (
                <div style={{ fontSize: 12, color: T.ink, opacity: 0.45 }}>No tricks captured yet.</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {cards.map((c, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 13,
                        fontFamily: DISPLAY_FONT,
                        fontWeight: 600,
                        padding: "3px 7px",
                        borderRadius: 6,
                        border: "1px solid #cfc6ac",
                        color: isRedSuit(c.suit) ? T.red : T.black,
                        background: "#fff",
                      }}
                    >
                      {RANK_LABEL[c.rank] || c.rank}
                      {SUIT_SYMBOL[c.suit]}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Ledger({ room, myId, onClose, onEditScore }) {
  const [editMode, setEditMode] = useState(false);
  const rounds = [1, 2, 3, 4, 5, 6];
  const totals = {};
  room.turnOrder.forEach((pid) => {
    totals[pid] = rounds.reduce((sum, r) => sum + ((room.scores[pid] || {})[r] || 0), 0);
  });
  const lowest = Math.min(...Object.values(totals));

  function handleCellTap(pid, r) {
    if (!editMode || !onEditScore) return;
    const playerName = room.players.find((p) => p.id === pid)?.name || pid;
    const current = (room.scores[pid] || {})[r] ?? 0;
    const input = window.prompt(`Correct ${playerName}'s Round ${r} score:`, String(current));
    if (input === null) return;
    const value = Number(input);
    if (Number.isNaN(value)) return;
    onEditScore(pid, r, Math.round(value));
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 65,
        display: "flex",
        alignItems: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.cream,
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
          borderRadius: "16px 16px 0 0",
          borderTop: `3px solid ${T.brass}`,
          padding: "18px 14px 28px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: 700, color: T.ink }}>Ledger</div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {onEditScore && (
              <button
                onClick={() => setEditMode((v) => !v)}
                style={{
                  fontSize: 12,
                  color: editMode ? "#A3312A" : T.ink,
                  opacity: editMode ? 1 : 0.6,
                  fontWeight: editMode ? 700 : 400,
                  background: "transparent",
                  border: "none",
                }}
              >
                {editMode ? "Done Editing" : "Edit Scores"}
              </button>
            )}
            <button onClick={onClose} className="text-sm" style={{ color: T.ink, opacity: 0.6 }}>
              Close
            </button>
          </div>
        </div>
        {editMode && (
          <div style={{ fontSize: 11, color: "#A3312A", opacity: 0.85, marginBottom: 10 }}>
            Tap any score below to correct it.
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: DISPLAY_FONT }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: `2px solid ${T.ink}`, fontSize: 12, color: T.ink, opacity: 0.7 }}>
                  Round
                </th>
                {room.turnOrder.map((pid) => {
                  const p = room.players.find((pl) => pl.id === pid);
                  return (
                    <th
                      key={pid}
                      style={{
                        textAlign: "right",
                        padding: "6px 8px",
                        borderBottom: `2px solid ${T.ink}`,
                        fontSize: 13,
                        color: T.ink,
                        fontWeight: pid === myId ? 700 : 500,
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <ColorDot color={seatColor(room, pid)} size={7} />
                        {p?.name || pid}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r}>
                  <td style={{ padding: "6px 8px", fontSize: 12, color: T.ink, opacity: 0.75, borderBottom: "1px solid #ddd3ba" }}>
                    {r}. {ROUND_META[r].label}
                  </td>
                  {room.turnOrder.map((pid) => (
                    <td
                      key={pid}
                      onClick={() => handleCellTap(pid, r)}
                      style={{
                        textAlign: "right",
                        padding: "6px 8px",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: 14,
                        color: editMode ? "#A3312A" : T.ink,
                        borderBottom: "1px solid #ddd3ba",
                        textDecoration: editMode ? "underline" : "none",
                        cursor: editMode ? "pointer" : "default",
                      }}
                    >
                      {(room.scores[pid] || {})[r] ?? "–"}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td style={{ padding: "8px 8px", fontSize: 13, fontWeight: 700, color: T.ink }}>Total</td>
                {room.turnOrder.map((pid) => (
                  <td
                    key={pid}
                    style={{
                      textAlign: "right",
                      padding: "8px 8px",
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 16,
                      fontWeight: 700,
                      color: totals[pid] === lowest ? "#2F6B4F" : T.ink,
                    }}
                  >
                    {totals[pid]}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: T.ink, opacity: 0.6 }}>
          Lowest total wins — winning tricks is how you pick up points.
        </div>
      </div>
    </div>
  );
}

/* ============================== MAIN APP ============================== */
export default function App() {
  const [screen, setScreen] = useState("entry"); // entry | lobby | game
  const [name, setName] = useState("");
  const [desiredPlayers, setDesiredPlayers] = useState(4);
  const [codeInput, setCodeInput] = useState("");
  const [code, setCode] = useState(null);
  const [myId, setMyId] = useState(null);
  const [room, setRoom] = useState(null);
  const [error, setError] = useState("");
  const [selectedCard, setSelectedCard] = useState(null);
  const [showLedger, setShowLedger] = useState(false);
  const [showCaptured, setShowCaptured] = useState(false);
  const [showRoundInfo, setShowRoundInfo] = useState(false);
  const [kittyFlash, setKittyFlash] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [confirmEndTable, setConfirmEndTable] = useState(false);
  const [autoRejoining, setAutoRejoining] = useState(true);
  const [turnFlash, setTurnFlash] = useState(false);
  const seenKittyId = useRef(null);
  const audioCtxRef = useRef(null);
  const prevTurnIdRef = useRef(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [chimeEnabled, setChimeEnabled] = useState(() => loadBoolPref(CHIME_PREF_KEY, true));
  const [flashEnabled, setFlashEnabled] = useState(() => loadBoolPref(FLASH_PREF_KEY, true));
  const [doubleTapEnabled, setDoubleTapEnabled] = useState(() => loadBoolPref(DOUBLE_TAP_PREF_KEY, false));
  const lastTapRef = useRef(null);
  const [shuffleAnim, setShuffleAnim] = useState(false);
  const prevStatusRef = useRef(undefined);
  const shuffleActiveRef = useRef(false);

  function toggleChime() {
    setChimeEnabled((prev) => {
      const next = !prev;
      saveBoolPref(CHIME_PREF_KEY, next);
      return next;
    });
  }
  function toggleFlash() {
    setFlashEnabled((prev) => {
      const next = !prev;
      saveBoolPref(FLASH_PREF_KEY, next);
      return next;
    });
  }
  function toggleDoubleTap() {
    setDoubleTapEnabled((prev) => {
      const next = !prev;
      saveBoolPref(DOUBLE_TAP_PREF_KEY, next);
      return next;
    });
  }

  // Web Audio needs to start from a real user tap (iOS policy) — call this
  // inside any button's onClick on the entry screen so it's ready later
  // when we need to play a chime with no direct user gesture attached.
  function primeAudio() {
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtxRef.current = new Ctx();
      }
      if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume();
      }
    } catch (e) {
      /* ignore — chime just won't play */
    }
  }
  function playChime() {
    try {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 830;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.42);
    } catch (e) {
      /* ignore */
    }
  }
  // A brighter two-note rising chime, distinct from the single-tone turn
  // alert, so the kitty reveal has its own recognizable sound.
  function playKittyChime() {
    try {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const now = ctx.currentTime;
      [660, 990].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        const start = now + i * 0.11;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.17, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(start);
        o.stop(start + 0.32);
      });
    } catch (e) {
      /* ignore */
    }
  }
  // A riffle-shuffle sound built from short filtered noise bursts — no
  // audio file needed, just generated white noise shaped into quick clicks.
  function playShuffleSound() {
    try {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const duration = 0.7;
      const bufferSize = Math.floor(ctx.sampleRate * duration);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      const burstCount = 9;
      for (let b = 0; b < burstCount; b++) {
        const start = Math.floor((b / burstCount) * bufferSize * 0.9);
        const len = Math.floor(ctx.sampleRate * 0.035);
        for (let i = 0; i < len && start + i < bufferSize; i++) {
          const envelope = 1 - i / len;
          data[start + i] = (Math.random() * 2 - 1) * envelope * 0.5;
        }
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 1200;
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start();
    } catch (e) {
      /* ignore */
    }
  }
  // The deal: a handful of separated "schik" swooshes rather than the
  // riffle's rapid clicks. Each burst is longer and uses a rise-and-fall
  // envelope (so it swooshes instead of clicking), bandpassed to give it
  // the papery character of a card sliding off the deck.
  function playDealSound() {
    try {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const duration = 0.95;
      const bufferSize = Math.floor(ctx.sampleRate * duration);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      const burstCount = 4;
      const gap = Math.floor(ctx.sampleRate * 0.19);
      const len = Math.floor(ctx.sampleRate * 0.1);
      for (let b = 0; b < burstCount; b++) {
        const start = b * gap;
        for (let i = 0; i < len && start + i < bufferSize; i++) {
          const t = i / len;
          // Fast attack, slower tail — a "schhk" swoosh shape.
          const envelope = Math.sin(Math.PI * Math.pow(t, 0.55));
          data[start + i] = (Math.random() * 2 - 1) * envelope * 0.55;
        }
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 2300;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.value = 0.42;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start();
    } catch (e) {
      /* ignore */
    }
  }

  // On load, try to silently rejoin whatever table this device was last
  // at — covers a dropped connection, a closed tab, or a phone restart,
  // without the player having to retype their name and the room code.
  useEffect(() => {
    (async () => {
      const session = loadSession();
      if (!session) {
        const params = new URLSearchParams(window.location.search);
        const joinParam = params.get("join");
        if (joinParam) setCodeInput(joinParam.trim().toUpperCase());
        setAutoRejoining(false);
        return;
      }
      setName(session.name);
      const r = await loadRoom(session.code);
      const pid = sanitizeId(session.name);
      if (r && r.players.some((p) => p.id === pid)) {
        setCode(session.code);
        setMyId(pid);
        setRoom(r);
        seenKittyId.current = r.kittyReveal ? r.kittyReveal.id : null;
        setScreen(r.status === "lobby" ? "lobby" : "game");
      } else {
        clearSession();
      }
      setAutoRejoining(false);
    })();
  }, []);

  // Realtime subscription — replaces polling entirely. Firebase pushes
  // updates the moment another player's device writes a change.
  useEffect(() => {
    if (screen === "entry" || !code) return;
    let sawRoom = false;
    const unsubscribe = onValue(roomRef(code), (snap) => {
      if (snap.exists()) {
        sawRoom = true;
        setRoom(hydrateRoom(snap.val()));
      } else if (sawRoom) {
        // The room existed and is now gone — someone ended the table.
        clearSession();
        setRoom(null);
        setCode(null);
        setScreen("entry");
        setError("This table has ended.");
      }
    });
    return () => unsubscribe();
  }, [screen, code]);

  useEffect(() => {
    if (room && room.status === "playing") setSelectedCard(null);
  }, [room?.currentTurnId, room?.status]);

  useEffect(() => {
    if (room && room.status !== "lobby" && screen === "lobby") setScreen("game");
  }, [room, screen]);

  useEffect(() => {
    const reveal = room?.kittyReveal;
    if (!reveal) return;
    if (reveal.id !== seenKittyId.current) {
      seenKittyId.current = reveal.id;
      setKittyFlash(reveal);
      if (chimeEnabled) playKittyChime();
      const t = setTimeout(() => setKittyFlash(null), 3200);
      return () => clearTimeout(t);
    }
  }, [room?.kittyReveal?.id, chimeEnabled]);

  // Trick-winner pause: once a trick is marked complete (awaitingTrickClear),
  // wait briefly so everyone can see the winning card highlighted, then
  // advance the game. Any client can perform this — the computation is
  // deterministic from the frozen room state, so a duplicate write from
  // two clients racing is harmless (same result, last write wins).
  useEffect(() => {
    if (!room || !room.awaitingTrickClear || !code) return;
    const t = setTimeout(async () => {
      let r = JSON.parse(JSON.stringify(room));
      r = resolveTrickAfterPause(r);
      await saveRoom(code, r);
      setRoom(r);
    }, 1400);
    return () => clearTimeout(t);
  }, [room?.awaitingTrickClear, code]);

  // Bot auto-play: when it's a bot's turn, any connected client computes
  // its move and submits it after a short pacing delay (so it doesn't feel
  // instant/robotic). Multiple clients may all detect the same bot turn and
  // schedule this independently — that's fine. chooseBotCard is a pure
  // function of the frozen room state, so they'd all compute the identical
  // card; and as soon as the first write lands, every other client's copy
  // of room.currentTurnId changes, which cancels their pending timers via
  // the effect cleanup before a duplicate write can happen in practice.
  useEffect(() => {
    if (!room || room.status !== "playing" || room.awaitingTrickClear || !code) return;
    const currentPlayer = room.players.find((p) => p.id === room.currentTurnId);
    if (!currentPlayer || !currentPlayer.isBot) return;
    const t = setTimeout(async () => {
      let r = JSON.parse(JSON.stringify(room));
      const card = chooseBotCard(r, room.currentTurnId);
      if (!card) return;
      r = playCard(r, room.currentTurnId, card);
      await saveRoom(code, r);
      setRoom(r);
    }, 850);
    return () => clearTimeout(t);
  }, [room?.currentTurnId, room?.status, room?.awaitingTrickClear, code]);

  // Shuffle animation: plays a brief cosmetic overlay whenever a round
  // actually starts dealing (status transitions into "playing"). The ref
  // starts undefined so the very first time this device observes the room
  // — including reconnecting mid-round — just records a baseline instead
  // of animating; only a real transition afterward triggers the flourish.
  useEffect(() => {
    if (!room) return;
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = room.status;
    if (prevStatus === undefined) return;
    if (prevStatus !== "playing" && room.status === "playing") {
      // The overlay handles its own phases, sounds, and teardown — this
      // just switches it on. The ref is set synchronously so the turn-alert
      // effect below (running in this same commit, where the shuffleAnim
      // state is still false) knows to hold its chime until the deal lands.
      shuffleActiveRef.current = true;
      setShuffleAnim(true);
    }
  }, [room?.status]);

  // Turn alert: a brief flash + chime the moment a new turn actually starts
  // (not every render while it's still the same person's turn). Fires when
  // room.currentTurnId changes to a value we should alert on. Real vibration
  // isn't available — iOS Safari has never supported navigator.vibrate(),
  // even as an installed home-screen app — so this is the reliable stand-in.
  useEffect(() => {
    if (!room || room.status !== "playing") {
      prevTurnIdRef.current = null;
      return;
    }
    // Hold the alert while the shuffle/deal intro is playing. Returning
    // before prevTurnIdRef updates means this same turn still registers as
    // "new" once shuffleAnim flips false and re-runs this effect, so the
    // chime lands together with the hand appearing.
    if (shuffleActiveRef.current) return;

    const turnChanged = room.currentTurnId !== prevTurnIdRef.current;
    prevTurnIdRef.current = room.currentTurnId;
    if (!turnChanged) return;

    const shouldAlert = room.currentTurnId === myId;
    if (!shouldAlert) return;

    if (chimeEnabled) playChime();
    if (flashEnabled) {
      setTurnFlash(true);
      const t = setTimeout(() => setTurnFlash(false), 900);
      return () => clearTimeout(t);
    }
  }, [room?.currentTurnId, room?.status, myId, chimeEnabled, flashEnabled, shuffleAnim]);

  async function createRoom() {
    primeAudio();
    if (!name.trim()) return setError("Enter your name first.");
    const newCode = makeCode();
    const pid = sanitizeId(name);
    if (!pid) return setError("Enter a valid name.");
    const newRoom = {
      code: newCode,
      maxPlayers: desiredPlayers,
      createdAt: Date.now(),
      players: [{ id: pid, name: pid }],
      turnOrder: [pid],
      status: "lobby",
      round: 0,
      scores: { [pid]: {} },
      log: [`${pid} created a table for ${desiredPlayers}.`],
    };
    await saveRoom(newCode, newRoom);
    setCode(newCode);
    setMyId(pid);
    setRoom(newRoom);
    seenKittyId.current = null;
    saveSession(newCode, name.trim());
    setScreen("lobby");
    setError("");
  }

  async function addBot() {
    if (!room || room.players.length >= room.maxPlayers) return;
    let r = JSON.parse(JSON.stringify(room));
    const botNum = (r.botCounter || 0) + 1;
    r.botCounter = botNum;
    const botId = `bot_${botNum}_${Math.random().toString(36).slice(2, 6)}`;
    const botName = `Bot ${botNum}`;
    r.players.push({ id: botId, name: botName, isBot: true });
    r.turnOrder.push(botId);
    r.scores[botId] = {};
    pushLog(r, `${botName} added to the table.`);
    await saveRoom(code, r);
    setRoom(r);
  }

  async function removeBot(pid) {
    if (!room) return;
    let r = JSON.parse(JSON.stringify(room));
    const bot = r.players.find((p) => p.id === pid);
    r.players = r.players.filter((p) => p.id !== pid);
    r.turnOrder = r.turnOrder.filter((id) => id !== pid);
    delete r.scores[pid];
    if (bot) pushLog(r, `${bot.name} removed from the table.`);
    await saveRoom(code, r);
    setRoom(r);
  }

  async function joinRoom() {
    primeAudio();
    if (!name.trim()) return setError("Enter your name first.");
    const c = codeInput.trim().toUpperCase();
    if (!c) return setError("Enter a room code.");
    const r = await loadRoom(c);
    if (!r) return setError("No table found with that code.");
    const pid = sanitizeId(name);
    if (!pid) return setError("Enter a valid name.");
    if (!r.players.some((p) => p.id === pid)) {
      if (r.players.length >= r.maxPlayers) return setError(`Table is full (${r.maxPlayers} players).`);
      if (r.status !== "lobby") return setError("That round is already underway.");
      r.players.push({ id: pid, name: pid });
      r.turnOrder.push(pid);
      r.scores[pid] = {};
      pushLog(r, `${pid} joined the table.`);
      await saveRoom(c, r);
    }
    setCode(c);
    setMyId(pid);
    setRoom(r);
    // Joining mid-round: treat whatever kitty state already exists as the
    // baseline so we don't flash an award that happened before we connected.
    seenKittyId.current = r.kittyReveal ? r.kittyReveal.id : null;
    saveSession(c, name.trim());
    setScreen(r.status === "lobby" ? "lobby" : "game");
    setError("");
  }

  async function startGame() {
    if (!room || room.players.length !== room.maxPlayers) return;
    let r = { ...room, scores: { ...room.scores } };
    r = startRound(r, 1);
    await saveRoom(code, r);
    setRoom(r);
    setScreen("game");
  }

  async function handlePlay(card) {
    if (!room) return;
    if (room.currentTurnId !== myId) return;
    let r = JSON.parse(JSON.stringify(room));
    r = playCard(r, myId, card);
    await saveRoom(code, r);
    setRoom(r);
    setSelectedCard(null);
  }

  // Handles a tap on a card in hand.
  // Normal mode: tap selects/deselects, a separate Play button confirms.
  // Double-Tap to Play mode: a single tap does nothing visible — only a
  // fast second tap on the same card (within 350ms) selects and plays it
  // in one motion. This fully replaces the select step in that mode.
  function handleCardTap(c) {
    const id = cardId(c);
    if (doubleTapEnabled) {
      const last = lastTapRef.current;
      const now = Date.now();
      if (last && last.id === id && now - last.time < 350) {
        lastTapRef.current = null;
        handlePlay(c);
      } else {
        lastTapRef.current = { id, time: now };
      }
      return;
    }
    setSelectedCard((prev) => (prev && prev.rank === c.rank && prev.suit === c.suit ? null : c));
  }

  async function continueToNextRound() {
    if (!room) return;
    let r = JSON.parse(JSON.stringify(room));
    r = startRound(r, room.round + 1);
    await saveRoom(code, r);
    setRoom(r);
  }

  // Manual score correction — for when the automated scoring gets
  // something wrong and needs a human fix. Logged for transparency so
  // everyone can see a correction happened.
  async function editScore(pid, round, newValue) {
    if (!room) return;
    let r = JSON.parse(JSON.stringify(room));
    r.scores[pid] = r.scores[pid] || {};
    const editorName = r.players.find((p) => p.id === myId)?.name || myId;
    const targetName = r.players.find((p) => p.id === pid)?.name || pid;
    pushLog(r, `${editorName} corrected ${targetName}'s Round ${round} score to ${newValue}.`);
    r.scores[pid][round] = newValue;
    await saveRoom(code, r);
    setRoom(r);
  }

  // Returns just this device to the main menu. The table itself keeps
  // existing in Firebase — other players are unaffected.
  function leaveToMenu() {
    clearSession();
    setShowMenu(false);
    setScreen("entry");
    setCode(null);
    setMyId(null);
    setRoom(null);
    setSelectedCard(null);
    setError("");
  }

  // Deletes the table entirely. Every connected device (including this
  // one, via the realtime listener) gets bounced back to the main menu.
  async function endTable() {
    if (!code) return;
    await deleteRoom(code);
    clearSession();
    setConfirmEndTable(false);
    setShowMenu(false);
  }

  async function shareInvite() {
    if (!code) return;
    const url = `${window.location.origin}${window.location.pathname}?join=${code}`;
    const text = `Join my Texas Chili table! Room code: ${code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Texas Chili", text, url });
      } catch (e) {
        /* user cancelled the share sheet — not an error */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (e) {
      /* clipboard unavailable — nothing more we can do here */
    }
  }

  async function copyRoomCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch (e) {
      /* clipboard unavailable — nothing more we can do here */
    }
  }

  if (autoRejoining) {
    return (
      <div style={outerWrap}>
        <div style={{ color: T.cream, opacity: 0.7 }}>Reconnecting…</div>
      </div>
    );
  }

  /* ---------------- ENTRY SCREEN ---------------- */
  if (screen === "entry") {
    return (
      <div style={outerWrap}>
        <div style={{ width: "100%", maxWidth: "min(460px, 92vw)" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 15, letterSpacing: 3, color: T.brassLight, textTransform: "uppercase" }}>
              A Trick-Taking Table
            </div>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 36, fontWeight: 700, color: T.cream, marginTop: 4 }}>
              Texas Chili
            </div>
            <div style={{ fontSize: 13, color: T.cream, opacity: 0.65, marginTop: 6 }}>
              A six-round trick-taking game for 3–10. Lowest score wins.
            </div>
          </div>

          <div style={panelStyle}>
            <label style={labelStyle}>Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sean"
              style={inputStyle}
              maxLength={16}
            />

            <label style={{ ...labelStyle, marginTop: 16 }}>Table size</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => setDesiredPlayers(n)}
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 8,
                    border: `1px solid ${n === desiredPlayers ? T.brassLight : T.brassDim}`,
                    background: n === desiredPlayers ? T.brass : "transparent",
                    color: n === desiredPlayers ? T.feltDark : T.cream,
                    fontWeight: 700,
                    fontFamily: DISPLAY_FONT,
                    fontSize: 14,
                  }}
                >
                  {n}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={createRoom} style={{ ...buttonPrimary, flex: 1 }}>
                New Table
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0" }}>
              <div style={{ flex: 1, height: 1, background: "#3a5a4c" }} />
              <span style={{ fontSize: 11, color: T.cream, opacity: 0.5 }}>OR JOIN</span>
              <div style={{ flex: 1, height: 1, background: "#3a5a4c" }} />
            </div>

            <label style={labelStyle}>Room code</label>
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="e.g. QKTS"
              style={{ ...inputStyle, letterSpacing: 3, textTransform: "uppercase" }}
              maxLength={4}
            />
            <button onClick={joinRoom} style={{ ...buttonSecondary, width: "100%", marginTop: 12 }}>
              Join Table
            </button>

            {error && <div style={{ color: "#E8998C", fontSize: 13, marginTop: 12, textAlign: "center" }}>{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div style={outerWrap}>
        <div style={{ color: T.cream, opacity: 0.7 }}>Loading table…</div>
      </div>
    );
  }

  /* ---------------- LOBBY SCREEN ---------------- */
  if (screen === "lobby" || room.status === "lobby") {
    return (
      <div style={outerWrap}>
        <div style={{ width: "100%", maxWidth: "min(460px, 92vw)" }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: T.cream, opacity: 0.6, letterSpacing: 2 }}>ROOM CODE</div>
            <button
              onClick={copyRoomCode}
              style={{
                background: "transparent",
                border: "none",
                fontFamily: DISPLAY_FONT,
                fontSize: 44,
                fontWeight: 700,
                color: T.brassLight,
                letterSpacing: 6,
                padding: 0,
              }}
            >
              {code}
            </button>
            <div style={{ fontSize: 12, color: T.cream, opacity: 0.55, marginTop: 4 }}>
              {codeCopied ? "Copied!" : "Tap the code to copy, or share the link"}
            </div>
            <button
              onClick={shareInvite}
              style={{
                marginTop: 12,
                background: "transparent",
                border: `1px solid ${T.brassDim}`,
                color: T.brassLight,
                fontSize: 13,
                padding: "9px 18px",
                borderRadius: 10,
                fontFamily: DISPLAY_FONT,
              }}
            >
              {shareCopied ? "Copied!" : "Share Invite"}
            </button>
          </div>

          <div style={panelStyle}>
            <div style={{ fontSize: 12, color: T.cream, opacity: 0.6, marginBottom: 10, letterSpacing: 1 }}>
              PLAYERS ({room.players.length}/{room.maxPlayers})
            </div>
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {Array.from({ length: room.maxPlayers }).map((_, i) => {
                const p = room.players[i];
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "10px 4px",
                      borderBottom: i < room.maxPlayers - 1 ? "1px solid #234838" : "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 99,
                          background: p ? seatColor(room, p.id) : "#3a5a4c",
                          flexShrink: 0,
                        }}
                      />
                      <div
                        style={{
                          color: p ? T.cream : "#5f7f70",
                          fontSize: 15,
                          fontFamily: DISPLAY_FONT,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {p ? p.name : "Empty seat"}
                        {p && p.id === myId ? " (you)" : ""}
                        {p && p.isBot ? " 🤖" : ""}
                      </div>
                    </div>
                    {!p && (
                      <button
                        onClick={addBot}
                        style={{
                          fontSize: 12,
                          color: T.brassLight,
                          background: "transparent",
                          border: `1px solid ${T.brassDim}`,
                          borderRadius: 8,
                          padding: "5px 10px",
                          fontFamily: DISPLAY_FONT,
                          flexShrink: 0,
                        }}
                      >
                        Add Bot
                      </button>
                    )}
                    {p && p.isBot && (
                      <button
                        onClick={() => removeBot(p.id)}
                        style={{
                          fontSize: 12,
                          color: "#A3312A",
                          background: "transparent",
                          border: "none",
                          flexShrink: 0,
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {room.players.length === room.maxPlayers ? (
              <button onClick={startGame} style={{ ...buttonPrimary, width: "100%", marginTop: 18 }}>
                Deal Round 1
              </button>
            ) : (
              <div style={{ textAlign: "center", fontSize: 12, color: T.cream, opacity: 0.5, marginTop: 18 }}>
                Waiting for {room.maxPlayers - room.players.length} more player
                {room.maxPlayers - room.players.length === 1 ? "" : "s"}…
              </div>
            )}
          </div>

          <button
            onClick={leaveToMenu}
            style={{
              width: "100%",
              marginTop: 14,
              background: "transparent",
              border: "none",
              color: T.cream,
              opacity: 0.5,
              fontSize: 12,
              textDecoration: "underline",
              fontFamily: DISPLAY_FONT,
            }}
          >
            Leave this table
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- GAME SCREEN ---------------- */
  const allPlayers = room.turnOrder;
  const activeSeat = myId;
  const myHand = room.hands?.[activeSeat] || [];
  const isMyTurn = !room.awaitingTrickClear && room.currentTurnId === myId;
  const isForcedOpen = room.trickNumber === 1 && room.currentTrick.length === 0;
  const forcedCardForHand = isForcedOpen ? room.forcedOpenCard : null;
  const nameOf = (pid) => room.players.find((p) => p.id === pid)?.name || pid;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `radial-gradient(ellipse at 50% 30%, ${T.felt}, ${T.feltDark})`,
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, sans-serif",
        boxShadow: turnFlash ? `inset 0 0 0 4px ${T.brassLight}` : "inset 0 0 0 0px transparent",
        transition: "box-shadow 350ms ease",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px 6px",
          paddingTop: "max(14px, env(safe-area-inset-top))",
        }}
      >
        <button
          onClick={() => setShowMenu(true)}
          aria-label="Menu"
          style={{
            background: "transparent",
            border: `1px solid ${T.brassDim}`,
            color: T.brassLight,
            fontSize: 16,
            width: 34,
            height: 34,
            borderRadius: 8,
            flexShrink: 0,
          }}
        >
          ☰
        </button>
        <button
          onClick={() => setShowRoundInfo(true)}
          style={{ flex: 1, textAlign: "center", background: "transparent", border: "none", padding: 0 }}
        >
          <div style={{ fontSize: 10, color: T.brassLight, letterSpacing: 2, opacity: 0.8 }}>
            ROUND {room.round} / 6
          </div>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 17, color: T.cream, fontWeight: 700, textDecoration: "underline", textDecorationColor: "rgba(247,243,232,0.3)" }}>
            {ROUND_META[room.round]?.label}
          </div>
        </button>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => setShowCaptured(true)}
            style={{
              background: "transparent",
              border: `1px solid ${T.brassDim}`,
              color: T.brassLight,
              fontSize: 12,
              padding: "7px 10px",
              borderRadius: 8,
              fontFamily: DISPLAY_FONT,
            }}
          >
            Captured
          </button>
          <button
            onClick={() => setShowLedger(true)}
            style={{
              background: "transparent",
              border: `1px solid ${T.brassDim}`,
              color: T.brassLight,
              fontSize: 12,
              padding: "7px 12px",
              borderRadius: 8,
              fontFamily: DISPLAY_FONT,
            }}
          >
            Ledger
          </button>
        </div>
      </div>

      {/* Player row — every seat at the table, wraps to fit 3–10 players */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(78px, 1fr))",
          padding: "6px 10px 2px",
          gap: 6,
        }}
      >
        {allPlayers.map((pid) => {
          const handCount = room.hands?.[pid]?.length ?? 0;
          const active = room.currentTurnId === pid;
          const isSelf = pid === myId;
          return (
            <div
              key={pid}
              style={{
                textAlign: "center",
                padding: "8px 6px",
                borderRadius: 10,
                background: active ? "rgba(230,199,102,0.14)" : "transparent",
                border: active ? `1px solid ${T.brassDim}` : "1px solid transparent",
              }}
            >
              <div
                style={{
                  fontFamily: DISPLAY_FONT,
                  fontSize: 13,
                  color: active ? T.brassLight : T.cream,
                  fontWeight: active ? 700 : 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 5,
                }}
              >
                <ColorDot color={seatColor(room, pid)} />
                {nameOf(pid)}
                {isSelf ? " (you)" : ""}
              </div>
              <div style={{ fontSize: 10, color: T.cream, opacity: 0.55, marginTop: 1 }}>
                {handCount} cards · {room.tricksWon?.[pid] ?? 0} tricks
              </div>
            </div>
          );
        })}
      </div>

      {/* Table / trick area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "10px 16px",
          opacity: shuffleAnim ? 0 : 1,
          transition: "opacity 340ms ease",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "min(520px, 88vw)",
            minHeight: 150,
            borderRadius: 20,
            border: `2px solid ${T.feltLine}`,
            background: "rgba(0,0,0,0.15)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            padding: 16,
          }}
        >
          {room.currentTrick.length === 0 ? (
            <div style={{ fontSize: 12, color: T.cream, opacity: 0.4, fontFamily: DISPLAY_FONT }}>
              {isForcedOpen && room.forcedOpenCard
                ? `${nameOf(room.currentTurnId)} must lead the ${RANK_LABEL[room.forcedOpenCard.rank] || room.forcedOpenCard.rank}${SUIT_SYMBOL[room.forcedOpenCard.suit]}`
                : `${nameOf(room.currentTurnId)} is leading the trick`}
            </div>
          ) : (
            room.currentTrick.map((play) => {
              const isWinner = room.awaitingTrickClear && play.playerId === room.trickWinnerId;
              return (
                <div key={play.playerId} style={{ textAlign: "center" }}>
                  <PlayingCard card={play.card} size="md" won={isWinner} />
                  <div
                    style={{
                      fontSize: 10,
                      color: isWinner ? T.brassLight : T.cream,
                      opacity: isWinner ? 1 : 0.6,
                      fontWeight: isWinner ? 700 : 400,
                      marginTop: 4,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                    }}
                  >
                    <ColorDot color={seatColor(room, play.playerId)} size={6} />
                    {nameOf(play.playerId)}
                    {isWinner ? " won!" : ""}
                  </div>
                </div>
              );
            })
          )}
        </div>
        {room.leadSuit && (
          <div
            style={{
              textAlign: "center",
              fontSize: 10,
              color: T.cream,
              opacity: 0.5,
              letterSpacing: 1,
              marginTop: 10,
            }}
          >
            LEADING SUIT: {SUIT_SYMBOL[room.leadSuit]} {SUIT_NAME[room.leadSuit]}
          </div>
        )}
      </div>

      {/* Activity log */}
      <div style={{ padding: "0 16px 8px", fontSize: 11, color: T.cream, opacity: 0.5, minHeight: 16 }}>
        {room.log?.[0]}
      </div>

      {/* My hand */}
      <div
        style={{
          background: T.panel,
          borderTop: `2px solid ${T.feltLine}`,
          padding: "12px 10px 18px",
          paddingBottom: "max(18px, env(safe-area-inset-bottom))",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "0 6px 4px",
            opacity: shuffleAnim ? 0 : 1,
            transition: "opacity 300ms ease",
          }}
        >
          <div>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 13, color: isMyTurn ? T.brassLight : T.cream, fontWeight: 700 }}>
              {room.awaitingTrickClear
                ? "Trick complete…"
                : isMyTurn
                ? "Your turn"
                : `Waiting on ${nameOf(room.currentTurnId)}`}
            </div>
            <div style={{ fontSize: 10, color: T.cream, opacity: 0.5, marginTop: 1 }}>
              Your tricks: {room.tricksWon?.[myId] ?? 0}
            </div>
          </div>
          {selectedCard && (
            <button
              onClick={() => handlePlay(selectedCard)}
              style={{ ...buttonPrimary, padding: "6px 16px", fontSize: 13 }}
            >
              Play {RANK_LABEL[selectedCard.rank] || selectedCard.rank}
              {SUIT_SYMBOL[selectedCard.suit]}
            </button>
          )}
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            paddingBottom: 4,
            opacity: shuffleAnim ? 0 : 1,
            transform: shuffleAnim ? "translateY(12px)" : "translateY(0)",
            transition: "opacity 340ms ease, transform 340ms ease",
          }}
        >
          {myHand.map((c, i) => {
            const legal = isMyTurn && canPlayCard(myHand, c, room.leadSuit, forcedCardForHand);
            const isSelected = selectedCard && selectedCard.rank === c.rank && selectedCard.suit === c.suit;
            const newSuitGroup = i > 0 && myHand[i - 1].suit !== c.suit;
            return (
              <div key={cardId(c)} style={{ marginLeft: newSuitGroup ? 10 : 0 }}>
                <PlayingCard
                  card={c}
                  size="md"
                  dim={isMyTurn && !legal}
                  selected={isSelected}
                  onClick={
                    legal
                      ? () => handleCardTap(c)
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      </div>

      {showLedger && (
        <Ledger room={room} myId={myId} onClose={() => setShowLedger(false)} onEditScore={editScore} />
      )}

      {showCaptured && (
        <CapturedView room={room} myId={myId} nameOf={nameOf} onClose={() => setShowCaptured(false)} />
      )}

      {kittyFlash && <KittyFlash event={kittyFlash} nameOf={nameOf} />}

      {shuffleAnim && (
        <ShuffleOverlay
          soundEnabled={chimeEnabled}
          playShuffle={playShuffleSound}
          playDeal={playDealSound}
          onDone={() => {
            shuffleActiveRef.current = false;
            setShuffleAnim(false);
          }}
        />
      )}

      {showRoundInfo && <RoundInfoOverlay round={room.round} onClose={() => setShowRoundInfo(false)} />}

      {showMenu && (
        <GameMenu
          code={code}
          codeCopied={codeCopied}
          onCopyCode={copyRoomCode}
          chimeEnabled={chimeEnabled}
          flashEnabled={flashEnabled}
          doubleTapEnabled={doubleTapEnabled}
          onToggleChime={toggleChime}
          onToggleFlash={toggleFlash}
          onToggleDoubleTap={toggleDoubleTap}
          onLeave={leaveToMenu}
          onRequestEndTable={() => {
            setShowMenu(false);
            setConfirmEndTable(true);
          }}
          onClose={() => setShowMenu(false)}
        />
      )}

      {confirmEndTable && (
        <ConfirmDialog
          title="End this table?"
          body="This deletes the table for everyone at it, right now. This can't be undone."
          confirmLabel="End Table"
          onConfirm={endTable}
          onCancel={() => setConfirmEndTable(false)}
        />
      )}

      {room.status === "round-end" && (
        <RoundEndOverlay
          room={room}
          nameOf={nameOf}
          onContinue={continueToNextRound}
          onOpenCaptured={() => setShowCaptured(true)}
        />
      )}
      {room.status === "game-end" && (
        <GameEndOverlay
          room={room}
          nameOf={nameOf}
          onLeave={leaveToMenu}
          onOpenLedger={() => setShowLedger(true)}
          onOpenCaptured={() => setShowCaptured(true)}
        />
      )}
    </div>
  );
}

function GameMenu({
  code,
  codeCopied,
  onCopyCode,
  chimeEnabled,
  flashEnabled,
  doubleTapEnabled,
  onToggleChime,
  onToggleFlash,
  onToggleDoubleTap,
  onLeave,
  onRequestEndTable,
  onClose,
}) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 55, display: "flex", alignItems: "flex-end" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.cream,
          width: "100%",
          borderRadius: "16px 16px 0 0",
          borderTop: `3px solid ${T.brass}`,
          padding: "18px 14px calc(24px + env(safe-area-inset-bottom))",
        }}
      >
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, fontWeight: 700, color: T.ink, marginBottom: 4 }}>Menu</div>
        <div style={{ fontSize: 11, color: T.ink, opacity: 0.55, letterSpacing: 1, marginBottom: 2 }}>ROOM CODE — TAP TO COPY</div>
        <button
          onClick={onCopyCode}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            fontFamily: DISPLAY_FONT,
            fontSize: 28,
            fontWeight: 700,
            color: T.brassDim,
            letterSpacing: 4,
            marginBottom: 12,
          }}
        >
          {codeCopied ? "Copied!" : code}
        </button>

        <div style={{ borderTop: "1px solid #e3dbc4", borderBottom: "1px solid #e3dbc4", marginBottom: 16 }}>
          <Toggle checked={chimeEnabled} onChange={onToggleChime} label="Turn Chime" />
          <div style={{ borderTop: "1px solid #ece5d2" }} />
          <Toggle checked={flashEnabled} onChange={onToggleFlash} label="Turn Flash" />
          <div style={{ borderTop: "1px solid #ece5d2" }} />
          <Toggle checked={doubleTapEnabled} onChange={onToggleDoubleTap} label="Double-Tap to Play" />
          {doubleTapEnabled && (
            <div style={{ fontSize: 11, color: T.ink, opacity: 0.55, padding: "0 2px 10px" }}>
              A single tap won't select a card — double-tap it to play instantly.
            </div>
          )}
        </div>

        <button
          onClick={onLeave}
          style={{ ...buttonSecondary, width: "100%", color: T.ink, border: "1px solid #cfc6ac", marginBottom: 10 }}
        >
          Return to Main Menu
        </button>
        <div style={{ fontSize: 11, color: T.ink, opacity: 0.5, marginBottom: 14, textAlign: "center" }}>
          This only leaves for you — the table keeps going for everyone else.
        </div>
        <button
          onClick={onRequestEndTable}
          style={{ ...buttonSecondary, width: "100%", color: "#A3312A", border: "1px solid #A3312A" }}
        >
          End Table for Everyone
        </button>
        <button
          onClick={onClose}
          style={{ width: "100%", marginTop: 10, background: "transparent", border: "none", color: T.ink, opacity: 0.5, fontSize: 13, padding: 8 }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }) {
  return (
    <div style={{ ...overlayWrap, zIndex: 80 }}>
      <div style={overlayCard}>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 18, fontWeight: 700, color: T.cream, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: T.cream, opacity: 0.75, marginBottom: 18 }}>{body}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} style={{ ...buttonSecondary, flex: 1 }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ ...buttonPrimary, flex: 1, background: "#A3312A", color: T.cream }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoundEndOverlay({ room, nameOf, onContinue, onOpenCaptured }) {
  const info = room.roundEndInfo;
  if (!info) return null;
  const entries = room.turnOrder.map((pid) => ({ pid, pts: info.breakdown[pid] || 0 }));
  return (
    <div style={overlayWrap}>
      <div style={overlayCard}>
        <div style={{ fontSize: 11, color: T.brassLight, letterSpacing: 2 }}>ROUND {info.round} COMPLETE</div>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 22, color: T.cream, fontWeight: 700, marginBottom: info.earlyReason ? 4 : 14 }}>
          {ROUND_META[info.round].label}
        </div>
        {info.earlyReason && (
          <div style={{ fontSize: 12, color: T.brassLight, opacity: 0.85, marginBottom: 14 }}>{info.earlyReason}</div>
        )}
        {entries.map((e) => (
          <div key={e.pid} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #234838" }}>
            <span style={{ color: T.cream, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
              <ColorDot color={seatColor(room, e.pid)} />
              {nameOf(e.pid)}
            </span>
            <span style={{ color: T.brassLight, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>+{e.pts}</span>
          </div>
        ))}
        {onOpenCaptured && (
          <button onClick={onOpenCaptured} style={{ ...buttonSecondary, width: "100%", marginTop: 16 }}>
            View Captured Cards
          </button>
        )}
        <button onClick={onContinue} style={{ ...buttonPrimary, width: "100%", marginTop: 10 }}>
          {info.round >= 6 ? "See Final Results" : `Deal Round ${info.round + 1}`}
        </button>
      </div>
    </div>
  );
}

function Confetti() {
  const [pieces] = useState(() =>
    Array.from({ length: 36 }).map((_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 2.2 + Math.random() * 1.3,
      color: SEAT_COLORS[i % SEAT_COLORS.length],
      rotate: Math.random() * 360,
      w: 6 + Math.random() * 6,
    }))
  );
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, pointerEvents: "none", overflow: "hidden" }}>
      {pieces.map((p) => (
        <div
          key={p.id}
          style={{
            position: "absolute",
            top: "-6%",
            left: `${p.left}%`,
            width: p.w,
            height: p.w * 0.6,
            background: p.color,
            borderRadius: 2,
            transform: `rotate(${p.rotate}deg)`,
            animation: `confettiFall ${p.duration}s ease-in ${p.delay}s forwards`,
          }}
        />
      ))}
      <style>{`
        @keyframes confettiFall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(115vh) rotate(540deg); opacity: 0.9; }
        }
      `}</style>
    </div>
  );
}

function GameEndOverlay({ room, nameOf, onLeave, onOpenLedger, onOpenCaptured }) {
  const totals = room.turnOrder.map((pid) => ({
    pid,
    total: [1, 2, 3, 4, 5, 6].reduce((s, r) => s + ((room.scores[pid] || {})[r] || 0), 0),
  }));
  totals.sort((a, b) => a.total - b.total);
  const winner = totals[0];
  return (
    <>
      <Confetti />
      <div style={overlayWrap}>
        <div style={overlayCard}>
          <div style={{ fontSize: 11, color: T.brassLight, letterSpacing: 2 }}>GAME COMPLETE</div>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 24, color: T.brassLight, fontWeight: 700, marginBottom: 14 }}>
            {nameOf(winner.pid)} wins!
          </div>
          {totals.map((e, i) => (
            <div key={e.pid} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #234838" }}>
              <span style={{ color: i === 0 ? T.brassLight : T.cream, fontSize: 14, fontWeight: i === 0 ? 700 : 400, display: "flex", alignItems: "center", gap: 6 }}>
                <ColorDot color={seatColor(room, e.pid)} />
                {i + 1}. {nameOf(e.pid)}
              </span>
              <span style={{ color: i === 0 ? T.brassLight : T.cream, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                {e.total}
              </span>
            </div>
          ))}
          <div style={{ fontSize: 11, color: T.cream, opacity: 0.5, marginTop: 14, textAlign: "center" }}>
            Lowest total wins. Start a new table to play again.
          </div>
          {onOpenCaptured && (
            <button onClick={onOpenCaptured} style={{ ...buttonSecondary, width: "100%", marginTop: 16 }}>
              View Captured Cards
            </button>
          )}
          {onOpenLedger && (
            <button onClick={onOpenLedger} style={{ ...buttonSecondary, width: "100%", marginTop: 10 }}>
              View Full Ledger
            </button>
          )}
          {onLeave && (
            <button onClick={onLeave} style={{ ...buttonPrimary, width: "100%", marginTop: 10 }}>
              Return to Main Menu
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/* ============================== SHARED STYLE OBJECTS ============================== */
const outerWrap = {
  minHeight: "100vh",
  background: `radial-gradient(ellipse at 50% 20%, ${T.felt}, ${T.feltDark})`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px",
  paddingTop: "max(20px, env(safe-area-inset-top))",
  paddingBottom: "max(20px, env(safe-area-inset-bottom))",
  fontFamily: "system-ui, -apple-system, sans-serif",
};
const panelStyle = {
  background: T.panel,
  border: `1px solid ${T.feltLine}`,
  borderRadius: 16,
  padding: 20,
};
const labelStyle = {
  display: "block",
  fontSize: 11,
  color: T.cream,
  opacity: 0.6,
  letterSpacing: 1,
  marginBottom: 6,
};
const inputStyle = {
  width: "100%",
  background: T.feltDark,
  border: `1px solid #2c4c3d`,
  borderRadius: 10,
  padding: "12px 14px",
  color: T.cream,
  fontSize: 16,
  outline: "none",
  boxSizing: "border-box",
};
const buttonPrimary = {
  background: T.brass,
  color: T.feltDark,
  border: "none",
  borderRadius: 10,
  padding: "12px 18px",
  fontWeight: 700,
  fontSize: 15,
  fontFamily: DISPLAY_FONT,
  cursor: "pointer",
};
const buttonSecondary = {
  background: "transparent",
  color: T.brassLight,
  border: `1px solid ${T.brassDim}`,
  borderRadius: 10,
  padding: "12px 18px",
  fontWeight: 600,
  fontSize: 15,
  fontFamily: DISPLAY_FONT,
  cursor: "pointer",
};
const overlayWrap = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  zIndex: 60,
};
const overlayCard = {
  background: T.panel,
  border: `1px solid ${T.brassDim}`,
  borderRadius: 16,
  padding: 22,
  width: "100%",
  maxWidth: "min(420px, 90vw)",
};
