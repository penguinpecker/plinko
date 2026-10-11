// Browser wallets (Phantom, Backpack, Solflare…) through the Wallet Standard: no React, ~6 KB.
import { getWallets } from "@wallet-standard/app";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { Wallet } from "./chain";

type Std = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
const registry = getWallets();

/** Installed wallets that can sign Solana transactions. They register asynchronously. */
export function solanaWallets(): Std[] {
  return registry.get().filter((w) => w.chains.some((c) => c.startsWith("solana:")) && "solana:signTransaction" in w.features);
}
export const onWalletsChange = (cb: () => void) => registry.on("register", cb);

export async function connect(w: Std): Promise<Wallet & { name: string }> {
  const { accounts } = await (w.features["standard:connect"] as any).connect();
  const account = accounts[0];
  return {
    name: w.name,
    publicKey: new PublicKey(account.address),
    async signTransaction(tx: Transaction) {
      const [out] = await (w.features["solana:signTransaction"] as any).signTransaction({
        account,
        chain: "solana:devnet",
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      });
      return Transaction.from(out.signedTransaction);
    },
  };
}
