// One-time per program id: create Peg War's devnet test-USDC (mint authority = the program's
// ["mint-auth"] PDA, so only its faucet mints) and MagicBlock's global vault for it on the TEE.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, Player, TUSDC } from "../src/chain";

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const admin = new Player(load(`${homedir()}/.config/solana/id.json`));
const mint = load(new URL("../../target/deploy/tusdc-mint-keypair.json", import.meta.url).pathname);
if (!mint.publicKey.equals(TUSDC)) throw new Error("mint keypair doesn't match TUSDC in chain.ts");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const mintAuth = PublicKey.findProgramAddressSync([Buffer.from("mint-auth")], PROGRAM_ID)[0];

if (!(await admin.base.getAccountInfo(TUSDC))) {
  const space = 82;
  const create = SystemProgram.createAccount({
    fromPubkey: admin.pk, newAccountPubkey: TUSDC, space, programId: TOKEN,
    lamports: await admin.base.getMinimumBalanceForRentExemption(space),
  });
  // InitializeMint2: tag 20, decimals 6, mint authority, no freeze authority
  const init = new TransactionInstruction({
    programId: TOKEN,
    keys: [{ pubkey: TUSDC, isSigner: false, isWritable: true }],
    data: Buffer.concat([Buffer.from([20, 6]), mintAuth.toBuffer(), Buffer.from([0])]),
  });
  console.log("mint created", await admin.sendBase([create, init], [mint]));
}
// the very first deposit for a mint also creates MagicBlock's global vault for it
console.log("faucet + first deposit (creates the vault)", await admin.getBetCash(1_000_000n, true));
