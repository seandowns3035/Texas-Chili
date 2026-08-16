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

function computeRoundPoints(round, tricksWon, capturedCards) {
  let pts = 0;
  const wantsTricks = round === 1 || round === 6;
  const wantsQueens = round === 2 || round === 6;
  const wantsHearts = round === 3 || round === 6;
  const wantsKingSpades = round === 4 || round === 6;
  if (wantsTricks) pts += tricksWon * 10;
  if (wantsQueens) pts += capturedCards.filter((c) => c.rank === "Q").length * 25;
  if (wantsHearts) pts += capturedCards.filter((c) => c.suit === "H").length * 10;
  if (wantsKingSpades && capturedCards.some((c) => c.rank === "K" && c.suit === "S")) pts += 100;
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

  // Trick complete — resolve winner
  const leadSuit = room.leadSuit;
  let winning = room.currentTrick[0];
  for (const play of room.currentTrick) {
    if (play.card.suit === leadSuit && rankValue(play.card.rank) > rankValue(winning.card.rank)) {
      winning = play;
    }
  }
  const winnerId = winning.playerId;
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

  const winnerName = room.players.find((p) => p.id === winnerId)?.name || winnerId;
  pushLog(room, `${winnerName} won the trick.`);

  room.currentTrick = [];
  room.leadSuit = null;
  room.leaderId = winnerId;
  room.currentTurnId = winnerId;
  room.trickNumber += 1;

  const handsEmpty = room.turnOrder.every((pid) => (room.hands[pid] || []).length === 0);
  const earlyEnd = checkEarlyRoundEnd(room);
  if (handsEmpty || earlyEnd.done) {
    if (earlyEnd.done && !handsEmpty) pushLog(room, earlyEnd.reason);
    // Score the round
    const breakdown = {};
    room.turnOrder.forEach((pid) => {
      const pts = computeRoundPoints(room.round, room.tricksWon[pid] || 0, room.capturedCards[pid] || []);
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

/* ============================== SMALL UI PIECES ============================== */
function PlayingCard({ card, size = "md", faceDown, dim, onClick, selected }) {
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
        border: selected ? `2px solid ${T.brassLight}` : "1.5px solid #cfc6ac",
        boxShadow: selected
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

function CapturedView({ room, myId, nameOf, onClose }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 50,
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
                
