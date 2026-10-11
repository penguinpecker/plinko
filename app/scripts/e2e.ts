// One full round against real devnet + MagicBlock's devnet TEE rollup, exercising the whole stack:
// buy in (Solana) -> delegate with a sealing action -> rollup-only chat -> VRF seed -> crank-driven
// board (no client ticks) -> reveal + commit + Magic Action payout -> replay check.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { BN, Player, RARITY, STATUS, ata, boardPda, explorer, quote, seedPda, trophyPda, vaultPda, type BoardState } from "../src/chain";
import { BALLS, replay } from "../src/sim";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function until(p: Player, id: BN, ok: (b: BoardState) => boolean, what: string, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    const b = await p.fetchTee(id).catch(() => null);
    if (b && ok(b)) return b;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const funder = new Player(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))));
// the host plays like a Phantom user: a wallet that signs Solana txs, plus a session key for the rollup
const hostWallet = Keypair.generate();
const fakePhantom = { publicKey: hostWallet.publicKey, signTransaction: async (tx: Transaction) => (tx.partialSign(hostWallet), tx) };
const host = new Player(Keypair.generate(), fakePhantom);
const bot = new Player(Keypair.generate());
const fan = new Player(Keypair.generate()); // a spectator with test-USDC
const id = new BN(Date.now());
const q = await quote(25);
if (!q) throw new Error("price feed unreadable");
const deposit = new BN(Math.ceil(q.lamports * 1.25)); // 25% headroom; the program locks the real cost at start
log(`oracle: SOL $${q.usd.toFixed(2)}, $0.25 ball = ${q.lamports} lamports, deposit ${deposit.toString()}/ball`);

await funder.fund(host.pk, 0.1 * LAMPORTS_PER_SOL);
await funder.fund(fan.pk, 0.02 * LAMPORTS_PER_SOL);
log("funded host wallet", host.pk.toBase58(), "| session key", host.kp.publicKey.toBase58().slice(0, 8), "holds 0 SOL");
log("create + join + approve session key (one wallet signature)", explorer(await host.create(id, deposit, 25, 3))); // the host buys 3 balls, the bot 5
log("spectator: faucet + deposit 100 test-USDC to the rollup", (await fan.getBetCash()).map(explorer)[1]);
log("seat rival bot", explorer(await host.seatBot(id, bot.kp, deposit.toNumber() * BALLS + 0.003 * LAMPORTS_PER_SOL)));
log("delegate board + seed with sealing actions", explorer(await host.delegate(id)));
await host.waitOnTee(boardPda(id));
const owner = (await host.base.getAccountInfo(seedPda(id)))?.owner.toBase58();
log("board on rollup; seed owner on Solana", owner, "| permissions created on arrival [board, seed]:", await host.sealedOnArrival(id));
log("open chat (+ any missing permission); sealed by the delegation actions alone?", await host.sealPermissions(id));
const peek = await (await bot.teeConn()).getAccountInfo(seedPda(id)).catch((e) => `error: ${e.message}`);
log("can a player read the seed?", peek === null || typeof peek === "string" ? `no (${peek ?? "null"})` : "YES (leak!)");

await host.say(id, "gl hf");
await bot.say(id, "your balls are mine");
await sleep(800);
const chat = await bot.fetchChat(id);
log("rollup-only chat:", chat?.msgs.slice(0, chat.head).map((m) => `${m.seat}: ${Buffer.from(m.text.slice(0, m.len)).toString()}`));

for (let i = 0; i < 20 && (await fan.betCash()) === 0; i++) await sleep(500);
log("spectator test-USDC on the rollup:", (await fan.betCash()) / 1e6);
await fan.bet(id, 0, 30_000_000);
await fan.bet(id, 1, 20_000_000);
log("spectator bet 30 on the host, 20 on the bot (gasless); left on rollup:", (await fan.betCash()) / 1e6);

const vrfAt = Date.now();
await host.start(id);
let b = await until(host, id, (x) => x.status === STATUS.LIVE, "fair dice", 30_000);
log(`dice landed in ${Date.now() - vrfAt} ms; board LIVE; ball cost locked at ${b.ballCost.toString()} lamports by the oracle`);
log("arm crank", await host.arm(id));

const unsub = await host.subscribe(id, (x) => (b = x));
for (let i = 0; i < 3; i++) await host.drop(id);
for (const [row, peg, dir] of [[4, 2, 0], [6, 3, 1], [8, 4, 0]]) await bot.bumper(id, row, peg, dir);
await sleep(3000);
for (let i = 0; i < BALLS; i++) await bot.drop(id);
const tickAt = b.tick;
await sleep(2000);
log(`crank alone moved the board ${b.tick - tickAt} ticks in 2 s (no client ticks sent)`);
for (const end = Date.now() + 90_000; b.status === STATUS.LIVE && Date.now() < end; ) await sleep(200);
unsub();
b = (await host.fetchTee(id))!;
log(`round over at tick ${b.tick}: scores`, b.scores.slice(0, 2), "golden", b.golden, "bumper hits", b.bumpers.slice(3, 6).map((m) => m.hit));

const fanBefore = await fan.betCash();
log("settle bets", await host.settleBets(b));
await sleep(1000);
log(`spectator rollup balance ${fanBefore / 1e6} -> ${(await fan.betCash()) / 1e6} test-USDC (winner was seat ${b.scores[0] >= b.scores[1] ? 0 : 1})`);
const before = [await host.base.getBalance(host.pk), await host.base.getBalance(bot.pk)];
log("finish: close chat, reveal, commit, Magic Action payout", await host.finish(id));
let onBase: BoardState | null = null;
for (const end = Date.now() + 60_000; Date.now() < end; await sleep(1500)) {
  const r = await host.fetchBase(id);
  if (r && !r.delegated && r.board.status === STATUS.OVER) { onBase = r.board; break; }
}
if (!onBase) throw new Error("round never came back to Solana");
const after = [await host.base.getBalance(host.pk), await host.base.getBalance(bot.pk)];
log("back on Solana; paid bits", onBase.paid.toString(2), "vault left", await host.base.getBalance(vaultPda(id)));
log("auto-payouts (SOL)", after.map((a, i) => (a - before[i]) / LAMPORTS_PER_SOL), "pot", onBase.pot.toNumber() / LAMPORTS_PER_SOL);
const bad = replay(Uint8Array.from(onBase.seed), onBase.playersLen, onBase.balls, onBase.bumpers);
log("replay", bad.length ? `MISMATCH at ${bad}` : "matches every bounce");
const asset = await host.base.getAccountInfo(trophyPda(id));
log("trophy:", onBase.trophy ? `${RARITY[onBase.trophy - 1]} minted, asset ${trophyPda(id).toBase58()} (${asset?.data.length} bytes, owner ${asset?.owner.toBase58().slice(0, 6)})` : "none");

const cash = await fan.betCash();
log("spectator withdraws", cash / 1e6, "test-USDC to Solana", explorer(await fan.withdrawBetCash(cash)));
await sleep(2500);
const tok = await fan.base.getTokenAccountBalance(ata(fan.kp.publicKey)).catch(() => null);
log("spectator Solana token balance:", tok?.value.uiAmount);
