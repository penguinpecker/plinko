import "./polyfills";
import gsap from "gsap";
import confetti from "canvas-confetti";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN, Player, RARITY, STATUS, attestTee, boardPda, erExplorer, explorer, quote, sweep, trophyPda, vaultPda, whereIs, type BoardState } from "./chain";
import { connect, onWalletsChange, solanaWallets } from "./wallet";
import { BIN_COLORS, BoardView, COLORS } from "./board";
import { BALL, BALLS, DROP_TICKS, NONE, POINTS, bought, replay } from "./sim";

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const overlay = $("phase");
const canvas = $("board") as HTMLCanvasElement;
const view = new BoardView(canvas);
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- burner wallet (localStorage is untrusted: validate before use) ----------
function burner(key: string): Keypair {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(raw) && raw.length === 64 && raw.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
      return Keypair.fromSecretKey(Uint8Array.from(raw));
    }
  } catch { /* fall through to a fresh key */ }
  const kp = Keypair.generate();
  try { localStorage.setItem(key, JSON.stringify(Array.from(kp.secretKey))); } catch { /* private mode: key lives for this tab */ }
  return kp;
}
// `?wallet=2` gives this tab its own burner, so one browser can play a friend or a spectator
const slot = (new URL(location.href).searchParams.get("wallet") ?? "").replace(/\W/g, "").slice(0, 8);
let me = new Player(burner(`pw-wallet${slot}`));
const BET_WINDOW_S = 20;

// ---------- round state ----------
let id: BN | null = null;
let board: BoardState | null = null;
let onRollup = false;
let isHost = false;
let bots: { p: Player; plan: { drops: number[] } }[] = [];
let stopWatch: (() => void) | null = null;
let settling = false;
let betSol = 0.01; // per-ball buy-in; 0 = free round
let ballsPick = 5; // 1..BALLS
let quick = false; // quick play: you vs bots, every step signed by this tab
const BOT_RIVALS = 3;

// ---------- top bar ----------
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(lamports && lamports < 1e6 ? 6 : 3)} SOL`;
$("addr").textContent = short(me.pk.toBase58());
$("addr").onclick = () => navigator.clipboard?.writeText(me.pk.toBase58()).then(() => toast("Address copied")).catch(() => {});

const mute = $("mute");
const setMuted = (m: boolean) => {
  view.muted = m;
  mute.firstElementChild!.textContent = m ? "volume_off" : "volume_up";
  try { localStorage.setItem("pw-muted", m ? "1" : "0"); } catch { /* private mode */ }
};
setMuted((() => { try { return localStorage.getItem("pw-muted") === "1"; } catch { return false; } })());
mute.onclick = () => setMuted(!view.muted);

// Connect = an instant wallet: the key lives in this browser and the game faucet funds it with devnet SOL.
// Phantom/Backpack stays optional: one approval at join lets a MagicBlock session key in this tab sign
// every move on the rollup, so there are no popups mid-round.
const CONNECTED = `pw-connected${slot}`;
let connected = (() => { try { return localStorage.getItem(CONNECTED) === "1"; } catch { return false; } })();
function syncWallet() {
  document.querySelectorAll<HTMLElement>(".acct").forEach((e) => (e.hidden = !connected));
  ($("connect") as HTMLButtonElement).hidden = connected;
  ($("phantom") as HTMLButtonElement).hidden = connected || solanaWallets().length === 0;
}
syncWallet();
onWalletsChange(syncWallet);

/** Ask the game faucet (dev server, server/faucet.ts) to fund this wallet. "" = it already had enough to play. */
async function topUp(): Promise<string> {
  const t0 = performance.now();
  const r: { ok: boolean; sig?: string; lamports?: number; error?: string } = await fetch(`/api/fund?to=${me.pk.toBase58()}`, { method: "POST" })
    .then(async (x) => ({ ok: x.ok, ...(await x.json()) }))
    .catch(() => ({ ok: false, error: "the game faucet is unreachable" }));
  await refreshBalance();
  if (!r.ok) throw new Error(r.error ?? "the game faucet failed");
  if (r.sig) card("sol", "FAUCET", "SOLANA", `+${(r.lamports ?? 0) / LAMPORTS_PER_SOL} SOL`, "game faucet → your wallet")("confirmed", r.sig, performance.now() - t0);
  return r.sig ?? "";
}

/** `me` already holds this tab's browser key; connecting reveals it and funds it. */
async function connectInstant() {
  if (connected) return;
  connected = true;
  try { localStorage.setItem(CONNECTED, "1"); } catch { /* private mode: connected for this tab only */ }
  syncWallet();
  card("void", "WALLET", "SOLANA", "Instant wallet created", "keys stay in this browser")("seen");
  $("bal").textContent = "Funding…";
  await topUp().catch((e) => toast(`Wallet ready, but it wasn't funded: ${errText(e)}`, true));
}
$("connect").onclick = () => void connectInstant();

$("phantom").onclick = async () => {
  const w = solanaWallets().find((x) => /phantom/i.test(x.name)) ?? solanaWallets()[0];
  if (!w) return;
  try {
    const wallet = await connect(w);
    me = new Player(burner(`pw-session${slot}`), wallet);
    $("addr").textContent = `${wallet.name} · ${short(me.pk.toBase58())}`;
    $("wallet-label").textContent = "Your wallet";
    connected = true;
    syncWallet();
    card("void", "WALLET", "SOLANA", `${wallet.name} connected`, "one approval at join")("seen");
    await topUp().catch((e) => toast(`Connected, but it wasn't funded: ${errText(e)}`, true));
  } catch (e) {
    toast(`Wallet didn't connect: ${errText(e)}`, true);
  }
};
let lastBal = -1;
async function refreshBalance() {
  const lamports = await me.base.getBalance(me.pk).catch(() => null);
  const el = $("bal");
  el.textContent = lamports === null ? "? SOL" : sol(lamports);
  if (lamports !== null && lastBal >= 0 && lamports > lastBal && !calm) {
    gsap.fromTo(el, { color: "#fbbf24", textShadow: "0 0 14px rgba(251,191,36,.7)" }, { color: "#ecdcff", textShadow: "0 0 0 rgba(0,0,0,0)", duration: 1.4, ease: "power3.out" });
  }
  if (lamports !== null) lastBal = lamports;
  return lamports ?? 0;
}
$("airdrop").onclick = async () => {
  const b = $("airdrop") as HTMLButtonElement;
  b.disabled = true;
  b.textContent = "Requesting…";
  const funded = await topUp().then((sig) => {
    if (!sig) toast("You have enough devnet SOL to play. The game faucet tops up below 0.25 SOL.");
    return true;
  }, () => false);
  if (!funded) {
    // game faucet unavailable: fall back to the public devnet faucets
    const start = await refreshBalance();
    let sig = "";
    for (const url of ["https://api.devnet.solana.com", "https://rpc.magicblock.app/devnet"]) {
      sig = await new Connection(url, "confirmed").requestAirdrop(me.pk, LAMPORTS_PER_SOL).catch(() => "");
      if (sig) break;
    }
    for (let i = 0; sig && i < 20 && (await refreshBalance()) <= start; i++) await sleep(1500);
    if ((await refreshBalance()) > start) card("sol", "AIRDROP", "SOLANA", "+1 SOL", "devnet faucet")("confirmed", sig);
    else toast(`All devnet faucets are busy. Paste ${me.pk.toBase58()} into faucet.solana.com`, true);
  }
  b.disabled = false;
  b.textContent = "Get devnet SOL";
};
refreshBalance();
setInterval(refreshBalance, 15_000);
void attestTee().then((ok) => {
  const a = $("attest");
  a.dataset.st = ok ? "ok" : "fail";
  a.firstElementChild!.textContent = "verified";
  a.firstElementChild!.classList.toggle("fill", ok);
  a.lastElementChild!.textContent = ok ? "TEE attested · Intel TDX" : "Attestation unavailable";
  if (ok) card("er", "ATTEST", "TEE", "Intel TDX verified", "before the rollup sees anything")("seen");
});

// ---------- on-chain feed: every transaction this tab sends or sees, newest on top ----------
type Tone = "sol" | "er" | "vrf" | "win" | "void";
type Done = (st: "confirmed" | "sent" | "seen" | "failed", sig?: string, ms?: number, href?: string) => void;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
let txTotal = 0;
/** A pending card; call the returned function when the transaction lands. `layer` starting with SOLANA = a Solana signature. */
function card(tone: Tone, badge: string, layer: string, title: string, sub = ""): Done {
  const el = document.createElement("li");
  el.className = "tx cut";
  el.dataset.tone = tone;
  el.dataset.st = "pending";
  el.innerHTML = `<div class="r1"><i></i><b class="bd"></b><span class="ly"></span></div><span class="h"></span><div class="r2"><b class="t"></b><small></small></div><span class="tm" data-t="${Date.now()}">now</span>`;
  const q = (s: string) => el.querySelector(s) as HTMLElement;
  q(".bd").textContent = badge;
  q(".ly").textContent = layer;
  q(".t").textContent = title;
  q("small").textContent = sub;
  const list = $("txs");
  list.prepend(el);
  while (list.children.length > 50) list.lastElementChild!.remove();
  $("txcount").textContent = `${++txTotal} tx${txTotal === 1 ? "" : "s"}`;
  if (!calm) gsap.from(el, { width: 0, paddingLeft: 0, paddingRight: 0, opacity: 0, duration: 0.32, ease: "expo.out", clearProps: "all" });
  return (st, sig = "", ms, href) => {
    el.dataset.st = st;
    const link = href ?? (SIG.test(sig) ? (layer.startsWith("SOLANA") ? explorer(sig) : erExplorer(sig)) : "");
    if (link) {
      const a = document.createElement("a");
      a.className = "h";
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      if (!href && !layer.startsWith("SOLANA")) a.title = "Private rollup: Explorer shows this landed; its contents stay sealed";
      a.textContent = sig ? `${sig.slice(0, 6)}…${sig.slice(-3)}` : "view";
      a.insertAdjacentHTML("beforeend", `<span class="ms">north_east</span>`);
      q(".h").replaceWith(a);
    }
    if (ms !== undefined) q(".tm").dataset.ms = String(Math.round(ms));
    ageCards();
    if (tone === "win" && st !== "failed" && !calm) el.animate([{ backgroundColor: "#fbbf24" }, {}], { duration: 1400, easing: "cubic-bezier(.23,1,.32,1)" });
  };
}
/** Card for a transaction promise: pending until it lands, then confirmed (or sent, for fire-and-forget moves) with its time. */
async function track(tone: Tone, badge: string, layer: string, title: string, sub: string, p: Promise<string>, ok: "confirmed" | "sent" = "confirmed") {
  const done = card(tone, badge, layer, title, sub), t0 = performance.now();
  try {
    const sig = await p;
    done(sig ? ok : "failed", sig, performance.now() - t0);
    return sig;
  } catch (e) {
    done("failed");
    throw e;
  }
}
function ageCards() {
  const now = Date.now();
  $("txs").querySelectorAll<HTMLElement>("[data-t]").forEach((el) => {
    const s = Math.floor((now - Number(el.dataset.t)) / 1000);
    const age = s < 3 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
    el.textContent = el.dataset.ms ? `${el.dataset.ms}ms · ${age}` : age;
  });
}
setInterval(ageCards, 1000);
// the strip scrolls sideways with a normal mouse wheel too
$("txs").addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  $("txs").scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

let toastTimer = 0;
function toast(text: string, bad = false) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("on"), 3200);
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\(.{40,}\)/, "").slice(0, 200);

// ---------- juice: only for your own big moments ----------
const PARTY = ["#f26aff", "#fbbf24", "#ffffff", "#fda9ff", "#a4c9ff"];
/** Canvas pixel -> viewport fraction, for confetti origins. */
const at = (x: number, y: number) => {
  const c = canvas.getBoundingClientRect();
  return { x: (c.left + (x / 760) * c.width) / innerWidth, y: (c.top + (y / 700) * c.height) / innerHeight };
};
view.onLand = (bin, owner, _golden, x, y) => {
  addRecent(bin, owner);
  if (owner !== view.me || POINTS[bin] < 110) return;
  void confetti({ particleCount: POINTS[bin] >= 330 ? 90 : 45, spread: 70, startVelocity: 38, gravity: 1.1, ticks: 160, scalar: 0.9, origin: at(x, y), colors: PARTY, disableForReducedMotion: true });
  if (!calm) gsap.fromTo(".board-card", { y: 6 }, { y: 0, duration: 0.5, ease: "elastic.out(1,0.35)" });
};
function addRecent(bin: number, owner: number) {
  const li = document.createElement("li");
  li.style.setProperty("--bin", BIN_COLORS[bin]);
  li.style.setProperty("--pc", COLORS[owner]);
  li.innerHTML = "<i></i>";
  li.append(String(POINTS[bin] / 10));
  const list = $("recent");
  list.prepend(li);
  while (list.children.length > 12) list.lastElementChild!.remove();
  if (!calm) gsap.from(li, { scale: 0.6, opacity: 0, duration: 0.25, ease: "back.out(2)" });
}
/** Tween a number shown in `el` to `to`; instant when the value hasn't changed or motion is reduced. */
function countTo(el: HTMLElement, to: number, fmt: (v: number) => string, duration = 0.6) {
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = String(to);
  if (calm || from === to) { el.textContent = fmt(to); return; }
  const o = { v: from };
  gsap.to(o, { v: to, duration, ease: "power2.out", onUpdate: () => { el.textContent = fmt(o.v); } });
}

// ---------- phase card (left) ----------
function panel(html: string) {
  overlay.innerHTML = `<div class="panel cut">${html}</div>`;
  const p = overlay.firstElementChild as HTMLElement;
  if (!calm) gsap.from(p.children, { y: 10, opacity: 0, duration: 0.3, stagger: 0.04, ease: "power3.out" });
  return p;
}
function clearPanel() {
  overlay.innerHTML = "";
}
const bolt = `<span class="ms fill">bolt</span>`;
function stepper(title: string, steps: string[], n: number) {
  return panel(`<span class="micro">On chain</span><h2 class="head">${title}</h2>
    <ol class="steps">${steps.map((s, i) => `<li class="${i < n ? "done" : i === n ? "now" : ""}"><span class="ms">${i < n ? "check" : "progress_activity"}</span>${s}</li>`).join("")}</ol>
    <p class="err" id="err"></p>`);
}

/** Clear the last round off the screen. */
function resetRound() {
  id = null; board = null; onRollup = false; isHost = false; bots = []; settling = false; starting = false; betPanelOpen = false; quick = false;
  stopWatch?.();
  chatHead = -1;
  $("chat").innerHTML = "";
  $("chat-card").hidden = true;
  view.reset();
  view.banner = null;
  $("controls").hidden = true;
  $("recent").innerHTML = "";
  renderRail();
}

function lobby(msg = "") {
  setUrl(null);
  resetRound();
  playCard("quick", msg);
}

/** The one screen: bet per ball + number of balls, then Play (you vs 3 bots, everything else signs itself),
 * or the same choice for a table friends can join by link. `result` is the last round's summary. */
function playCard(mode: "quick" | "friends", msg = "", result = "") {
  const p = panel(`
    ${result}
    <span class="micro">${mode === "quick" ? `Quick play // you vs ${BOT_RIVALS} bots` : "Private table // up to 8 friends"}</span>
    ${result ? "" : `<h2 class="head">${mode === "quick" ? `Drop <em>balls</em>` : `Play with <em>friends</em>`}</h2>`}
    <span class="micro">Bet per ball (SOL)</span>
    <div class="betbox cut"><input id="bet" inputmode="decimal" autocomplete="off" aria-label="Bet per ball in SOL" /><span class="micro">SOL</span><button data-k="0.5">½</button><button data-k="2">2×</button></div>
    <div class="seg" id="price">
      <button data-v="0">FREE</button>
      <button data-v="0.01">0.01</button>
      <button data-v="0.05">0.05</button>
      <button data-v="0.1">0.1</button>
    </div>
    <span class="micro">Balls</span>
    <div class="seg five" id="nballs">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}">${n}</button>`).join("")}</div>
    <p class="note" id="quote"></p>
    <button class="cta" id="play"><span class="ms fill" id="play-icon">bolt</span><span id="play-label">${mode === "quick" ? (result ? "Play again" : "Play") : "Create table"}</span></button>
    <button class="link" id="mode">${mode === "quick" ? "Play with friends instead" : "Quick play vs bots instead"}</button>
    <p class="err" id="err"></p>`);
  p.querySelector("#err")!.textContent = msg;
  const input = p.querySelector<HTMLInputElement>("#bet")!;
  let usd = 0; // SOL price from MagicBlock's oracle, for the dollar hint only
  const show = () => {
    p.querySelectorAll<HTMLButtonElement>("#price button").forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.v) === betSol)));
    p.querySelectorAll<HTMLButtonElement>("#nballs button").forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.v) === ballsPick)));
    const total = betSol * ballsPick;
    p.querySelector("#quote")!.textContent = (betSol
      ? `You stake ${+total.toFixed(4)} SOL on ${ballsPick} ball${ballsPick > 1 ? "s" : ""}${usd ? ` (≈ $${(total * usd).toFixed(2)} on MagicBlock's oracle)` : ""}.`
      : `Free round: ${ballsPick} ball${ballsPick > 1 ? "s" : ""} for points.`)
      + (mode === "quick" ? ` ${BOT_RIVALS} bots match you; the pot splits by points.` : " Friends join with your invite link.");
  };
  const set = (v: number) => {
    betSol = Math.min(10, Math.max(0, +v.toFixed(4)));
    input.value = betSol ? String(betSol) : "0";
    show();
  };
  set(betSol);
  input.oninput = () => {
    const v = Number(input.value);
    if (Number.isFinite(v) && v >= 0) { betSol = Math.min(10, +v.toFixed(4)); show(); }
  };
  input.onblur = () => set(betSol);
  p.querySelectorAll<HTMLButtonElement>(".betbox button").forEach((b) => (b.onclick = () => set(Math.max(betSol ? 0.001 : 0, betSol * Number(b.dataset.k)))));
  p.querySelectorAll<HTMLButtonElement>("#price button").forEach((b) => (b.onclick = () => set(Number(b.dataset.v))));
  p.querySelectorAll<HTMLButtonElement>("#nballs button").forEach((b) => (b.onclick = () => { ballsPick = Number(b.dataset.v); show(); }));
  void quote(100).then((q) => { if (q) { usd = q.usd; show(); } });
  p.querySelector<HTMLButtonElement>("#play")!.onclick = () => guard(mode === "quick" ? quickPlay : createRound);
  p.querySelector<HTMLButtonElement>("#mode")!.onclick = () => { setUrl(null); resetRound(); playCard(mode === "quick" ? "friends" : "quick"); };
}

/** Progress on the Play button while a quick round runs itself. */
function playStatus(text: string) {
  const label = overlay.querySelector("#play-label"), icon = overlay.querySelector("#play-icon");
  if (!label || !icon) return;
  label.textContent = text;
  icon.textContent = "progress_activity";
  icon.classList.add("spin");
}

/** One click: open the round with bots in one transaction, move it to the private rollup, roll the dice.
 * From there `onBoard` drops your balls, the crank runs the board and `settle` pays out; no more clicks. */
async function quickPlay() {
  view.unlockAudio(); // still inside the Play click, so the browser allows sound
  setUrl(null);
  resetRound(); // the play card stays up and shows progress
  quick = true;
  const perBall = Math.round(betSol * LAMPORTS_PER_SOL), n = ballsPick;
  const botFund = perBall * n + 0.003 * LAMPORTS_PER_SOL; // their stake + fees, swept back after the round
  const need = perBall * n + BOT_RIVALS * botFund + 0.03 * LAMPORTS_PER_SOL;
  if ((await refreshBalance()) < need) await topUp().catch(() => "");
  await needSol(need);
  playStatus("Opening table…");
  const botKeys = Array.from({ length: BOT_RIVALS }, () => Keypair.generate());
  id = new BN(Date.now());
  isHost = true;
  await track("sol", "CREATE", "SOLANA", `${n} ball${n > 1 ? "s" : ""} × ${betSol || "free"}${betSol ? " SOL" : ""}`, `you + ${BOT_RIVALS} bots seated, one tx`, me.create(id, new BN(perBall), 0, n, botKeys, botFund));
  bots = botKeys.map((kp) => ({ p: new Player(kp), plan: botPlan(n, 24) }));
  setUrl(id);
  playStatus("Moving to the private rollup…");
  await track("sol", "DELEGATE", "SOLANA → ROLLUP", "Board + seed to private rollup", "sealed on arrival", me.delegate(id));
  const sealedByAction = await me.sealPermissions(id);
  card("er", "SEAL", "ROLLUP", sealedByAction ? "Seed sealed on arrival" : "Seed sealed (fallback)", "nobody can peek")("seen");
  await watch();
  playStatus("Rolling the dice…");
  await track("vrf", "VRF", "ROLLUP", "Dice requested", "oracle price read", me.start(id));
}

async function guard(fn: () => Promise<void>) {
  overlay.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
  try {
    if (!connected) await connectInstant(); // playing without connecting first: make the wallet now
    await fn();
  } catch (e) {
    const el = overlay.querySelector(".err");
    if (el) el.textContent = errText(e);
    else toast(errText(e), true);
    overlay.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
}

function setUrl(r: BN | null) {
  const u = new URL(location.href);
  if (r) u.searchParams.set("r", r.toString());
  else u.searchParams.delete("r");
  history.replaceState(null, "", u);
}
const inviteLink = (r: BN) => `${location.origin}${location.pathname}?r=${r.toString()}`;
const copyInvite = (r: BN) => navigator.clipboard?.writeText(inviteLink(r)).then(() => toast("Invite link copied")).catch(() => {});

// ---------- Solana lobby ----------
async function needSol(lamports: number) {
  if ((await refreshBalance()) < lamports) throw new Error(`You need about ${sol(lamports)} on devnet. Use "Get devnet SOL" first.`);
}

async function createRound() {
  quick = false;
  const perBall = Math.round(betSol * LAMPORTS_PER_SOL), n = ballsPick;
  await needSol(perBall * n + 0.03 * LAMPORTS_PER_SOL);
  id = new BN(Date.now());
  isHost = true;
  await track("sol", "CREATE", "SOLANA", perBall ? `Round opened · ${betSol} SOL/ball` : "Free round opened", perBall ? `${sol(perBall * n)} staked on ${n} balls` : `you took seat 1, ${n} balls`, me.create(id, new BN(perBall), 0, n));
  setUrl(id);
  await showLobby();
}

async function openRound(r: BN) {
  const found = await me.fetchBase(r);
  if (!found) throw new Error("That round link doesn't match a round on devnet.");
  id = r;
  board = found.board;
  isHost = board.host.equals(me.pk);
  setUrl(r);
  renderRail();
  if (found.delegated) return watch();
  if (board.status !== STATUS.OPEN) return showResultsFromBase();
  const seated = board.players.slice(0, board.playersLen).some((k) => k.equals(me.pk));
  if (seated) return showLobby();
  const price = board.price.toNumber();
  const p = panel(`
    <span class="micro">You're invited</span>
    <h2 class="head">Take a <em>seat</em></h2>
    <b class="num seated">${board.playersLen}/8 seated</b>
    <p class="sub">${board.usdCents ? `$${(board.usdCents / 100).toFixed(2)} per ball, locked from MagicBlock's price oracle at start. You deposit ${sol(price * BALLS)} for ${BALLS} balls; the unspent part comes back.` : price ? `${sol(price)} per ball: you stake ${sol(price * BALLS)} for ${BALLS} balls. The pot splits by points.` : `Free round, ${BALLS} balls each.`}</p>
    <button class="cta" id="go">${bolt}Take a seat</button>
    <button class="ghost cut" id="back">Back</button>
    <p class="err" id="err"></p>`);
  p.querySelector<HTMLButtonElement>("#back")!.onclick = () => lobby();
  p.querySelector<HTMLButtonElement>("#go")!.onclick = () => guard(async () => {
    await needSol(price * BALLS + 0.01 * LAMPORTS_PER_SOL);
    await track("sol", "SEAT", "SOLANA", "Seat taken", price ? `${sol(price * BALLS)} staked in vault` : "free round", me.join(r));
    await showLobby();
  });
}

async function showLobby() {
  const r = id!;
  const p = panel(`
    <span class="micro">You're seated</span>
    <h2 class="head">Table <em>open</em></h2>
    <p class="sub">Invite friends on devnet with the link, or add bot rivals.</p>
    <button class="sec" id="copy"><span class="ms">link</span>Copy invite link</button>
    ${isHost ? `
    <button class="sec" id="bot"><span class="ms">smart_toy</span>Add bot rival</button>
    <button class="cta" id="start">${bolt}Start round</button>
    <button class="ghost cut" id="cancel">Cancel &amp; refund</button>` : `<p class="wait micro"><i></i>Waiting for host</p>`}
    <p class="err" id="err"></p>`);
  p.querySelector<HTMLButtonElement>("#copy")!.onclick = () => copyInvite(r);
  if (isHost) {
    p.querySelector<HTMLButtonElement>("#bot")!.onclick = () => guard(addBot);
    p.querySelector<HTMLButtonElement>("#start")!.onclick = () => guard(hostStart);
    p.querySelector<HTMLButtonElement>("#cancel")!.onclick = () => guard(async () => {
      await track("void", "REFUND", "SOLANA", "Round cancelled", "buy-ins refunded", me.cancel(board!));
      lobby();
    });
  }
  // poll Solana until the host hands the round to the rollup
  while (id && id.eq(r) && !onRollup && !starting) {
    const found = await me.fetchBase(r).catch(() => null);
    if (found) {
      board = found.board;
      if (found.delegated) return watch();
      if (board.status !== STATUS.OPEN) return lobby("The host cancelled the round. Buy-ins were refunded.");
      if (!overlay.querySelector("#copy")) return;
      renderRail();
    }
    await sleep(1500);
  }
}

async function addBot() {
  const b = board!;
  if (b.playersLen >= 8) throw new Error("The round is full.");
  const bot = new Player(Keypair.generate());
  const n = Math.max(1, bought(b.balls, 0)); // bots match the host's ball count
  const fund = b.price.toNumber() * n + 0.003 * LAMPORTS_PER_SOL; // deposit + a little for fees
  await needSol(fund + 0.01 * LAMPORTS_PER_SOL);
  await track("sol", "BOT", "SOLANA", `Bot ${bots.length + 1} seated`, "funded + joined, one tx", me.seatBot(id!, bot.kp, fund, n));
  bots.push({ p: bot, plan: botPlan(n) });
  overlay.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = false));
}

/** Bots drop their balls at random moments within the first `span` ticks. */
function botPlan(n = BALLS, span = DROP_TICKS - 10) {
  return { drops: Array.from({ length: n }, () => 1 + Math.floor(Math.random() * span)).sort((a, b) => a - b) };
}

let starting = false;
async function hostStart() {
  const r = id!;
  starting = true; // the lobby poll stops; this flow opens the live view itself
  const steps = ["Hand the board and seed to MagicBlock's private rollup", "Seal the seed on arrival, open the rollup chat", "Open bets, then roll the fair dice (VRF)"];
  stepper("Starting", steps, 0);
  await track("sol", "DELEGATE", "SOLANA → ROLLUP", "Board + seed to private rollup", "sealed on arrival", me.delegate(r));
  stepper("Starting", steps, 1);
  const sealedByAction = await me.sealPermissions(r);
  card("er", "SEAL", "ROLLUP", sealedByAction ? "Seed sealed on arrival" : "Seed sealed (fallback)", "chat open")("seen");
  starting = false;
  await watch();
  await hostBetting(r);
}

/** Spectators can back a player with gasless test-USDC until the dice roll. */
async function hostBetting(r: BN) {
  let go: () => void = () => {};
  const started = new Promise<void>((ok) => (go = ok));
  const end = Date.now() + BET_WINDOW_S * 1000;
  const p = panel(`
    <span class="micro">Spectators</span>
    <h2 class="head">Bets <em class="a">open</em></h2>
    <div class="count"><b class="num" id="left">${BET_WINDOW_S}</b><span class="micro">seconds to auto-roll</span></div>
    <div class="bar"><i id="bar" style="width:100%"></i></div>
    <p class="sub">Spectators back a player with gasless test-USDC on the private rollup until the dice roll.</p>
    <button class="sec" id="invite"><span class="ms">link</span>Copy invite link</button>
    <ol class="bets" id="bet-list"></ol>
    <button class="cta" id="roll">${bolt}Roll the dice</button>
    <p class="err" id="err"></p>`);
  p.querySelector<HTMLButtonElement>("#roll")!.onclick = () => go();
  p.querySelector<HTMLButtonElement>("#invite")!.onclick = () => copyInvite(r);
  const timer = setInterval(() => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    const el = overlay.querySelector("#left"), bar = overlay.querySelector<HTMLElement>("#bar");
    if (el) el.textContent = String(left);
    if (bar) bar.style.width = `${(100 * Math.max(0, end - Date.now())) / (BET_WINDOW_S * 1000)}%`;
    renderBets(overlay.querySelector("#bet-list"));
    if (left === 0) go();
  }, 500);
  await started;
  clearInterval(timer);
  stepper("Rolling the dice", ["Bets closed", "MagicBlock VRF seals every bounce"], 1);
  await track("vrf", "VRF", "ROLLUP", "Dice requested", "bets closed · oracle price read", me.start(r));
}

// ---------- live round on the rollup ----------
async function watch() {
  const r = id!;
  if (onRollup) return; // already watching this round
  onRollup = true;
  if (!quick) clearPanel(); // quick play keeps its card up, showing progress
  view.reset();
  view.me = myIndex();
  lastStatus = -1;
  armSent = false;
  $("chat-card").hidden = quick; // bots don't chat
  stopWatch?.();
  const unsub = await me.subscribe(r, onBoard);
  const poll = setInterval(async () => {
    const b = await me.fetchTee(r).catch(() => null);
    if (b) onBoard(b);
  }, 1000);
  // MagicBlock's crank ticks the board; clients only step in if it goes quiet for a second
  let lastTick = -1, lastMove = performance.now();
  const beat = setInterval(() => {
    if (board?.status !== STATUS.LIVE) return;
    if (board.tick !== lastTick) { lastTick = board.tick; lastMove = performance.now(); }
    else if (board.tick > 0 && performance.now() - lastMove > 1000) void me.tick(r);
  }, 300);
  const chat = setInterval(() => void refreshChat(r), 1000);
  stopWatch = () => { unsub(); clearInterval(poll); clearInterval(beat); clearInterval(chat); stopWatch = null; };
  const b = await me.fetchTee(r).catch(() => null);
  if (b) onBoard(b);
  const where = await whereIs(boardPda(r));
  if (where) card("er", "ROUTER", "ROLLUP", `Board on ${where}`, "Magic Router")("seen");
}

let lastStatus = -1;
let armSent = false;
function onBoard(b: BoardState) {
  if (!id || !b.id.eq(id)) return;
  if (board && board.status === b.status && b.tick < board.tick) return; // stale
  board = b;
  const now = performance.now();
  view.update(b, now);
  if (b.status !== lastStatus) {
    lastStatus = b.status;
    if (b.status === STATUS.OPEN && !isHost) {
      if (myIndex() < 0) showBetPanel();
      else view.banner = { text: "BETS ARE OPEN", sub: "Spectators are backing players. The host rolls soon." };
    }
    if (b.status === STATUS.ROLLING) {
      if (!isHost) clearPanel();
      view.banner = { text: "ROLLING THE DICE", sub: "MagicBlock VRF is sealing every bounce" };
    }
    if (b.status === STATUS.LIVE) {
      if (quick) autoDrop(b);
      card("vrf", "DICE", "ROLLUP", "Dice landed", "seed sealed in the TEE")("seen");
      if (b.usdCents) card("vrf", "ORACLE", "ROLLUP", `$${(b.usdCents / 100).toFixed(2)} = ${sol(b.ballCost.toNumber())}`, "ball cost locked")("seen");
    }
    if (b.status === STATUS.OVER) void settle();
  }
  if (b.status === STATUS.LIVE && !b.armed && !armSent) {
    // the host hands ticking to the rollup's crank; anyone else does it if the host hasn't after 2 s
    armSent = true;
    void sleep(isHost ? 0 : 2000)
      .then(() => (board?.armed ? "" : track("er", "CRANK", "ROLLUP", "Crank armed", "ticks every 250 ms", me.arm(id!))))
      .catch(() => {});
  }
  if (b.status === STATUS.OPEN) renderBets(overlay.querySelector("#bet-list"));
  if (b.status === STATUS.LIVE) {
    if (!quick && overlay.firstElementChild) clearPanel(); // bet panels and "rolling" notes go once balls fall
    view.banner = b.tick === 0 ? { text: "GET READY", sub: "Drop now; your balls leave on the first tick" } : null;
    $("controls").hidden = myIndex() < 0;
    $("controls").classList.toggle("auto", quick);
    runBots(b);
  }
  renderRail();
}

function myIndex() {
  return board ? board.players.slice(0, board.playersLen).findIndex((k) => k.equals(me.pk)) : -1;
}

/** Quick play: queue all your balls the moment the dice land; the board releases one every RELEASE_GAP ticks. */
function autoDrop(b: BoardState) {
  const i = myIndex();
  if (i < 0) return;
  playStatus("Balls dropping…");
  const n = b.balls.slice(i * BALLS, i * BALLS + BALLS).filter((x) => x.state === BALL.IN_HAND).length;
  for (let k = 0; k < n; k++) void track("er", "DROP", "ROLLUP", `You · ball ${k + 1}`, "auto-signed in this tab", me.drop(id!), "sent");
}

function runBots(b: BoardState) {
  bots.forEach((bot, n) => {
    while (bot.plan.drops.length && bot.plan.drops[0] <= b.tick) {
      bot.plan.drops.shift();
      void track("er", "DROP", "ROLLUP", `Bot ${n + 1} · ball ${bought(b.balls, 0) - bot.plan.drops.length}`, "", bot.p.drop(id!), "sent");
    }
  });
}

// controls: drop
canvas.onclick = () => view.unlockAudio();
function dropBall() {
  view.unlockAudio();
  const i = myIndex();
  if (!id || i < 0 || board?.status !== STATUS.LIVE) return;
  const inHand = board.balls.slice(i * BALLS, i * BALLS + BALLS).filter((x) => x.state === BALL.IN_HAND).length;
  if (inHand === 0) return;
  void track("er", "DROP", "ROLLUP", `You · ball ${BALLS - inHand + 1}`, "", me.drop(id), "sent");
}
$("drop").onclick = dropBall;
addEventListener("keydown", (e) => {
  if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    dropBall();
  }
});

// ---------- rollup-only chat ----------
let chatHead = -1;
async function refreshChat(r: BN) {
  const c = await me.fetchChat(r);
  if (!c || c.head === chatHead) return;
  chatHead = c.head;
  const n = Math.min(c.head, c.msgs.length);
  const msgs = Array.from({ length: n }, (_, i) => c.msgs[(c.head - n + i) % c.msgs.length]);
  const list = $("chat");
  list.innerHTML = "";
  for (const m of msgs) {
    const li = document.createElement("li");
    const who = document.createElement("b");
    who.textContent = m.seat === NONE ? "spectator" : nameOf(m.seat);
    who.style.color = m.seat === NONE ? "var(--outline)" : COLORS[m.seat];
    li.append(who, ` ${new TextDecoder().decode(Uint8Array.from(m.text.slice(0, m.len)))}`);
    list.append(li);
  }
  list.scrollTop = list.scrollHeight;
}
($("say") as HTMLFormElement).onsubmit = (e) => {
  e.preventDefault();
  const input = $("say-text") as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !id || !onRollup) return;
  input.value = "";
  void me.say(id, text);
};

// ---------- end of round ----------
async function settle() {
  if (settling || !id) return;
  settling = true;
  const r = id;
  $("controls").hidden = true;
  const steps = ["Reveal the seed on the rollup", "Commit the board to Solana", "Magic Action pays every seat"];
  const progress = (n: number) => (quick ? playStatus(["Revealing the seed…", "Committing to Solana…", "Paying out…"][n]) : stepper("Settling", steps, n));
  progress(0);
  view.banner = { text: "ROUND OVER", sub: "Revealing the seed, committing to Solana, paying out…" };
  await sleep(1200);
  // the host finishes; anyone else steps in if the host has gone quiet
  if (!isHost) await sleep(5000);
  const backOnBase = async () => {
    const found = await me.fetchBase(r).catch(() => null);
    return found && !found.delegated && found.board.status === STATUS.OVER ? found.board : null;
  };
  let base = await backOnBase();
  const live = await me.fetchTee(r).catch(() => null);
  if (!base && live && live.betsLen > 0 && !live.betsPaid) {
    await track("er", "SETTLE", "ROLLUP", "Spectator bets settled", `backers of ${nameOf(winnerOf(live))} split the pool`, me.settleBets(live)).catch(() => {});
  }
  if (!base) {
    await track("er", "COMMIT", "ROLLUP → SOLANA", "Seed revealed · commit sent", "Magic Action payout attached", me.finish(r)).catch(() => {});
    progress(1);
    for (const end = Date.now() + 30_000; !base && Date.now() < end; await sleep(1500)) base = await backOnBase();
  }
  if (!base) {
    // the auto-payout path didn't land: plain commit, then claims on Solana
    await track("void", "COMMIT", "ROLLUP", "Fallback commit", "claims follow on Solana", me.finishManual(r)).catch(() => {});
    for (const end = Date.now() + 60_000; !base && Date.now() < end; await sleep(1500)) base = await backOnBase();
  }
  stopWatch?.();
  if (!base) {
    view.banner = { text: "STILL COMMITTING", sub: "The result hasn't reached Solana yet. Reload in a minute." };
    return;
  }
  progress(2);
  board = base;
  view.banner = null;
  if (base.paid === (1 << base.playersLen) - 1) {
    const sig = (await me.base.getSignaturesForAddress(vaultPda(r), { limit: 1 }).catch(() => []))[0]?.signature ?? "";
    card("win", "PAYOUT", "SOLANA", `Paid ${base.playersLen} seats`, "Magic Action, as the round landed")("confirmed", sig);
  } else {
    if (!isHost) await sleep(4000);
    const fresh = (await me.fetchBase(r))?.board ?? base;
    const sig = await me.claimAll(fresh).catch(() => "");
    if (sig) card("win", "PAYOUT", "SOLANA", "Payouts sent from vault", "claims")("confirmed", sig);
  }
  await showResultsFromBase(true);
}

async function showResultsFromBase(fresh = false) {
  const b = board!;
  const total = b.scores.slice(0, b.playersLen).reduce((a, s) => a + s, 0);
  const seed = Uint8Array.from(b.seed);
  const bad = seed.some((x) => x) ? replay(seed, b.playersLen, b.balls, b.bumpers) : null;
  const order = [...Array(b.playersLen).keys()].sort((x, y) => b.scores[y] - b.scores[x]);
  const pot = b.pot.toNumber();
  // same split as the program: unspent deposit back + points share of what was staked
  const unspent = b.price.toNumber() - b.ballCost.toNumber(); // per ball bought
  const seats = [...Array(b.playersLen).keys()];
  const prize = pot - unspent * seats.reduce((a, i) => a + bought(b.balls, i), 0);
  const owed = (i: number) => unspent * bought(b.balls, i) + (total ? Math.floor((prize * b.scores[i]) / total) : Math.floor(prize / b.playersLen));
  const share = (i: number) => (total ? (100 * b.scores[i]) / total : 0);
  const mine = myIndex(), won = order[0] === mine;
  const asset = trophyPda(b.id).toBase58();
  if (quick && fresh) return quickResult(b, order, mine, pot ? owed(mine) : share(mine), !!pot, bad, asset);
  const p = panel(`
    <span class="micro">Round settled on Solana</span>
    <h2 class="head">${won ? `You <em class="a">win</em>` : `Round <em>over</em>`}</h2>
    ${mine >= 0 ? `<div class="hero"><span class="micro">Your payout</span><b class="num" id="payout">0</b></div>` : ""}
    <ol class="standings">${order.map((i, rank) => `
      <li class="cut"><span class="num rk">#${rank + 1}</span><span class="dot" style="background:${COLORS[i]}"></span>
      <b>${nameOf(i)}</b><span class="num">${(b.scores[i] / 10).toFixed(1)}</span>
      <span class="num pay">${pot ? sol(owed(i)) : `${Math.round(share(i))}%`}</span></li>`).join("")}</ol>
    ${b.usdCents ? `<p class="note">Ball cost locked at $${(b.usdCents / 100).toFixed(2)} = ${sol(b.ballCost.toNumber())} by MagicBlock's price oracle inside the private rollup.</p>` : ""}
    ${b.trophy ? `<p class="trophy"><span class="ms fill">emoji_events</span><span>${nameOf(order[0])} won a <b>${RARITY[b.trophy - 1]}</b> trophy, minted by the payout's Magic Action. <a href="https://explorer.solana.com/address/${asset}?cluster=devnet" target="_blank" rel="noopener noreferrer">View</a></span></p>` : ""}
    <div class="proof cut ${bad && bad.length ? "bad" : ""}">${
      bad === null ? `<span class="hd micro">Seed not revealed yet</span>`
      : bad.length ? `<span class="hd micro">Replay mismatch</span>${bad.length} item(s) don't match. Don't trust this round.`
      : `<span class="hd micro"><span class="ms fill">verified</span>Replay verified</span>All ${seats.reduce((a, i) => a + bought(b.balls, i), 0)} balls match the revealed seed <code>${hex(seed).slice(0, 16)}…</code>`}</div>
    ${b.betsLen ? `<p class="note">Spectators bet ${(b.betTotal.toNumber() / 1e6).toFixed(0)} test-USDC on ${b.betsLen} bet(s), settled gaslessly on the rollup.</p>` : ""}
    <button class="cta" id="again">${bolt}Play again</button>
    <button class="sec" id="cashout" hidden></button>`);
  p.querySelector<HTMLButtonElement>("#again")!.onclick = () => lobby();
  const payout = p.querySelector<HTMLElement>("#payout");
  if (payout) {
    payout.dataset.v = "0";
    countTo(payout, pot ? owed(mine) : share(mine), (v) => (pot ? sol(Math.round(v)) : `${Math.round(v)}%`), 0.9);
  }
  if (fresh && b.trophy) card("win", "TROPHY", "SOLANA", `${RARITY[b.trophy - 1]} trophy → ${nameOf(order[0])}`, "Metaplex Core")("seen", "", undefined, `https://explorer.solana.com/address/${asset}?cluster=devnet`);
  if (fresh && won) {
    view.banner = { text: "YOU WIN", color: "#fbbf24" };
    setTimeout(() => { if (view.banner?.text === "YOU WIN") view.banner = null; }, 2500);
    view.chime();
    for (const [angle, x] of [[60, 0], [120, 1]]) void confetti({ particleCount: 120, angle, spread: 60, startVelocity: 55, origin: { x, y: 0.85 }, colors: PARTY, disableForReducedMotion: true });
  }
  const cash = await me.betCash().catch(() => 0);
  const out = p.querySelector<HTMLButtonElement>("#cashout")!;
  out.hidden = cash === 0;
  out.textContent = `Withdraw ${(cash / 1e6).toFixed(2)} test-USDC`;
  out.onclick = () => guard(async () => {
    await track("sol", "WITHDRAW", "SOLANA", `${(cash / 1e6).toFixed(2)} tUSDC to Solana`, "from the rollup", me.withdrawBetCash(cash));
    out.hidden = true;
  });
  renderRail();
}

/** Quick play is over: sweep the bots' SOL back, celebrate, and put the play card back with the result on top. */
async function quickResult(b: BoardState, order: number[], mine: number, mineOwed: number, paid: boolean, bad: number[] | null, asset: string) {
  const stake = b.price.toNumber() * bought(b.balls, mine), net = mineOwed - stake, won = order[0] === mine;
  const verified = bad !== null && !bad.length;
  const trophy = b.trophy ? `<a href="https://explorer.solana.com/address/${asset}?cluster=devnet" target="_blank" rel="noopener noreferrer">${RARITY[b.trophy - 1]} trophy → ${nameOf(order[0])}</a>` : "";
  playCard("quick", "", `
    <div class="result ${won ? "won" : ""}">
      <span class="micro">Last round · #${order.indexOf(mine) + 1} of ${b.playersLen}${won ? " · you win" : ""}</span>
      <b class="num" id="payout">0</b>
      <span class="sub">${paid ? `staked ${sol(stake)} · net <b class="${net >= 0 ? "up" : ""}">${net >= 0 ? "+" : "−"}${sol(Math.abs(net))}</b>` : "free round: share of points"}</span>
      <span class="sub"><span class="ms ${verified ? "fill" : ""}">verified</span>${verified ? "Replay verified" : bad === null ? "Seed not revealed" : "Replay mismatch"}${trophy ? ` · ${trophy}` : ""}</span>
    </div>`);
  const payout = overlay.querySelector<HTMLElement>("#payout")!;
  payout.dataset.v = "0";
  countTo(payout, mineOwed, (v) => (paid ? sol(Math.round(v)) : `${Math.round(v)}%`), 0.9);
  if (b.trophy) card("win", "TROPHY", "SOLANA", `${RARITY[b.trophy - 1]} trophy → ${nameOf(order[0])}`, "Metaplex Core")("seen", "", undefined, `https://explorer.solana.com/address/${asset}?cluster=devnet`);
  if (won) {
    view.banner = { text: "YOU WIN", color: "#fbbf24" };
    setTimeout(() => { if (view.banner?.text === "YOU WIN") view.banner = null; }, 2500);
    view.chime();
    for (const [angle, x] of [[60, 0], [120, 1]]) void confetti({ particleCount: 120, angle, spread: 60, startVelocity: 55, origin: { x, y: 0.85 }, colors: PARTY, disableForReducedMotion: true });
  }
  renderRail();
  const keys = bots.map((x) => x.p.kp);
  if (keys.length) await track("sol", "SWEEP", "SOLANA", "Bots' SOL back to you", `${keys.length} bots, one tx`, sweep(me.base, keys, me.pk)).catch(() => "");
  await refreshBalance();
}

// ---------- spectator bets (MagicBlock ephemeral SPL tokens, gasless on the rollup) ----------
const winnerOf = (b: BoardState) => [...Array(b.playersLen).keys()].reduce((w, i) => (b.scores[i] > b.scores[w] ? i : w), 0);

function renderBets(list: Element | null) {
  if (!list || !board) return;
  const b = board;
  list.innerHTML = b.bets.slice(0, b.betsLen).map((x) => `
    <li><span class="dot" style="background:${COLORS[x.pick]}"></span><span><b>${nameOf(x.pick)}</b><small>${x.bettor.equals(me.kp.publicKey) ? "you" : short(x.bettor.toBase58())}</small></span>
    <span class="num">${(x.amount.toNumber() / 1e6).toFixed(0)} tUSDC</span></li>`).join("") || `<li class="empty micro">No bets yet</li>`;
}

let betPanelOpen = false;
async function showBetPanel() {
  if (betPanelOpen || !board) return;
  betPanelOpen = true;
  let amount = 10_000_000;
  const p = panel(`
    <span class="micro">You're watching</span>
    <h2 class="head">Back a <em class="t">player</em></h2>
    <p class="sub">Bet gasless test-USDC on who wins. Backers of the winner split the pool. Bets close when the dice roll.</p>
    <div class="cashrow"><span class="micro">Your tUSDC</span><b class="num" id="cash">…</b><button class="ghost cut" id="faucet">Get 100</button></div>
    <span class="micro">Stake</span>
    <div class="seg three" id="amt"><button data-v="5" aria-pressed="false">5</button><button data-v="10" aria-pressed="true">10</button><button data-v="25" aria-pressed="false">25</button></div>
    <div class="picks" id="picks">${board.players.slice(0, board.playersLen).map((_, i) => `<button class="sec" data-pick="${i}" style="--pc:${COLORS[i]}">${nameOf(i)}</button>`).join("")}</div>
    <ol class="bets" id="bet-list"></ol>
    <p class="err" id="err"></p>`);
  const refresh = async () => { const el = p.querySelector("#cash"); if (el) el.textContent = `${((await me.betCash()) / 1e6).toFixed(2)}`; };
  void refresh();
  renderBets(p.querySelector("#bet-list"));
  p.querySelectorAll<HTMLButtonElement>("#amt button").forEach((btn) => (btn.onclick = () => {
    p.querySelectorAll("#amt button").forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
    amount = Number(btn.dataset.v) * 1e6;
  }));
  p.querySelector<HTMLButtonElement>("#faucet")!.onclick = () => guard(async () => {
    await needSol(0.01 * LAMPORTS_PER_SOL);
    const done = card("sol", "FAUCET", "SOLANA", "+100 tUSDC", "minted on Solana");
    const [minted, deposited] = await me.getBetCash().catch((e) => { done("failed"); throw e; });
    done("confirmed", minted);
    card("sol", "DEPOSIT", "SOLANA → ROLLUP", "100 tUSDC to the rollup", "ephemeral SPL")("confirmed", deposited);
    for (let i = 0; i < 20 && (await me.betCash()) === 0; i++) await sleep(500);
    await refresh();
    overlay.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = false));
  });
  p.querySelectorAll<HTMLButtonElement>("#picks button").forEach((btn) => (btn.onclick = () => guard(async () => {
    const pick = Number(btn.dataset.pick);
    if ((await me.betCash()) < amount) throw new Error("Not enough test-USDC on the rollup. Get some first.");
    await track("er", "BET", "ROLLUP", `${amount / 1e6} tUSDC on ${nameOf(pick)}`, "gasless", me.bet(id!, pick, amount));
    await refresh();
    overlay.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = false));
  })));
}

const hex = (u: Uint8Array) => Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("");

// ---------- table, board header, controls ----------
function nameOf(i: number) {
  if (!board) return "";
  const k = board.players[i];
  if (k.equals(me.pk)) return "You";
  const bot = bots.findIndex((x) => x.p.pk.equals(k));
  return bot >= 0 ? `Bot ${bot + 1}` : short(k.toBase58());
}

/** Eight seats, updated in place so point count-ups survive the 250 ms board updates. */
function renderTable(b: BoardState | null) {
  const list = $("players"), n = b?.playersLen ?? 0, mine = myIndex();
  if (list.children.length !== 8) {
    list.innerHTML = Array.from({ length: 8 }, () => `<li class="cut"><span class="who"><span class="nm"></span><span class="ms fill crown">emoji_events</span></span><span class="kit"></span><b class="num pts"></b></li>`).join("");
  }
  const lead = b && b.status === STATUS.LIVE ? winnerOf(b) : -1;
  [...list.children].forEach((li, i) => {
    const el = li as HTMLElement, q = (s: string) => el.querySelector(s) as HTMLElement;
    const filled = !!b && i < n;
    el.classList.toggle("open", !filled);
    el.classList.toggle("you", filled && i === mine);
    el.classList.toggle("lead", filled && i === lead && b!.scores[i] > 0);
    el.style.setProperty("--pc", filled ? COLORS[i] : "transparent");
    q(".nm").textContent = filled ? nameOf(i) : "Open seat";
    if (!filled) { q(".kit").textContent = ""; q(".pts").textContent = ""; delete q(".pts").dataset.v; return; }
    const left = b!.balls.slice(i * BALLS, i * BALLS + BALLS).filter((x) => x.state === BALL.IN_HAND || x.state === BALL.QUEUED).length;
    q(".kit").textContent = `${"●".repeat(left)}${"○".repeat(bought(b!.balls, i) - left)}`;
    countTo(q(".pts"), b!.scores[i] / 10, (v) => v.toFixed(1));
  });
  $("seats").textContent = `${n}/8`;
}

function renderRail() {
  const b = board;
  const pill = $("status");
  const keys = ["lobby", "rolling", "live", "over"], names = ["Lobby", "Rolling dice", "Live", "Over"];
  pill.textContent = b ? names[b.status] : "No round";
  pill.dataset.s = b ? keys[b.status] : "none";
  const pot = $("pot"), lamports = b ? b.pot.toNumber() : 0;
  if (!b) { pot.textContent = "–"; delete pot.dataset.v; }
  else if (!lamports) { pot.textContent = "FREE"; delete pot.dataset.v; }
  else countTo(pot, lamports, (v) => sol(Math.round(v)));
  $("tick").textContent = b && b.status >= STATUS.LIVE ? String(b.tick) : "–";
  $("window").textContent = b && b.status === STATUS.LIVE ? (b.tick < DROP_TICKS ? `${((DROP_TICKS - b.tick) / 4).toFixed(0)}s` : "auto") : "–";
  renderTable(b);
  const i = myIndex();
  const drop = $("drop") as HTMLButtonElement;
  if (b && i >= 0) {
    const inHand = b.balls.slice(i * BALLS, i * BALLS + BALLS).filter((x) => x.state === BALL.IN_HAND).length;
    drop.disabled = inHand === 0 || b.status !== STATUS.LIVE;
    $("drop-label").textContent = inHand ? `Drop ball · ${inHand} left` : "All balls dropped";
    $("pips").style.setProperty("--pc", COLORS[i]);
    $("pips").innerHTML = Array.from({ length: bought(b.balls, i) }, (_, k) => `<i class="${k < inHand ? "" : "off"}"></i>`).join("");
    $("hint").textContent = quick ? "Your balls drop by themselves, one every half second." : "Press Space or the button to drop a ball.";
  }
}

// ---------- frame loop ----------
function frame(now: number) {
  view.draw(board, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const r = new URL(location.href).searchParams.get("r");
if (r && /^\d{6,20}$/.test(r)) openRound(new BN(r)).catch((e) => lobby(errText(e)));
else lobby();
