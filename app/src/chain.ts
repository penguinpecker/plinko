// Everything that talks to Solana devnet and MagicBlock's private rollup (devnet TEE).
// Used by the browser game and by scripts/e2e.ts.
import * as A from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  ConnectionMagicRouter,
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  delegateSpl,
  ensureMagicAtaDestinationIx,
  getAuthToken,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import idl from "./idl/pegwar.json";
import gplIdl from "./idl/gpl_session.json";
import type { Ball, Bumper } from "./sim";

// Anchor ships CommonJS; Node puts it under `default`, Vite does not.
const { AnchorProvider, BN, Program } = ((A as any).default ?? A) as typeof A;
export { BN };

export const BASE_RPC = "https://rpc.magicblock.app/devnet";
export const TEE_RPC = "https://devnet-tee.magicblock.app";
export const TEE_WS = "wss://devnet-tee.magicblock.app";
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const PROGRAM_ID = new PublicKey(idl.address);

export const STATUS = { OPEN: 0, ROLLING: 1, LIVE: 2, OVER: 3 } as const;
/** Plinko's devnet test-USDC for spectator bets (6 decimals, minted by the program's faucet). */
export const TUSDC = new PublicKey("FmZj181DPGvcRejrW9TQVxMxTTMneGjKb2t39cys9Zc4");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const GPL_SESSION = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
export const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), TUSDC.toBuffer()], ATA_PROGRAM)[0];
/** MagicBlock's real-time SOL/USD feed: live on every rollup, readable without an auth token. */
export const SOL_USD_FEED = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
export const RARITY = ["Common", "Rare", "Epic", "Legendary"];
const publicTee = new Connection(TEE_RPC, "confirmed");

/** Checks the private rollup's Intel TDX attestation quote before trusting it with the seed. */
export const attestTee = () => verifyTeeRpcIntegrity(TEE_RPC).then(() => true, () => false);

/** Ask MagicBlock's Magic Router which rollup holds an account right now. */
const router = new ConnectionMagicRouter("https://devnet-router.magicblock.app", "confirmed");
export async function whereIs(account: PublicKey): Promise<string | null> {
  const r = (await router.getDelegationStatus(account).catch(() => null)) as { isDelegated: boolean; fqdn?: string } | null;
  return r?.isDelegated ? (r.fqdn ?? "a rollup").replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
}

/** Live SOL/USD from the oracle, and the lamports `cents` buys right now. Same maths as the program. */
export async function quote(cents: number): Promise<{ usd: number; lamports: number } | null> {
  const info = await publicTee.getAccountInfo(SOL_USD_FEED).catch(() => null);
  if (!info || info.data.length < 101) return null;
  const v = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const price = v.getBigInt64(73, true), expo = Math.abs(v.getInt32(89, true));
  if (price <= 0n) return null;
  const num = BigInt(cents) * 1_000_000_000n * 10n ** BigInt(expo), den = price * 100n;
  return { usd: Number(price) / 10 ** expo, lamports: Number((num + den - 1n) / den) };
}

export interface BoardState {
  id: BN; host: PublicKey; price: BN; usdCents: number; ballCost: BN; pot: BN; status: number; paid: number;
  playersLen: number; players: PublicKey[]; scores: number[]; nextRelease: number[];
  balls: Ball[]; bumpers: Bumper[]; bets: { bettor: PublicKey; pick: number; amount: BN }[]; betsLen: number; betTotal: BN; betsPaid: boolean; tick: number; landed: number; startSlot: BN; armed: boolean; trophy: number; golden: number[]; seed: number[];
}

const enc = (n: BN) => n.toArrayLike(Buffer, "le", 8);
export const boardPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("board"), enc(id)], PROGRAM_ID)[0];
export const seedPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("seed"), enc(id)], PROGRAM_ID)[0];
export const vaultPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("vault"), enc(id)], PROGRAM_ID)[0];
export const trophyPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("trophy"), enc(id)], PROGRAM_ID)[0];
const trophyFundPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("trophy_fund"), enc(id)], PROGRAM_ID)[0];
export const chatPda = (id: BN) => PublicKey.findProgramAddressSync([Buffer.from("chat"), boardPda(id).toBuffer()], PROGRAM_ID)[0];
/** Where the Board pays its commit + Magic Action fees on the TEE validator. */
export const MAGIC_FEE_VAULT = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DELEGATION_PROGRAM_ID)[0];

export interface ChatMsg { seat: number; len: number; text: number[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A browser wallet (Phantom, Backpack…) that only signs Solana transactions. */
export interface Wallet {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

/** One person at the table. `kp` is a browser key: the whole wallet in burner mode, or a
 * MagicBlock session key the `wallet` approved once, which then signs every rollup move. */
export class Player {
  readonly base = new Connection(BASE_RPC, "confirmed");
  readonly program: Program;
  private tee: Connection | null = null;
  private teeExpiry = 0;
  private hash: { value: string; at: number } | null = null;
  private nonce = 0;

  private gpl: Program;

  constructor(readonly kp: Keypair, readonly wallet?: Wallet) {
    const stub = {
      publicKey: kp.publicKey,
      signTransaction: async <T>(tx: T) => tx,
      signAllTransactions: async <T>(txs: T[]) => txs,
    };
    const provider = new AnchorProvider(this.base, stub as never, {});
    this.program = new Program(idl as never, provider);
    this.gpl = new Program(gplIdl as never, provider);
  }

  /** The seat's wallet: the connected wallet, or the burner itself. */
  get pk() {
    return this.wallet?.publicKey ?? this.kp.publicKey;
  }

  get sessionToken() {
    return this.wallet
      ? PublicKey.findProgramAddressSync([Buffer.from("session_token_v2"), PROGRAM_ID.toBuffer(), this.kp.publicKey.toBuffer(), this.pk.toBuffer()], GPL_SESSION)[0]
      : null;
  }

  /** Accounts every move needs: who signs, whose seat, and the session that links them. */
  private actor() {
    return { signer: this.kp.publicKey, player: this.pk, sessionToken: this.sessionToken };
  }

  /** One wallet approval: lets this browser key sign moves for the wallet for 2 hours (wallet mode only). */
  private async sessionIx(): Promise<TransactionInstruction[]> {
    if (!this.wallet) return [];
    const existing = await this.base.getAccountInfo(this.sessionToken!).catch(() => null);
    if (existing) return [];
    const ix = await this.gpl.methods
      .createSessionV2(false, new BN(Math.floor(Date.now() / 1000) + 2 * 3600), null)
      .accountsPartial({
        sessionToken: this.sessionToken!,
        sessionSigner: this.kp.publicKey,
        feePayer: this.pk,
        authority: this.pk,
        targetProgram: PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return [ix];
  }

  /** Rollup connection carrying this player's auth token (signed by the burner, no popup). */
  async teeConn(): Promise<Connection> {
    if (this.tee && Date.now() < this.teeExpiry - 60_000) return this.tee;
    const auth = await getAuthToken(TEE_RPC, this.kp.publicKey, async (m) => nacl.sign.detached(m, this.kp.secretKey));
    this.teeExpiry = auth.expiresAt > 1e12 ? auth.expiresAt : auth.expiresAt * 1000;
    this.tee = new Connection(`${TEE_RPC}?token=${auth.token}`, {
      wsEndpoint: `${TEE_WS}?token=${auth.token}`,
      commitment: "confirmed",
    });
    return this.tee;
  }

  /** Solana transaction paid by the seat's wallet. With a browser wallet it signs first (one
   * popup), then any extra keys co-sign, as Phantom asks for multi-signer transactions. */
  async sendBase(ixs: TransactionInstruction[], extra: Keypair[] = []): Promise<string> {
    let tx = new Transaction().add(...ixs);
    tx.feePayer = this.pk;
    tx.recentBlockhash = (await this.base.getLatestBlockhash()).blockhash;
    const needs = (k: Keypair) => tx.compileMessage().accountKeys.some((a, i) => a.equals(k.publicKey) && tx.compileMessage().isAccountSigner(i));
    if (this.wallet) {
      tx = await this.wallet.signTransaction(tx);
      const co = extra.filter(needs);
      if (co.length) tx.partialSign(...co);
    } else tx.sign(this.kp, ...extra.filter((k) => !k.publicKey.equals(this.kp.publicKey) && needs(k)));
    const sig = await this.base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await confirm(this.base, sig);
    return sig;
  }

  /** Send on the rollup. `wait=false` fires and forgets (drops, bumpers, heartbeats). The compute
   * limit doubles as a nonce: identical heartbeats would otherwise be dropped as already processed. */
  async sendTee(ixs: TransactionInstruction[], wait = true): Promise<string> {
    const conn = await this.teeConn();
    if (!this.hash || Date.now() - this.hash.at > 15_000) {
      this.hash = { value: (await conn.getLatestBlockhash()).blockhash, at: Date.now() };
    }
    const nonce = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 - (this.nonce++ % 100_000) });
    const tx = new Transaction().add(nonce, ...ixs);
    tx.feePayer = this.kp.publicKey; // the rollup charges no fees, so a 0-SOL session key can pay
    tx.recentBlockhash = this.hash.value;
    tx.sign(this.kp);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    if (wait) await confirm(conn, sig);
    return sig;
  }

  /** `seal`: a delegation action creates the read permission the moment the account lands on the rollup. */
  private delegateIx(account: object, pda: PublicKey, seal: boolean) {
    return this.program.methods.delegatePda(account as never, seal).accountsPartial({ payer: this.pk, pda }).instruction();
  }

  private joinIx(id: BN, player: PublicKey, balls: number) {
    return this.program.methods.join(id, balls).accountsPartial({ board: boardPda(id), vault: vaultPda(id), player }).instruction();
  }

  // ---------- Solana ----------

  /** Open a round and take the first seat. `usdCents` > 0 prices balls in dollars, locked from the
   * oracle at start; `depositPerBall` is the SOL each player puts down (the cap). `balls` is 1..5.
   * `bots` (page-controlled rivals, each funded with `botFund` lamports) are seated in the same transaction. */
  async create(id: BN, depositPerBall: BN, usdCents = 0, balls = 5, bots: Keypair[] = [], botFund = 0) {
    const create = await this.program.methods
      .createRound(id, depositPerBall, usdCents)
      .accountsPartial({ board: boardPda(id), seed: seedPda(id), trophyFund: trophyFundPda(id), host: this.pk })
      .instruction();
    const seat = await Promise.all(bots.map(async (b) => [
      SystemProgram.transfer({ fromPubkey: this.pk, toPubkey: b.publicKey, lamports: botFund }),
      await this.joinIx(id, b.publicKey, balls),
    ]));
    return this.sendBase([...(await this.sessionIx()), create, await this.joinIx(id, this.pk, balls), ...seat.flat()], [this.kp, ...bots]);
  }

  async join(id: BN, balls = 5) {
    return this.sendBase([...(await this.sessionIx()), await this.joinIx(id, this.pk, balls)], [this.kp]);
  }

  /** Fund a page-controlled rival and seat it, in one transaction it co-signs. */
  async seatBot(id: BN, bot: Keypair, lamports: number, balls = 5) {
    const fund = SystemProgram.transfer({ fromPubkey: this.pk, toPubkey: bot.publicKey, lamports });
    return this.sendBase([fund, await this.joinIx(id, bot.publicKey, balls)], [bot]);
  }

  /** Lobby closed: hand the Board and the Seed to the private rollup, sealed on arrival. */
  async delegate(id: BN, seal = true) {
    return this.sendBase([
      await this.delegateIx({ board: { id } }, boardPda(id), seal),
      await this.delegateIx({ seed: { id } }, seedPda(id), seal),
    ]);
  }

  async cancel(b: BoardState) {
    const ix = await this.program.methods
      .cancel()
      .accountsPartial({ board: boardPda(b.id), vault: vaultPda(b.id), host: this.pk })
      .remainingAccounts(b.players.slice(0, b.playersLen).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
      .instruction();
    return this.sendBase([ix]);
  }

  /** Pay out everyone still unpaid, in one transaction. Anyone can send it. */
  async claimAll(b: BoardState) {
    const ixs = await Promise.all(
      b.players.slice(0, b.playersLen).flatMap((to, i) =>
        b.paid & (1 << i) ? [] : [this.program.methods.claim(i).accountsPartial({ board: boardPda(b.id), vault: vaultPda(b.id), to }).instruction()],
      ),
    );
    return ixs.length ? this.sendBase(ixs) : "";
  }

  // ---------- private rollup ----------

  async waitOnTee(pda: PublicKey, timeoutMs = 30_000) {
    const conn = await this.teeConn();
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(500)) {
      if (await conn.getAccountInfo(pda).catch(() => null)) return;
    }
    throw new Error("The rollup didn't pick up the round in time. Try again.");
  }

  private permissionIx(account: object, pda: PublicKey, members: [] | null) {
    return this.program.methods
      .initPermission(account as never, members as never)
      .accountsPartial({
        permissionedAccount: pda,
        permission: permissionPdaFromAccount(pda),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .instruction();
  }

  /** Did the delegation action already create both read permissions on the rollup? */
  async sealedOnArrival(id: BN) {
    const conn = await this.teeConn();
    const [perm, seed] = await conn.getMultipleAccountsInfo([permissionPdaFromAccount(boardPda(id)), seedPda(id)]);
    // the Board's permission is an Ephemeral Account (zero lamports): check its owner. The Seed's
    // permission is private like the Seed itself, so "sealed" means nobody can read the Seed.
    return [!!perm && perm.owner.equals(PERMISSION_PROGRAM_ID), seed === null];
  }

  /** Board readable by anyone with a rollup token; Seed readable by nobody. A no-op for any
   * permission the delegation action already created. Also opens the round's chat log. */
  async sealPermissions(id: BN) {
    await this.waitOnTee(boardPda(id));
    const [boardOk, seedOk] = await this.sealedOnArrival(id);
    await this.sendTee([
      ...(boardOk ? [] : [await this.permissionIx({ board: { id } }, boardPda(id), null)]),
      ...(seedOk ? [] : [await this.permissionIx({ seed: { id } }, seedPda(id), [])]),
      await this.program.methods.openChat().accountsPartial({ payer: this.kp.publicKey, board: boardPda(id), chat: chatPda(id) }).instruction(),
    ]);
    return boardOk && seedOk;
  }

  async start(id: BN) {
    const ix = await this.program.methods
      .start(Math.floor(Math.random() * 256))
      .accountsPartial({ payer: this.kp.publicKey, player: this.pk, sessionToken: this.sessionToken, board: boardPda(id), seed: seedPda(id), priceFeed: SOL_USD_FEED, oracleQueue: VRF_QUEUE })
      .instruction();
    return this.sendTee([ix]);
  }

  async drop(id: BN) {
    const ix = await this.program.methods.dropBall().accountsPartial({ board: boardPda(id), seed: seedPda(id), ...this.actor() }).instruction();
    return this.sendTee([ix], false).catch(() => "");
  }

  async bumper(id: BN, row: number, peg: number, dir: number) {
    const ix = await this.program.methods
      .placeBumper(row, peg, dir)
      .accountsPartial({ board: boardPda(id), seed: seedPda(id), ...this.actor() })
      .instruction();
    return this.sendTee([ix], false).catch(() => "");
  }

  /** Hand ticking to MagicBlock's crank: the rollup itself runs `tick` every 250 ms. */
  async arm(id: BN) {
    const ix = await this.program.methods.arm().accountsPartial({ board: boardPda(id), seed: seedPda(id) }).instruction();
    return this.sendTee([ix]);
  }

  async say(id: BN, text: string) {
    const bytes = Buffer.from(text, "utf8").subarray(0, 48);
    const ix = await this.program.methods.say(bytes).accountsPartial({ ...this.actor(), board: boardPda(id), chat: chatPda(id) }).instruction();
    return this.sendTee([ix], false).catch(() => "");
  }

  // ---------- spectator bets in test-USDC (MagicBlock ephemeral SPL tokens) ----------

  /** 100 test-USDC from the faucet, then deposited onto the private rollup, ready to bet. */
  async getBetCash(amount = 100_000_000n, initVault = false) {
    const createAta = new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: this.pk, isSigner: true, isWritable: true },
        { pubkey: ata(this.kp.publicKey), isSigner: false, isWritable: true },
        { pubkey: this.kp.publicKey, isSigner: false, isWritable: false },
        { pubkey: TUSDC, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // CreateIdempotent
    });
    const faucet = await this.program.methods.faucet().accountsPartial({ mint: TUSDC, to: ata(this.kp.publicKey) }).instruction();
    const minted = await this.sendBase([createAta, faucet]);
    const deposit = await delegateSpl(this.kp.publicKey, TUSDC, amount, { validator: TEE_VALIDATOR, payer: this.pk, initVaultIfMissing: initVault });
    return [minted, await this.sendBase(deposit, [this.kp])];
  }

  /** My test-USDC on the rollup (only I can read it: token accounts there are private to their owner). */
  async betCash(): Promise<number> {
    const info = await (await this.teeConn()).getAccountInfo(ata(this.kp.publicKey)).catch(() => null);
    return info && info.data.length >= 72 ? Number(info.data.readBigUInt64LE(64)) : 0;
  }

  async bet(id: BN, pick: number, amount: number) {
    const ensurePot = ensureMagicAtaDestinationIx(this.kp.publicKey, boardPda(id), TUSDC);
    const ix = await this.program.methods
      .placeBet(pick, new BN(amount))
      .accountsPartial({ bettor: this.kp.publicKey, board: boardPda(id), from: ata(this.kp.publicKey), pot: ata(boardPda(id)), tokenProgram: TOKEN_PROGRAM })
      .instruction();
    return this.sendTee([ensurePot, ix]);
  }

  async settleBets(b: BoardState) {
    const ix = await this.program.methods
      .settleBets()
      .accountsPartial({ board: boardPda(b.id), pot: ata(boardPda(b.id)), tokenProgram: TOKEN_PROGRAM })
      .remainingAccounts(b.bets.slice(0, b.betsLen).map((x) => ({ pubkey: ata(x.bettor), isSigner: false, isWritable: true })))
      .instruction();
    return this.sendTee([ix]);
  }

  /** Bring test-USDC from the rollup back to a normal Solana token account. */
  async withdrawBetCash(amount: number) {
    const ixs = await withdrawSpl(this.kp.publicKey, TUSDC, BigInt(amount), { validator: TEE_VALIDATOR, payer: this.pk });
    return this.sendBase(ixs, [this.kp]);
  }

  async fetchChat(id: BN): Promise<{ head: number; msgs: ChatMsg[] } | null> {
    const info = await (await this.teeConn()).getAccountInfo(chatPda(id)).catch(() => null);
    return info ? (this.program.coder.accounts.decode("chat", info.data) as { head: number; msgs: ChatMsg[] }) : null;
  }

  async tick(id: BN) {
    const ix = await this.program.methods.tick().accountsPartial({ board: boardPda(id), seed: seedPda(id) }).instruction();
    return this.sendTee([ix], false).catch(() => "");
  }

  async abort(id: BN) {
    const ix = await this.program.methods.abort().accountsPartial({ board: boardPda(id), seed: seedPda(id) }).instruction();
    return this.sendTee([ix]);
  }

  /** Close the chat, reveal the seed, commit back to Solana and pay everyone via a Magic Action. */
  async finish(id: BN) {
    const close = await this.program.methods.closeChat().accountsPartial({ payer: this.kp.publicKey, board: boardPda(id), chat: chatPda(id) }).instruction();
    const fin = await this.program.methods
      .finish()
      .accountsPartial({ board: boardPda(id), seed: seedPda(id), vault: vaultPda(id), magicFeeVault: MAGIC_FEE_VAULT, magicContext: MAGIC_CONTEXT_ID })
      .instruction();
    const hasChat = !!(await (await this.teeConn()).getAccountInfo(chatPda(id)).catch(() => null));
    return this.sendTee(hasChat ? [close, fin] : [fin]);
  }

  /** Fallback: plain commit paid by this wallet; payouts then go through `claimAll`. */
  async finishManual(id: BN) {
    const ix = await this.program.methods.finishManual().accountsPartial({ payer: this.kp.publicKey, board: boardPda(id), seed: seedPda(id) }).instruction();
    return this.sendTee([ix]);
  }

  // ---------- reads ----------

  decode(data: Buffer): BoardState {
    return this.program.coder.accounts.decode("board", data) as BoardState;
  }

  async fetchTee(id: BN): Promise<BoardState | null> {
    const info = await (await this.teeConn()).getAccountInfo(boardPda(id));
    return info ? this.decode(info.data) : null;
  }

  /** Base-layer copy. `delegated` = the round is out on the rollup right now. */
  async fetchBase(id: BN): Promise<{ board: BoardState; delegated: boolean } | null> {
    const info = await this.base.getAccountInfo(boardPda(id));
    return info ? { board: this.decode(info.data), delegated: !info.owner.equals(PROGRAM_ID) } : null;
  }

  async subscribe(id: BN, cb: (b: BoardState) => void): Promise<() => void> {
    const conn = await this.teeConn();
    const sub = conn.onAccountChange(boardPda(id), (info) => cb(this.decode(info.data)), { commitment: "processed" });
    return () => void conn.removeAccountChangeListener(sub);
  }

  async fund(to: PublicKey, lamports: number) {
    return this.sendBase([SystemProgram.transfer({ fromPubkey: this.pk, toPubkey: to, lamports })]);
  }
}

async function confirm(conn: Connection, sig: string, timeoutMs = 60_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(400)) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value[0];
    if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)} (${sig})`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
  }
  throw new Error(`Transaction not confirmed in time (${sig})`);
}

export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
/** A rollup transaction in Solana Explorer, read straight from the TEE RPC (no auth token in the URL, ever). */
export const erExplorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(TEE_RPC)}`;
/** Send page-controlled bots' SOL (stake refunds + winnings) back to `to` in one transaction; the first bot pays the fee. */
export async function sweep(conn: Connection, bots: Keypair[], to: PublicKey) {
  const bals = await Promise.all(bots.map((b) => conn.getBalance(b.publicKey)));
  bals[0] -= 5000 * bots.length; // the fee: one signature per bot
  const ixs = bots.flatMap((b, i) => (bals[i] > 0 ? [SystemProgram.transfer({ fromPubkey: b.publicKey, toPubkey: to, lamports: bals[i] })] : []));
  if (!ixs.length || bals[0] < 0) return "";
  const tx = new Transaction().add(...ixs);
  tx.feePayer = bots[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...bots);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await confirm(conn, sig);
  return sig;
}
