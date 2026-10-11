import { defineConfig } from "vite";
import { faucet } from "./server/faucet";

export default defineConfig({
  plugins: [faucet()],
  // The MagicBlock SDK lazy-imports bs58 inside getAuthToken; pre-bundle it with the rest.
  optimizeDeps: {
    include: ["bs58", "buffer", "@coral-xyz/anchor", "@solana/web3.js", "@magicblock-labs/ephemeral-rollups-sdk", "tweetnacl", "@noble/hashes/sha2"],
  },
  define: { "process.env": {}, global: "globalThis" },
});
