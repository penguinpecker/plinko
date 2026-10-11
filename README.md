# Plinko

Multiplayer Plinko on Solana, played on MagicBlock's private Ephemeral Rollup.
Pick a bet, pick how many balls, press **Play**. Everything after that signs itself.

**Play it:** https://plinko-sigma-six.vercel.app (Solana devnet; you get free test SOL on your first visit)

![A Plinko round in progress](docs/screenshot.png)

| | |
|---|---|
| Program (devnet) | [`Hh2cvEwnqDV995Fkp4yaagjTnrVvmsy7TybiKoJTQNin`](https://explorer.solana.com/address/Hh2cvEwnqDV995Fkp4yaagjTnrVvmsy7TybiKoJTQNin?cluster=devnet) |
| Private rollup | MagicBlock TEE, `https://devnet-tee.magicblock.app` (validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`) |
| Test USDC mint | `FmZj181DPGvcRejrW9TQVxMxTTMneGjKb2t39cys9Zc4` (used for spectator bets) |

## How a round plays

1. Choose a bet per ball (free, 0.01, 0.05 or 0.1 SOL) and 1 to 5 balls.
2. Press **Play**. A wallet is created in your browser and topped up with devnet SOL. Three bots take seats with the same stake.
3. Your balls drop on their own, one every half second, through 12 rows of pegs.
4. The outer bins score the most (33 points) and the centre bins the least (0.3). One peg is secretly golden: the first ball to touch it scores double.
5. When every ball has landed, the pot is split by points and paid out automatically. The top scorer also gets a trophy NFT.

To play against real people instead, **Play with friends** opens a lobby with an invite link, a table chat and betting for spectators.

## What happens on-chain

1. **Buy in on Solana.** One transaction creates the table, seats you, and seats and funds the three bots. All stakes go into the round's vault.
2. **Move to the private rollup.** The board and a separate seed account are delegated to MagicBlock's TEE rollup. The seed is sealed as it arrives, so nobody, not even the host, can read it.
3. **Roll the dice.** MagicBlock VRF returns randomness in about a quarter of a second. The program turns it into every ball's path and the hidden golden peg, and writes them into the sealed seed.
4. **Drop.** Drops run on the rollup in milliseconds with no wallet popups. A MagicBlock scheduled task moves the board forward every 250 ms, so no player has to keep it running. The board is only ever simulated up to the current moment, so you can't simulate a transaction to see where a ball will land.
5. **Settle on Solana.** When the last ball lands, the seed is revealed onto the board, and the board is committed and handed back to Solana. A Magic Action then runs the payout in the same flow: points share to every player and the winner's trophy mint.
6. **Verify.** Your browser replays the whole round from the revealed seed, using a TypeScript copy of the on-chain rules, and checks that every ball landed where the chain says it did.

Every transaction shows up in the strip at the top of the page with an Explorer link. Rollup transactions open in Solana Explorer pointed at the TEE's RPC; Explorer asks once before connecting to it.

## MagicBlock features used

| Feature | What it does here |
|---|---|
| Private Ephemeral Rollup (TEE) | Runs the round. The board is public; the seed is unreadable until the end. |
| Permissions / access control | Set by a post-delegation action, so the seed is sealed the moment it lands on the rollup. |
| VRF | Fair randomness for every ball path and the golden peg (`start` → `seed_board`). |
| Scheduled tasks | The crank that advances the board every 250 ms (`arm` → `tick`). |
| Magic Actions | `payout` runs right after commit and undelegate. |
| Ephemeral accounts | A table chat that lives only on the rollup and is closed before commit. |
| Session keys | With Phantom you approve once; a browser key then signs every move. |
| Ephemeral SPL tokens | Spectator bets in test USDC (friends mode). |
| Price oracle | SOL/USD read on the rollup to show your stake in dollars. |
| Magic Router | Finds which rollup holds the board. |
| TEE attestation | The badge in the top bar checks the rollup is running in a genuine Intel TDX enclave. |

The trophy is a Metaplex Core NFT; its rarity (Common, Rare, Epic, Legendary) also comes from the seed.

## Repo layout

```
programs/pegwar/          Anchor program (crate name `pegwar`, the game's working title)
  src/lib.rs              buy-in, delegation, VRF, drops, crank, chat, bets, finish + payout
  src/sim.rs              the referee: deterministic board simulation, with unit tests
app/                      web app (Vite + TypeScript)
  src/main.ts             screens and the one-click round
  src/chain.ts            every Solana and MagicBlock call
  src/sim.ts              TypeScript copy of sim.rs, used for the replay check
  src/board.ts            canvas board, sound and effects
  server/faucet.ts        devnet SOL faucet for new players
  api/fund.ts             the faucet as a Vercel function
  scripts/e2e.ts          plays one full round against devnet from the command line
  scripts/setup-tusdc.ts  one-time test USDC setup for a new program id
```

## Run it locally

Needs Node 22 or newer. The app talks to the deployed devnet program, so you don't have to build the program to play.

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

The local faucet signs with `FAUCET_KEY` (a keypair as a JSON byte array) or, if that's unset, `~/.config/solana/plinko-faucet.json`. It sends 0.5 devnet SOL to wallets holding less than 0.25, at most 5 times per IP per hour.

Play a full round from the terminal (uses `~/.config/solana/id.json`, which needs some devnet SOL):

```bash
cd app && npm run e2e
```

Run the program's unit tests:

```bash
cargo test -p pegwar
```

## Deploy your own program

Needs Rust, the Solana CLI and Anchor 1.2.1. MagicBlock's TEE doesn't pick up program upgrades, so every change ships under a new program id, with a new test USDC mint to match (the mint's authority is a PDA of the program).

```bash
solana-keygen new --no-bip39-passphrase -o target/deploy/pegwar-keypair.json
solana-keygen new --no-bip39-passphrase -o target/deploy/tusdc-mint-keypair.json
# put the two new addresses in programs/pegwar/src/lib.rs (declare_id!, TUSDC),
# Anchor.toml, and TUSDC in app/src/chain.ts
anchor build --arch v1
solana program deploy target/deploy/pegwar.so --program-id target/deploy/pegwar-keypair.json -u devnet
cp target/idl/pegwar.json app/src/idl/
cd app && npx tsx scripts/setup-tusdc.ts
```

## Hosting

The app runs on Vercel with `app` as the root directory. Set `FAUCET_KEY` as a sensitive environment variable holding a funded devnet keypair. Keep the `uuid` override in `app/package.json`: without it the faucet function fails to load on Vercel.

## Notes

- Devnet only. The SOL and test USDC here have no value.
- In quick play the bots are funded from your wallet and their payouts are swept back to you after the round, so you only spend network fees.
- The faucet's per-IP limit is kept in memory, so it resets when a server instance restarts.
