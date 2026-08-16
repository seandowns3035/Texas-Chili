import React, { useState, useEffect, useRef } from "react";
import { db } from "./firebase.js";
import { ref, set, get, onValue } from "firebase/database";

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

async function loadRoom(code) {
  try {
    const snap = await get(roomRef(code));
    return snap.exists() ? hydrateRoom(snap.val()) : null;
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

function Ledger({ room, myId, onClose }) {
  const rounds = [1, 2, 3, 4, 5, 6];
  const totals = {};
  room.turnOrder.forEach((pid) => {
    totals[pid] = rounds.reduce((sum, r) => sum + ((room.scores[pid] || {})[r] || 0), 0);
  });
  const lowest = Math.min(...Object.values(totals));

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
          padding: "18px 14px 28px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: 700, color: T.ink }}>Ledger</div>
          <button onClick={onClose} className="text-sm" style={{ color: T.ink, opacity: 0.6 }}>
            Close
          </button>
        </div>
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
                      {p?.name || pid}
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
                      style={{
                        textAlign: "right",
                        padding: "6px 8px",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: 14,
                        color: T.ink,
                        borderBottom: "1px solid #ddd3ba",
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
  const [kittyFlash, setKittyFlash] = useState(null);
  const seenKittyId = useRef(null);

  // Realtime subscription — replaces polling entirely. Firebase pushes
  // updates the moment another player's device writes a change.
  useEffect(() => {
    if (screen === "entry" || !code) return;
    const unsubscribe = onValue(roomRef(code), (snap) => {
      if (snap.exists()) setRoom(hydrateRoom(snap.val()));
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
      const t = setTimeout(() => setKittyFlash(null), 3200);
      return () => clearTimeout(t);
    }
  }, [room?.kittyReveal?.id]);

  async function createRoom() {
    if (!name.trim()) return setError("Enter your name first.");
    const newCode = makeCode();
    const pid = sanitizeId(name);
    if (!pid) return setError("Enter a valid name.");
    const newRoom = {
      code: newCode,
      maxPlayers: desiredPlayers,
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
    setScreen("lobby");
    setError("");
  }

  async function startSoloTest() {
    if (!name.trim()) return setError("Enter your name first.");
    const newCode = makeCode();
    const pid = sanitizeId(name);
    if (!pid) return setError("Enter a valid name.");
    const players = [{ id: pid, name: pid }];
    const turnOrder = [pid];
    const scores = { [pid]: {} };
    for (let i = 2; i <= desiredPlayers; i++) {
      const botId = `Bot ${i}`;
      players.push({ id: botId, name: botId });
      turnOrder.push(botId);
      scores[botId] = {};
    }
    const newRoom = {
      code: newCode,
      maxPlayers: desiredPlayers,
      practiceMode: true,
      players,
      turnOrder,
      status: "lobby",
      round: 0,
      scores,
      log: [`${pid} started a solo practice table for ${desiredPlayers}.`],
    };
    await saveRoom(newCode, newRoom);
    setCode(newCode);
    setMyId(pid);
    setRoom(newRoom);
    seenKittyId.current = null;
    setScreen("lobby");
    setError("");
  }

  async function joinRoom() {
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
    const actingId = room.practiceMode ? room.currentTurnId : myId;
    if (room.currentTurnId !== actingId) return;
    let r = JSON.parse(JSON.stringify(room));
    r = playCard(r, actingId, card);
    await saveRoom(code, r);
    setRoom(r);
    setSelectedCard(null);
  }

  async function continueToNextRound() {
    if (!room) return;
    let r = JSON.parse(JSON.stringify(room));
    r = startRound(r, room.round + 1);
    await saveRoom(code, r);
    setRoom(r);
  }

  /* ---------------- ENTRY SCREEN ---------------- */
  if (screen === "entry") {
    return (
      <div style={outerWrap}>
        <div style={{ width: "100%", maxWidth: 380 }}>
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
            <button
              onClick={startSoloTest}
              style={{
                width: "100%",
                marginTop: 10,
                background: "transparent",
                border: "none",
                color: T.cream,
                opacity: 0.55,
                fontSize: 12,
                textDecoration: "underline",
                fontFamily: DISPLAY_FONT,
              }}
            >
              Practice solo — fill seats with bots I control
            </button>

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
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: T.cream, opacity: 0.6, letterSpacing: 2 }}>ROOM CODE</div>
            <div style={{ fontFamily: DISPLAY_FONT, fontSize: 44, fontWeight: 700, color: T.brassLight, letterSpacing: 6 }}>
              {code}
            </div>
            <div style={{ fontSize: 12, color: T.cream, opacity: 0.55, marginTop: 4 }}>
              Share this code with the other players
            </div>
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
                      gap: 10,
                      padding: "10px 4px",
                      borderBottom: i < room.maxPlayers - 1 ? "1px solid #234838" : "none",
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        background: p ? T.brassLight : "#3a5a4c",
                      }}
                    />
                    <div style={{ color: p ? T.cream : "#5f7f70", fontSize: 15, fontFamily: DISPLAY_FONT }}>
                      {p ? p.name : "Waiting…"}
                      {p && p.id === myId ? " (you)" : ""}
                    </div>
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
        </div>
      </div>
    );
  }

  /* ---------------- GAME SCREEN ---------------- */
  const opponents = room.turnOrder.filter((pid) => pid !== myId);
  const activeSeat = room.practiceMode ? room.currentTurnId : myId;
  const myHand = room.hands?.[activeSeat] || [];
  const isMyTurn = room.practiceMode ? true : room.currentTurnId === myId;
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
      }}
    >
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px 6px" }}>
        <div>
          <div style={{ fontSize: 10, color: T.brassLight, letterSpacing: 2, opacity: 0.8 }}>
            ROUND {room.round} / 6{room.practiceMode ? " · PRACTICE" : ""}
          </div>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 17, color: T.cream, fontWeight: 700 }}>
            {ROUND_META[room.round]?.label}
          </div>
        </div>
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

      {/* Opponents grid — wraps to fit anywhere from 2 to 9 opponents */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(78px, 1fr))",
          padding: "6px 10px 2px",
          gap: 6,
        }}
      >
        {opponents.map((pid) => {
          const handCount = room.hands?.[pid]?.length ?? 0;
          const active = room.currentTurnId === pid;
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
                }}
              >
                {nameOf(pid)}
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
          alignItems: "center",
          justifyContent: "center",
          padding: "10px 16px",
          position: "relative",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 340,
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
            room.currentTrick.map((play) => (
              <div key={play.playerId} style={{ textAlign: "center" }}>
                <PlayingCard card={play.card} size="md" />
                <div style={{ fontSize: 10, color: T.cream, opacity: 0.6, marginTop: 4 }}>
                  {nameOf(play.playerId)}
                </div>
              </div>
            ))
          )}
        </div>
        {room.leadSuit && (
          <div
            style={{
              position: "absolute",
              top: 2,
              left: "50%",
              transform: "translateX(-50%)",
              fontSize: 10,
              color: T.cream,
              opacity: 0.5,
              letterSpacing: 1,
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
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 6px 8px" }}>
          <div style={{ fontFamily: DISPLAY_FONT, fontSize: 13, color: isMyTurn ? T.brassLight : T.cream, fontWeight: 700 }}>
            {room.practiceMode ? `Playing as ${nameOf(activeSeat)}` : isMyTurn ? "Your turn" : `Waiting on ${nameOf(room.currentTurnId)}`}
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
            gap: 6,
            overflowX: "auto",
            paddingBottom: 4,
          }}
        >
          {myHand.map((c) => {
            const legal = isMyTurn && canPlayCard(myHand, c, room.leadSuit, forcedCardForHand);
            const isSelected = selectedCard && selectedCard.rank === c.rank && selectedCard.suit === c.suit;
            return (
              <PlayingCard
                key={cardId(c)}
                card={c}
                size="md"
                dim={isMyTurn && !legal}
                selected={isSelected}
                onClick={
                  legal
                    ? () => setSelectedCard(isSelected ? null : c)
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>

      {showLedger && <Ledger room={room} myId={myId} onClose={() => setShowLedger(false)} />}

      {kittyFlash && <KittyFlash event={kittyFlash} nameOf={nameOf} />}

      {room.status === "round-end" && (
        <RoundEndOverlay room={room} nameOf={nameOf} onContinue={continueToNextRound} />
      )}
      {room.status === "game-end" && <GameEndOverlay room={room} nameOf={nameOf} />}
    </div>
  );
}

function RoundEndOverlay({ room, nameOf, onContinue }) {
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
            <span style={{ color: T.cream, fontSize: 14 }}>{nameOf(e.pid)}</span>
            <span style={{ color: T.brassLight, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>+{e.pts}</span>
          </div>
        ))}
        <button onClick={onContinue} style={{ ...buttonPrimary, width: "100%", marginTop: 18 }}>
          {info.round >= 6 ? "See Final Results" : `Deal Round ${info.round + 1}`}
        </button>
      </div>
    </div>
  );
}

function GameEndOverlay({ room, nameOf }) {
  const totals = room.turnOrder.map((pid) => ({
    pid,
    total: [1, 2, 3, 4, 5, 6].reduce((s, r) => s + ((room.scores[pid] || {})[r] || 0), 0),
  }));
  totals.sort((a, b) => a.total - b.total);
  const winner = totals[0];
  return (
    <div style={overlayWrap}>
      <div style={overlayCard}>
        <div style={{ fontSize: 11, color: T.brassLight, letterSpacing: 2 }}>GAME COMPLETE</div>
        <div style={{ fontFamily: DISPLAY_FONT, fontSize: 24, color: T.brassLight, fontWeight: 700, marginBottom: 14 }}>
          {nameOf(winner.pid)} wins!
        </div>
        {totals.map((e, i) => (
          <div key={e.pid} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #234838" }}>
            <span style={{ color: i === 0 ? T.brassLight : T.cream, fontSize: 14, fontWeight: i === 0 ? 700 : 400 }}>
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
      </div>
    </div>
  );
}

/* ============================== SHARED STYLE OBJECTS ============================== */
const outerWrap = {
  minHeight: "100vh",
  background: `radial-gradient(ellipse at 50% 20%, ${T.felt}, ${T.feltDark})`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
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
  maxWidth: 340,
};
