// Game faucet: Connect makes a wallet in the browser and this funds it with devnet SOL, so a new player can
// play at once. The funding key stays server-side: FAUCET_KEY (JSON byte array, on Vercel) or a local file.
// Served by the Vite dev server (`faucet()` below) and by Vercel (api/fund.ts).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Plugin } from "vite";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const GRANT = 0.5 * LAMPORTS_PER_SOL; // a 0.01 SOL x 5-ball quick round with 3 bots needs about 0.24
const TOP_UP_BELOW = 0.25 * LAMPORTS_PER_SOL;
const PER_IP_PER_HOUR = 5; // in-memory, per server instance; a shared store if it gets abused

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const hits = new Map<string, number[]>();
let funder: Keypair | null = null;
const loadFunder = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  process.env.FAUCET_KEY ?? readFileSync(`${homedir()}/.config/solana/plinko-faucet.json`, "utf8"),
)));

/** Fund `to` with GRANT unless it already has enough. Returns [http status, json body]. */
export async function fund(toParam: string | null, ip: string): Promise<[number, object]> {
  try {
    let to: PublicKey;
    try { to = new PublicKey(toParam ?? ""); } catch { return [400, { error: "Not a Solana address" }]; }
    if ((await conn.getBalance(to)) >= TOP_UP_BELOW) return [200, { sig: "", lamports: 0 }]; // already enough to play
    const now = Date.now(), recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= PER_IP_PER_HOUR) return [429, { error: "Faucet limit reached for this hour" }];
    funder ??= loadFunder();
    if ((await conn.getBalance(funder.publicKey)) < GRANT + 0.01 * LAMPORTS_PER_SOL) return [503, { error: "The game faucet is empty" }];
    hits.set(ip, [...recent, now]);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: GRANT }));
    return [200, { sig: await sendAndConfirmTransaction(conn, tx, [funder], { commitment: "confirmed" }), lamports: GRANT }];
  } catch (e) {
    return [500, { error: e instanceof Error ? e.message.slice(0, 160) : "Faucet failed" }];
  }
}

export function faucet(): Plugin {
  return {
    name: "plinko-faucet",
    configureServer(server) {
      server.middlewares.use("/api/fund", async (req, res) => {
        const [code, body] = req.method === "POST"
          ? await fund(new URL(req.url ?? "", "http://x").searchParams.get("to"), req.socket.remoteAddress ?? "?")
          : [405, { error: "POST only" }];
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
    },
  };
}
