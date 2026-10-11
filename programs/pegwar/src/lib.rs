use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_lang::InstructionData;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer as TokenTransfer};
use ephemeral_rollups_sdk::access_control::instructions::CreateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, EphemeralPermission, Member};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, ephemeral_accounts, vrf, vrf_callback};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::{delegate_account_with_actions, DelegateAccounts, DelegateConfig};
use ephemeral_rollups_sdk::dlp_api::compact::ClearText;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use mpl_core::instructions::CreateV2CpiBuilder;
use mpl_core::types::{Attribute, Attributes, Plugin, PluginAuthority, PluginAuthorityPair};
use ephemeral_rollups_sdk::vrf::instructions::{create_request_high_priority_scoped_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

pub mod sim;
use sim::{BALLS, MAX_BALLS, MAX_BUMPERS, MAX_PLAYERS};

declare_id!("Hh2cvEwnqDV995Fkp4yaagjTnrVvmsy7TybiKoJTQNin");

pub const BOARD_SEED: &[u8] = b"board";
pub const SEED_SEED: &[u8] = b"seed";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CHAT_SEED: &[u8] = b"chat";
pub const CHAT_SLOTS: usize = 24;
pub const MSG_LEN: usize = 48;
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const ACTION_ESCROW_INDEX: u8 = 255; // ActionArgs::new default
const ACTION_FEES: u64 = 3_000_000; // lamports the Board carries onto the rollup to pay for its own commit + payout action
const CRANK_MS: i64 = 250;
/// MagicBlock's real-time SOL/USD price feed. Live on every rollup (the Solana copy reads 0).
pub const SOL_USD_FEED: Pubkey = pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
pub const ORACLE_PROGRAM: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const MAX_PRICE_AGE_S: i64 = 30;
pub const TROPHY_SEED: &[u8] = b"trophy";
pub const TROPHY_FUND_SEED: &[u8] = b"trophy_fund";
pub const TROPHY_AUTH_SEED: &[u8] = b"trophy_auth";
const TROPHY_FUND: u64 = 5_000_000; // rent + Metaplex Core fee for one trophy, paid by the host up front
pub const RARITY: [&str; 4] = ["Common", "Rare", "Epic", "Legendary"];
/// MagicBlock session keys (gpl_session): a wallet approves a short-lived browser key once,
/// and that key signs moves on the rollup with no popups.
pub const GPL_SESSION: Pubkey = pubkey!("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
const SESSION_V2_DISC: [u8; 8] = [178, 3, 85, 254, 13, 116, 128, 41];
/// Plinko's devnet test-USDC (6 decimals) for spectator bets; mint authority is the ["mint-auth"] PDA.
pub const TUSDC: Pubkey = pubkey!("FmZj181DPGvcRejrW9TQVxMxTTMneGjKb2t39cys9Zc4");
pub const MAX_BETS: usize = 12;
const RARITY_W: [u32; 4] = [70, 20, 8, 2];
const CRANK_RUNS: i64 = 240; // ~60 s of ticks; a round is over in ~30 s

pub const OPEN: u8 = 0; // lobby on Solana, players joining
pub const ROLLING: u8 = 1; // on the private rollup, waiting for the fair dice
pub const LIVE: u8 = 2; // balls falling
pub const OVER: u8 = 3; // every ball landed (or the dice never came)

const ROLL_TIMEOUT_SLOTS: u64 = 3_000; // ~30 s: no dice by then and the round can be aborted

#[ephemeral]
#[program]
pub mod pegwar {
    use super::*;

    // ---------- Solana (base layer) ----------

    /// Open a round. The host pre-funds the rent the Board and Seed need for their
    /// read permissions on the private rollup, so nobody needs lamports there.
    /// `price` is each player's per-ball deposit in lamports. With `usd_cents` > 0 the ball's
    /// real cost is locked in dollars from MagicBlock's price feed when the round starts
    /// (capped at `price`), and the unspent deposit is refunded at payout.
    pub fn create_round(ctx: Context<CreateRound>, id: u64, price: u64, usd_cents: u16) -> Result<()> {
        let (host, sys) = (&ctx.accounts.host, &ctx.accounts.system_program);
        let extra = permission_rent(0) + chat_rent() + ACTION_FEES;
        pay(sys, host, &ctx.accounts.board.to_account_info(), extra)?;
        pay(sys, host, &ctx.accounts.seed.to_account_info(), permission_rent(0))?;
        pay(sys, host, &ctx.accounts.trophy_fund.to_account_info(), TROPHY_FUND)?;
        let b = &mut ctx.accounts.board;
        b.id = id;
        b.host = host.key();
        b.price = price;
        b.usd_cents = usd_cents;
        b.ball_cost = price;
        b.status = OPEN;
        for p in 0..MAX_PLAYERS {
            for i in 0..BALLS {
                b.balls[p * BALLS + i] = sim::empty_ball(p as u8);
            }
        }
        for m in b.bumpers.iter_mut() {
            *m = sim::empty_bumper();
        }
        b.golden = [sim::NONE; 2];
        ctx.accounts.seed.id = id;
        Ok(())
    }

    /// Buy in: `price` per ball for 1..=BALLS balls, straight into a vault that never leaves Solana.
    pub fn join(ctx: Context<Join>, _id: u64, balls: u8) -> Result<()> {
        let b = &mut ctx.accounts.board;
        let who = ctx.accounts.player.key();
        require!(b.status == OPEN, PegError::WrongPhase);
        require!((b.players_len as usize) < MAX_PLAYERS, PegError::RoundFull);
        require!(!b.players[..b.players_len as usize].contains(&who), PegError::AlreadyJoined);
        require!(balls >= 1 && balls as usize <= BALLS, PegError::BadBalls);
        let stake = b.price * balls as u64;
        if stake > 0 {
            pay(&ctx.accounts.system_program, &ctx.accounts.player, &ctx.accounts.vault.to_account_info(), stake)?;
        }
        let n = b.players_len as usize;
        for ball in &mut b.balls[n * BALLS + balls as usize..(n + 1) * BALLS] {
            ball.state = sim::VOID;
        }
        b.players[n] = who;
        b.players_len += 1;
        b.pot += stake;
        Ok(())
    }

    /// Host calls it off before the round starts: everyone gets their buy-in back.
    /// Pass every player's wallet as remaining accounts, in join order.
    pub fn cancel<'info>(ctx: Context<'info, Cancel<'info>>) -> Result<()> {
        let b = &mut ctx.accounts.board;
        require!(b.status == OPEN, PegError::WrongPhase);
        require_keys_eq!(ctx.accounts.host.key(), b.host, PegError::NotHost);
        let n = b.players_len as usize;
        require!(ctx.remaining_accounts.len() == n, PegError::WrongAccount);
        let id = b.id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &id, &[ctx.bumps.vault]]];
        for (i, to) in ctx.remaining_accounts.iter().enumerate() {
            require_keys_eq!(to.key(), b.players[i], PegError::WrongAccount);
            let stake = b.price * sim::bought(b, i);
            if stake > 0 {
                vault_pay(&ctx.accounts.system_program, &ctx.accounts.vault, to.clone(), stake, seeds)?;
            }
        }
        b.status = OVER;
        b.paid = u8::MAX;
        Ok(())
    }

    /// Hand the Board or Seed PDA to the private rollup. With `seal`, a delegation action runs
    /// `init_permission` inside the rollup the moment the account lands: the Board opens to
    /// everyone and the Seed is sealed from its very first slot there, with no extra transaction.
    pub fn delegate_pda(ctx: Context<DelegatePda>, account: AccountType, seal: bool) -> Result<()> {
        let seeds = account.seeds();
        let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
        let config = DelegateConfig { validator: Some(TEE_VALIDATOR), ..Default::default() };
        if !seal {
            return Ok(ctx.accounts.delegate_pda(&ctx.accounts.payer, &refs, config)?);
        }
        let pda = ctx.accounts.pda.key();
        let members = match account {
            AccountType::Board { .. } => None,
            AccountType::Seed { .. } => Some(vec![]),
        };
        let permission = Pubkey::find_program_address(&[b"permission:", pda.as_ref()], &PERMISSION_PROGRAM_ID).0;
        let action = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(permission, false),
                AccountMeta::new_readonly(PERMISSION_PROGRAM_ID, false),
                AccountMeta::new(EPHEMERAL_VAULT_ID, false),
                AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false),
            ],
            data: instruction::InitPermission { account, members }.data(),
        };
        let a = &ctx.accounts;
        let payer = a.payer.to_account_info();
        let pda_ai = a.pda.to_account_info();
        delegate_account_with_actions(
            DelegateAccounts {
                payer: &payer,
                pda: &pda_ai,
                owner_program: &a.owner_program,
                buffer: &a.buffer_pda,
                delegation_record: &a.delegation_record_pda,
                delegation_metadata: &a.delegation_metadata_pda,
                delegation_program: &a.delegation_program,
                system_program: &a.system_program,
            },
            &refs,
            config,
            vec![action].cleartext(),
            &[],
        )?;
        Ok(())
    }

    /// Pay one player their share of the pot: pot x their points / everyone's points.
    /// Anyone can call it for anyone; the money only ever goes to that player.
    /// A round with no points (the dice never came) refunds each buy-in.
    pub fn claim(ctx: Context<Claim>, player: u8) -> Result<()> {
        let b = &mut ctx.accounts.board;
        require!(b.status == OVER, PegError::NotOver);
        let p = player as usize;
        require!(p < b.players_len as usize, PegError::WrongAccount);
        require_keys_eq!(ctx.accounts.to.key(), b.players[p], PegError::WrongAccount);
        require!(b.paid & (1 << p) == 0, PegError::AlreadyPaid);
        b.paid |= 1 << p;
        let everyone = ((1u16 << b.players_len) - 1) as u8;
        // the last player paid also takes the rounding dust, so the vault ends at exactly zero
        let amount = if b.paid == everyone { ctx.accounts.vault.lamports() } else { share(b, p) };
        if amount > 0 {
            let id = b.id.to_le_bytes();
            let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &id, &[ctx.bumps.vault]]];
            vault_pay(&ctx.accounts.system_program, &ctx.accounts.vault, ctx.accounts.to.to_account_info(), amount, seeds)?;
        }
        Ok(())
    }

    // ---------- private rollup ----------

    /// Create the read permission for a delegated PDA, paid from its own pre-funded rent.
    /// The Board is public (`None`); the Seed is private with no readers at all (`Some([])`).
    /// Runs as the delegation action above, or from a client as a fallback (it's idempotent).
    pub fn init_permission(ctx: Context<InitPermission>, account: AccountType, members: Option<Vec<Member>>) -> Result<()> {
        // permissions are Ephemeral Accounts with zero lamports: "exists" means it has data
        if !ctx.accounts.permission.data_is_empty() {
            return Ok(());
        }
        let mut seeds = account.seeds();
        let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
        let (pda, bump) = Pubkey::find_program_address(&refs, &crate::ID);
        require_keys_eq!(pda, ctx.accounts.permissioned_account.key(), PegError::WrongAccount);
        seeds.push(vec![bump]);
        let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
        let (is_private, members) = match members {
            Some(m) => (true, m),
            None => (false, vec![]),
        };
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.permissioned_account.to_account_info(),
            permissioned_account: ctx.accounts.permissioned_account.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs { is_private, members },
        }
        .invoke_signed(&[refs.as_slice()])?;
        Ok(())
    }

    /// Lock the lobby and roll the fair dice. Only the host, once the round is on the rollup.
    pub fn start(ctx: Context<Start>, client_seed: u8) -> Result<()> {
        let a = &ctx.accounts;
        let who = acting_for(&a.payer, &a.player, a.session_token.as_deref())?;
        let b = &mut ctx.accounts.board;
        require!(b.status == OPEN, PegError::WrongPhase);
        require_keys_eq!(who, b.host, PegError::NotHost);
        require!(b.players_len > 0, PegError::WrongPhase);
        if b.usd_cents > 0 {
            let feed = &ctx.accounts.price_feed;
            require!(feed.owner == &ORACLE_PROGRAM, PegError::BadPrice);
            let cost = quote_lamports(&feed.try_borrow_data()?, Clock::get()?.unix_timestamp, b.usd_cents as u64)
                .ok_or(error!(PegError::BadPrice))?;
            b.ball_cost = cost.min(b.price); // never more than anyone deposited
        }
        b.status = ROLLING;
        b.start_slot = Clock::get()?.slot; // roll time until the dice land
        let ix = create_request_high_priority_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: crate::ID,
            callback_discriminator: instruction::SeedBoard::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![
                SerializableAccountMeta { pubkey: b.key(), is_signer: false, is_writable: true },
                SerializableAccountMeta { pubkey: ctx.accounts.seed.key(), is_signer: false, is_writable: true },
            ]),
            ..Default::default()
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// The VRF oracle's answer, sealed into the private Seed account. Every bounce of every
    /// ball comes from it, and nobody can read it until the round is over.
    pub fn seed_board(ctx: Context<SeedBoard>, randomness: [u8; 32]) -> Result<()> {
        let b = &mut ctx.accounts.board;
        require!(b.status == ROLLING, PegError::WrongPhase);
        let s = &mut ctx.accounts.seed;
        s.seed = solana_sha256_hasher::hashv(&[&randomness, b"pegwar", &b.id.to_le_bytes()]).to_bytes();
        s.paths = sim::paths(&s.seed);
        s.golden = sim::golden(&s.seed);
        b.start_slot = Clock::get()?.slot + sim::COUNTDOWN_SLOTS;
        b.status = LIVE;
        Ok(())
    }

    /// Drop your next ball (it leaves at the next tick your release gap allows).
    pub fn drop_ball(ctx: Context<Act>) -> Result<()> {
        let p = ctx.accounts.player_index()?;
        let a = &mut *ctx.accounts;
        sim::advance(&mut a.board, &a.seed.paths, a.seed.golden, Clock::get()?.slot);
        require!(a.board.status == LIVE, PegError::WrongPhase);
        require!(sim::queue_ball(&mut a.board, p), PegError::NoBalls);
        Ok(())
    }

    /// Put one of your 3 bumpers on a peg: the first rival ball to hit it gets knocked your way.
    pub fn place_bumper(ctx: Context<Act>, row: u8, peg: u8, dir: u8) -> Result<()> {
        let p = ctx.accounts.player_index()?;
        let a = &mut *ctx.accounts;
        sim::advance(&mut a.board, &a.seed.paths, a.seed.golden, Clock::get()?.slot);
        require!(a.board.status == LIVE, PegError::WrongPhase);
        require!(sim::place_bumper(&mut a.board, p, row, peg, dir), PegError::BadBumper);
        Ok(())
    }

    /// Move the board up to now. Anyone can call it: clients heartbeat it, the crank schedules it.
    pub fn tick(ctx: Context<Tick>) -> Result<()> {
        let a = &mut *ctx.accounts;
        sim::advance(&mut a.board, &a.seed.paths, a.seed.golden, Clock::get()?.slot);
        Ok(())
    }

    /// Hand the ticking to the rollup itself: schedule `tick` every 250 ms with MagicBlock's
    /// crank, signed by the Board PDA. Anyone can call it once the board is LIVE; clients keep a
    /// heartbeat as a fallback, and `advance` makes extra ticks harmless.
    pub fn arm(ctx: Context<Arm>) -> Result<()> {
        let b = &mut ctx.accounts.board;
        if b.status != LIVE || b.armed {
            return Ok(());
        }
        b.armed = true;
        let (key, id) = (b.key(), b.id.to_le_bytes());
        let tick = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(key, false), AccountMeta::new_readonly(ctx.accounts.seed.key(), false)],
            data: instruction::Tick {}.data(),
        };
        let ix = schedule_task_ix(key, task_id(&key), CRANK_MS, CRANK_RUNS, &[tick]);
        let board_ai = ctx.accounts.board.to_account_info();
        invoke_signed(&ix, &[board_ai, ctx.accounts.magic_program.to_account_info()], &[&[BOARD_SEED, &id, &[ctx.bumps.board]]])?;
        Ok(())
    }

    /// Open the round's trash-talk log: an Ephemeral Account that lives only on the rollup and
    /// is never written to Solana. Its rent comes out of the delegated Board.
    pub fn open_chat(ctx: Context<OpenChat>) -> Result<()> {
        ctx.accounts.init_if_needed_ephemeral_chat((8 + Chat::INIT_SPACE) as u32)?;
        let mut data = ctx.accounts.chat.try_borrow_mut_data()?;
        if data[..8] == [0u8; 8] {
            let empty = Chat { head: 0, msgs: [Msg { seat: 0, len: 0, text: [0; MSG_LEN] }; CHAT_SLOTS] };
            empty.try_serialize(&mut &mut data[..])?;
        }
        Ok(())
    }

    /// Say something. Players post under their seat colour, spectators as seat 255.
    /// The Board is read-only here so chat never blocks a tick.
    pub fn say(ctx: Context<Say>, text: Vec<u8>) -> Result<()> {
        require!(!text.is_empty() && text.len() <= MSG_LEN, PegError::BadMessage);
        let a = &ctx.accounts;
        let who = acting_for(&a.signer, &a.player, a.session_token.as_deref())?;
        let b = &ctx.accounts.board;
        let seat = b.players[..b.players_len as usize].iter().position(|k| *k == who).map_or(sim::NONE, |i| i as u8);
        let chat = &mut ctx.accounts.chat;
        let mut buf = [0u8; MSG_LEN];
        buf[..text.len()].copy_from_slice(&text);
        let i = chat.head as usize % CHAT_SLOTS;
        chat.msgs[i] = Msg { seat, len: text.len() as u8, text: buf };
        chat.head = chat.head.wrapping_add(1);
        Ok(())
    }

    /// Round over: close the chat so its rent goes back to the Board before it leaves the rollup.
    pub fn close_chat(ctx: Context<CloseChat>) -> Result<()> {
        require!(ctx.accounts.board.status == OVER, PegError::NotOver);
        ctx.accounts.close_ephemeral_chat()
    }

    /// Devnet faucet: 100 test-USDC to the caller's token account.
    pub fn faucet(ctx: Context<Faucet>) -> Result<()> {
        let bump = [ctx.bumps.mint_auth];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.mint_auth.to_account_info(),
                },
                &[&[b"mint-auth", &bump]],
            ),
            100_000_000,
        )
    }

    /// Spectators back a player with test-USDC, gasless on the rollup, until the dice are rolled.
    /// The stake moves from the bettor's rollup token account into the Board's Magic ATA.
    pub fn place_bet(ctx: Context<PlaceBet>, pick: u8, amount: u64) -> Result<()> {
        let b = &mut ctx.accounts.board;
        require!(b.status == OPEN, PegError::BetsClosed);
        require!(pick < b.players_len && amount > 0 && (b.bets_len as usize) < MAX_BETS, PegError::BadBet);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TokenTransfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.pot.to_account_info(),
                    authority: ctx.accounts.bettor.to_account_info(),
                },
            ),
            amount,
        )?;
        let i = b.bets_len as usize;
        b.bets[i] = Bet { bettor: ctx.accounts.bettor.key(), pick, amount };
        b.bets_len += 1;
        b.bet_total += amount;
        Ok(())
    }

    /// Round over: winning bets split the whole pool by stake; if nobody backed the winner,
    /// everyone gets their stake back. The Board signs for its Magic ATA. Pass every bettor's
    /// token account as remaining accounts, in bet order.
    pub fn settle_bets<'info>(ctx: Context<'info, SettleBets<'info>>) -> Result<()> {
        let b = &ctx.accounts.board;
        require!(b.status == OVER, PegError::NotOver);
        if b.bets_paid || b.bets_len == 0 {
            return Ok(());
        }
        let n = b.bets_len as usize;
        require!(ctx.remaining_accounts.len() == n, PegError::WrongAccount);
        let id = b.id.to_le_bytes();
        let bump = [ctx.bumps.board];
        let seeds: &[&[&[u8]]] = &[&[BOARD_SEED, &id, &bump]];
        for (i, (bet, to)) in b.bets[..n].iter().zip(ctx.remaining_accounts).enumerate() {
            require_keys_eq!(to.key(), get_associated_token_address(&bet.bettor, &TUSDC), PegError::WrongAccount);
            let amount = bet_payout(b, i);
            if amount > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        TokenTransfer {
                            from: ctx.accounts.pot.to_account_info(),
                            to: to.clone(),
                            authority: ctx.accounts.board.to_account_info(),
                        },
                        seeds,
                    ),
                    amount,
                )?;
            }
        }
        ctx.accounts.board.bets_paid = true;
        Ok(())
    }

    /// The dice never came: end the round with no points so everyone can be refunded.
    pub fn abort(ctx: Context<Tick>) -> Result<()> {
        let b = &mut ctx.accounts.board;
        require!(b.status == ROLLING, PegError::WrongPhase);
        require!(Clock::get()?.slot > b.start_slot + ROLL_TIMEOUT_SLOTS, PegError::TooEarly);
        b.status = OVER;
        Ok(())
    }

    /// Every ball has landed: reveal the seed on the public Board, hand both accounts back to
    /// Solana, and pay everyone in the same Solana transaction with a Magic Action. The Board
    /// pays for its own commit, so anyone can send this and no wallet has to sign for the money.
    pub fn finish(ctx: Context<FinishAuto>) -> Result<()> {
        require!(ctx.accounts.board.status == OVER, PegError::NotOver);
        ctx.accounts.board.seed = ctx.accounts.seed.seed;
        ctx.accounts.board.exit(&crate::ID)?;
        let b = &ctx.accounts.board;
        let id = b.id.to_le_bytes();
        let bump = [ctx.bumps.board];
        let seeds: &[&[u8]] = &[BOARD_SEED, &id, &bump];
        let board_ai = as_signer(b.to_account_info());
        let mut metas = vec![
            ShortAccountMeta { pubkey: b.key().to_bytes().into(), is_writable: true },
            ShortAccountMeta { pubkey: ctx.accounts.vault.key().to_bytes().into(), is_writable: true },
            ShortAccountMeta { pubkey: anchor_lang::system_program::ID.to_bytes().into(), is_writable: false },
        ];
        for k in &b.players[..b.players_len as usize] {
            metas.push(ShortAccountMeta { pubkey: k.to_bytes().into(), is_writable: true });
        }
        let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &crate::ID).0;
        for (k, w) in [
            (pda(&[TROPHY_FUND_SEED, &id]), true),
            (pda(&[TROPHY_SEED, &id]), true),
            (pda(&[TROPHY_AUTH_SEED]), false),
            (mpl_core::ID, false),
        ] {
            metas.push(ShortAccountMeta { pubkey: k.to_bytes().into(), is_writable: w });
        }
        let payout = CallHandler {
            destination_program: crate::ID,
            accounts: metas,
            args: ActionArgs::new(instruction::Payout { id: b.id }.data()),
            escrow_authority: board_ai.clone(),
            compute_units: 250_000,
        };
        MagicIntentBundleBuilder::new(
            board_ai.clone(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&[board_ai, ctx.accounts.seed.to_account_info()])
        .add_post_undelegate_actions([payout])
        .build_and_invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Runs on Solana as the Magic Action scheduled by `finish`, right after the round is back.
    /// Accounts are found by address, not position, and it can't fail on money edge cases:
    /// a failing action would roll back the whole commit.
    pub fn payout<'info>(ctx: Context<'info, Payout>, id: u64) -> Result<()> {
        let accs = ctx.remaining_accounts;
        let find = |k: &Pubkey| accs.iter().find(|a| a.key == k);
        let board_key = Pubkey::find_program_address(&[BOARD_SEED, &id.to_le_bytes()], &crate::ID).0;
        let (vault_key, vault_bump) = Pubkey::find_program_address(&[VAULT_SEED, &id.to_le_bytes()], &crate::ID);
        let escrow_key = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&board_key, ACTION_ESCROW_INDEX);
        // only the delegation program can sign for the Board's escrow: proves this came from `finish`
        require!(find(&escrow_key).is_some_and(|a| a.is_signer), PegError::WrongAccount);
        let (Some(board_ai), Some(vault), Some(sys)) = (find(&board_key), find(&vault_key), find(&anchor_lang::system_program::ID)) else {
            return err!(PegError::WrongAccount);
        };
        let mut b: Account<Board> = Account::try_from(board_ai)?;
        if b.status != OVER || b.paid != 0 {
            return Ok(());
        }
        let n = b.players_len as usize;
        let seeds: &[&[u8]] = &[VAULT_SEED, &id.to_le_bytes(), &[vault_bump]];
        let mut left = vault.lamports();
        for i in 0..n {
            let Some(to) = find(&b.players[i]) else { continue };
            // the last player takes the rounding dust so the vault ends at exactly zero
            let amount = if i == n - 1 { left } else { share(&b, i).min(left) };
            if amount > 0 {
                transfer(
                    CpiContext::new_with_signer(sys.key(), Transfer { from: vault.clone(), to: to.clone() }, &[seeds]),
                    amount,
                )?;
                left -= amount;
            }
            b.paid |= 1 << i;
        }
        // the round's winner gets a Metaplex Core trophy; rarity is drawn from the sealed VRF seed
        let winner = winner(&b);
        let (fund_key, fund_bump) = Pubkey::find_program_address(&[TROPHY_FUND_SEED, &id.to_le_bytes()], &crate::ID);
        let (asset_key, asset_bump) = Pubkey::find_program_address(&[TROPHY_SEED, &id.to_le_bytes()], &crate::ID);
        let (auth_key, auth_bump) = Pubkey::find_program_address(&[TROPHY_AUTH_SEED], &crate::ID);
        if let (Some(fund), Some(asset), Some(auth), Some(core), Some(to)) =
            (find(&fund_key), find(&asset_key), find(&auth_key), find(&mpl_core::ID), find(&b.players[winner]))
        {
            if b.scores[winner] > 0 && asset.data_is_empty() && fund.lamports() >= TROPHY_FUND {
                let r = rarity(&b.seed);
                CreateV2CpiBuilder::new(core)
                    .asset(asset)
                    .authority(Some(auth))
                    .payer(fund)
                    .owner(Some(to))
                    .update_authority(Some(auth))
                    .system_program(sys)
                    .name(format!("Plinko Trophy: {}", RARITY[r]))
                    .uri(String::new())
                    .plugins(vec![PluginAuthorityPair {
                        plugin: Plugin::Attributes(Attributes {
                            attribute_list: vec![
                                Attribute { key: "round".into(), value: id.to_string() },
                                Attribute { key: "rarity".into(), value: RARITY[r].into() },
                                Attribute { key: "points".into(), value: format!("{:.1}", b.scores[winner] as f32 / 10.0) },
                            ],
                        }),
                        authority: Some(PluginAuthority::UpdateAuthority),
                    }])
                    .invoke_signed(&[
                        &[TROPHY_SEED, &id.to_le_bytes(), &[asset_bump]],
                        &[TROPHY_AUTH_SEED, &[auth_bump]],
                        &[TROPHY_FUND_SEED, &id.to_le_bytes(), &[fund_bump]],
                    ])?;
                b.trophy = r as u8 + 1;
            }
        }
        b.exit(&crate::ID)?;
        Ok(())
    }

    /// Fallback finish if the Magic Action path ever fails: same reveal and commit, paid for by
    /// the caller's wallet, then anyone runs `claim` on Solana.
    pub fn finish_manual(ctx: Context<Finish>) -> Result<()> {
        require!(ctx.accounts.board.status == OVER, PegError::NotOver);
        ctx.accounts.board.seed = ctx.accounts.seed.seed;
        ctx.accounts.board.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.board.to_account_info(), ctx.accounts.seed.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

fn pay<'info>(sys: &Program<'info, System>, from: &Signer<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    transfer(CpiContext::new(sys.key(), Transfer { from: from.to_account_info(), to: to.clone() }), amount)
}

fn vault_pay<'info>(
    sys: &Program<'info, System>,
    vault: &SystemAccount<'info>,
    to: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    transfer(
        CpiContext::new_with_signer(sys.key(), Transfer { from: vault.to_account_info(), to }, seeds),
        amount,
    )
}

fn permission_rent(members: usize) -> u64 {
    ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(members) as u32)
}

/// Parimutuel: bets on the winner split the whole pool by stake; nobody backed them = refunds.
fn bet_payout(b: &Board, i: usize) -> u64 {
    let w = winner(b) as u8;
    let bets = &b.bets[..b.bets_len as usize];
    let backed: u64 = bets.iter().filter(|x| x.pick == w).map(|x| x.amount).sum();
    if backed == 0 {
        bets[i].amount
    } else if bets[i].pick == w {
        (b.bet_total as u128 * bets[i].amount as u128 / backed as u128) as u64
    } else {
        0
    }
}

/// Top scorer; ties go to whoever joined first.
fn winner(b: &Board) -> usize {
    (0..b.players_len as usize).max_by_key(|&i| (b.scores[i], std::cmp::Reverse(i))).unwrap_or(0)
}

/// What player `p` is owed: their unspent deposit back, plus their points' share of what was
/// actually staked (an even split if nobody scored, e.g. the dice never came).
fn share(b: &Board, p: usize) -> u64 {
    let n = b.players_len as u64;
    let unspent = b.price - b.ball_cost; // per ball bought
    let prize = b.pot - unspent * (0..n as usize).map(|i| sim::bought(b, i)).sum::<u64>();
    let total: u64 = b.scores[..n as usize].iter().map(|&s| s as u64).sum();
    unspent * sim::bought(b, p) + if total == 0 { prize / n } else { (prize as u128 * b.scores[p] as u128 / total as u128) as u64 }
}

/// Lamports for `cents` USD from MagicBlock's price-feed account. Exponent is stored positive
/// (8 means 10^-8); a price older than MAX_PRICE_AGE_S is refused.
pub fn quote_lamports(d: &[u8], now: i64, cents: u64) -> Option<u64> {
    if d.len() < 101 {
        return None;
    }
    let price = i64::from_le_bytes(d[73..81].try_into().ok()?);
    let expo = i32::from_le_bytes(d[89..93].try_into().ok()?);
    let publish = i64::from_le_bytes(d[93..101].try_into().ok()?);
    if price <= 0 || now - publish > MAX_PRICE_AGE_S {
        return None;
    }
    let num = (cents as u128) * 1_000_000_000 * 10u128.checked_pow(expo.unsigned_abs())?;
    u64::try_from(num.div_ceil(price as u128 * 100)).ok()
}

/// Trophy rarity, an independent draw from the same sealed seed (70/20/8/2).
pub fn rarity(seed: &[u8; 32]) -> usize {
    let mut x = u32::from_le_bytes([seed[4], seed[5], seed[6], seed[7]]) % RARITY_W.iter().sum::<u32>();
    for (i, w) in RARITY_W.iter().enumerate() {
        if x < *w {
            return i;
        }
        x -= w;
    }
    0
}

fn chat_rent() -> u64 {
    ephemeral_rollups_sdk::ephemeral_accounts::rent((8 + Chat::INIT_SPACE) as u32)
}

/// PDA payers arrive with is_signer=false; the Magic program needs the flag set and the seeds
/// passed to `build_and_invoke_signed` make it true (same workaround as MagicBlock's rewards example).
fn as_signer(ai: AccountInfo<'_>) -> AccountInfo<'_> {
    AccountInfo { is_signer: true, ..ai }
}

/// Task ids are one global namespace per validator: derive ours from the Board address.
fn task_id(board: &Pubkey) -> i64 {
    i64::from_le_bytes(board.to_bytes()[..8].try_into().unwrap()) & i64::MAX
}

/// Magic program `ScheduleTask` (bincode variant 6 on validator v1.0): run `ixs` every
/// `interval_ms`, `iterations` times. The SDK's own helper is deprecated and fights Anchor's
/// lifetimes, so this is the 20-line encoder MagicBlock's enum produces.
fn schedule_task_ix(payer: Pubkey, task_id: i64, interval_ms: i64, iterations: i64, ixs: &[Instruction]) -> Instruction {
    let mut d = 6u32.to_le_bytes().to_vec();
    d.extend(task_id.to_le_bytes());
    d.extend(interval_ms.to_le_bytes());
    d.extend(iterations.to_le_bytes());
    d.extend((ixs.len() as u64).to_le_bytes());
    for ix in ixs {
        d.extend(ix.program_id.to_bytes());
        d.extend((ix.accounts.len() as u64).to_le_bytes());
        for m in &ix.accounts {
            d.extend(m.pubkey.to_bytes());
            d.push(m.is_signer as u8);
            d.push(m.is_writable as u8);
        }
        d.extend((ix.data.len() as u64).to_le_bytes());
        d.extend(&ix.data);
    }
    Instruction { program_id: MAGIC_PROGRAM_ID, accounts: vec![AccountMeta::new(payer, true)], data: d }
}

// ---------- accounts ----------

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateRound<'info> {
    #[account(init, payer = host, space = 8 + Board::INIT_SPACE, seeds = [BOARD_SEED, &id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(init, payer = host, space = 8 + Seed::INIT_SPACE, seeds = [SEED_SEED, &id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
    #[account(mut, seeds = [TROPHY_FUND_SEED, &id.to_le_bytes()], bump)]
    pub trophy_fund: SystemAccount<'info>,
    #[account(mut)]
    pub host: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Join<'info> {
    #[account(mut, seeds = [BOARD_SEED, &id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, seeds = [VAULT_SEED, &id.to_le_bytes()], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, seeds = [VAULT_SEED, &board.id.to_le_bytes()], bump)]
    pub vault: SystemAccount<'info>,
    pub host: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePda<'info> {
    /// CHECK: re-derived from `AccountType` by the delegate helper
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, seeds = [VAULT_SEED, &board.id.to_le_bytes()], bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: checked against board.players[player]
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitPermission<'info> {
    /// CHECK: must equal the PDA derived from `account`
    #[account(mut)]
    pub permissioned_account: UncheckedAccount<'info>,
    /// CHECK: created by the permission program
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct Start<'info> {
    /// The host's wallet, or the session key it approved; also pays for the dice (free on the rollup).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the host's wallet; must be `payer` or have a live session for it
    pub player: UncheckedAccount<'info>,
    /// CHECK: gpl_session SessionTokenV2, checked in `acting_for`
    pub session_token: Option<UncheckedAccount<'info>>,
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(seeds = [SEED_SEED, &board.id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
    /// CHECK: MagicBlock's SOL/USD feed; owner checked when the round is priced in dollars
    #[account(address = SOL_USD_FEED)]
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: VRF oracle queue
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct SeedBoard<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, seeds = [SEED_SEED, &board.id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
}

#[derive(Accounts)]
pub struct Act<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(seeds = [SEED_SEED, &board.id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
    /// The seated wallet itself, or a session key it approved.
    pub signer: Signer<'info>,
    /// CHECK: the seat's wallet; must be `signer` or have a live session for it
    pub player: UncheckedAccount<'info>,
    /// CHECK: gpl_session SessionTokenV2, checked in `acting_for`
    pub session_token: Option<UncheckedAccount<'info>>,
}

impl Act<'_> {
    fn player_index(&self) -> Result<usize> {
        let who = acting_for(&self.signer, &self.player, self.session_token.as_deref())?;
        let b = &self.board;
        b.players[..b.players_len as usize].iter().position(|k| *k == who).ok_or_else(|| error!(PegError::WrongAccount))
    }
}

/// The wallet a transaction acts for: `player` if it signed, or if `signer` holds a live
/// gpl_session token for this program issued by `player`.
fn acting_for(signer: &Signer, player: &AccountInfo, token: Option<&AccountInfo>) -> Result<Pubkey> {
    if signer.key() == player.key() {
        return Ok(player.key());
    }
    let tok = token.ok_or(error!(PegError::NotYourSeat))?;
    require_keys_eq!(*tok.owner, GPL_SESSION, PegError::NotYourSeat);
    let d = tok.try_borrow_data()?;
    require!(d.len() >= 144 && d[..8] == SESSION_V2_DISC, PegError::NotYourSeat);
    let pda = Pubkey::find_program_address(
        &[b"session_token_v2", crate::ID.as_ref(), signer.key().as_ref(), player.key().as_ref()],
        &GPL_SESSION,
    )
    .0;
    let valid_until = i64::from_le_bytes(d[136..144].try_into().unwrap());
    require!(pda == tok.key() && Clock::get()?.unix_timestamp < valid_until, PegError::NotYourSeat);
    Ok(player.key())
}

#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(seeds = [SEED_SEED, &board.id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
}

#[derive(Accounts)]
pub struct Arm<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(seeds = [SEED_SEED, &board.id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
    /// CHECK: fixed address
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct OpenChat<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, sponsor, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    /// CHECK: rollup-only chat log, created by the Magic program via CPI
    #[account(mut, eph, seeds = [CHAT_SEED, board.key().as_ref()], bump)]
    pub chat: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Say<'info> {
    pub signer: Signer<'info>,
    /// CHECK: who is talking; must be `signer` or have a live session for it
    pub player: UncheckedAccount<'info>,
    /// CHECK: gpl_session SessionTokenV2, checked in `acting_for`
    pub session_token: Option<UncheckedAccount<'info>>,
    #[account(seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, seeds = [CHAT_SEED, board.key().as_ref()], bump)]
    pub chat: Account<'info, Chat>,
}

#[ephemeral_accounts]
#[derive(Accounts)]
pub struct CloseChat<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, sponsor, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    /// CHECK: rollup-only chat log
    #[account(mut, eph, seeds = [CHAT_SEED, board.key().as_ref()], bump)]
    pub chat: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct FinishAuto<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, seeds = [SEED_SEED, &board.id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
    /// CHECK: the never-delegated vault; only its address goes into the payout action
    #[account(seeds = [VAULT_SEED, &board.id.to_le_bytes()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: ["magic-fee-vault", TEE validator] under the delegation program
    #[account(mut, address = ephemeral_rollups_sdk::dlp_api::pda::magic_fee_vault_pda_from_validator(&TEE_VALIDATOR))]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut, address = TUSDC)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA signer only
    #[account(seeds = [b"mint-auth"], bump)]
    pub mint_auth: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    pub bettor: Signer<'info>,
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, token::mint = TUSDC, token::authority = bettor)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, address = get_associated_token_address(&board.key(), &TUSDC))]
    pub pot: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleBets<'info> {
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, address = get_associated_token_address(&board.key(), &TUSDC))]
    pub pot: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Every account arrives in `remaining_accounts`; `payout` checks each one by address.
#[derive(Accounts)]
pub struct Payout {}

#[commit]
#[derive(Accounts)]
pub struct Finish<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BOARD_SEED, &board.id.to_le_bytes()], bump)]
    pub board: Box<Account<'info, Board>>,
    #[account(mut, seeds = [SEED_SEED, &board.id.to_le_bytes()], bump)]
    pub seed: Account<'info, Seed>,
}

// ---------- state ----------

/// Public: everyone watches this live on the rollup.
#[account]
#[derive(InitSpace)]
pub struct Board {
    pub id: u64,
    pub host: Pubkey,
    pub price: u64, // lamports deposited per ball
    pub usd_cents: u16, // > 0: ball cost locked in dollars from the price feed at start
    pub ball_cost: u64, // lamports actually staked per ball
    pub pot: u64,
    pub status: u8,
    pub paid: u8, // bit per player
    pub players_len: u8,
    pub players: [Pubkey; MAX_PLAYERS],
    pub scores: [u32; MAX_PLAYERS],
    pub next_release: [u32; MAX_PLAYERS],
    pub balls: [Ball; MAX_BALLS],
    pub bumpers: [Bumper; MAX_BUMPERS],
    pub tick: u32,
    pub landed: u8,
    pub start_slot: u64,
    pub armed: bool, // the rollup's crank is ticking this board
    pub trophy: u8, // 0 none, else 1 + rarity of the winner's trophy
    pub bets: [Bet; MAX_BETS], // spectator bets in test-USDC
    pub bets_len: u8,
    pub bet_total: u64,
    pub bets_paid: bool,
    pub golden: [u8; 2], // [row, peg] once a ball has touched the golden peg, else NONE
    pub seed: [u8; 32], // zero until the round is over, then the revealed seed
}

// std only derives Default for arrays up to 32 long; the unit tests need one.
impl Default for Board {
    fn default() -> Self {
        Board {
            id: 0,
            host: Pubkey::default(),
            price: 0,
            usd_cents: 0,
            ball_cost: 0,
            pot: 0,
            status: 0,
            paid: 0,
            players_len: 0,
            players: [Pubkey::default(); MAX_PLAYERS],
            scores: [0; MAX_PLAYERS],
            next_release: [0; MAX_PLAYERS],
            balls: [Ball::default(); MAX_BALLS],
            bumpers: [Bumper::default(); MAX_BUMPERS],
            tick: 0,
            landed: 0,
            start_slot: 0,
            armed: false,
            trophy: 0,
            bets: [Bet::default(); MAX_BETS],
            bets_len: 0,
            bet_total: 0,
            bets_paid: false,
            golden: [0; 2],
            seed: [0; 32],
        }
    }
}

/// Private: nobody can read it on the rollup. Revealed when the round ends.
#[account]
#[derive(InitSpace)]
pub struct Seed {
    pub id: u64,
    pub seed: [u8; 32],
    pub paths: [u16; MAX_BALLS],
    pub golden: [u8; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Default)]
pub struct Bet {
    pub bettor: Pubkey,
    pub pick: u8,
    pub amount: u64,
}

/// Rollup-only ring buffer of the last CHAT_SLOTS messages.
#[account]
#[derive(InitSpace)]
pub struct Chat {
    pub head: u8,
    pub msgs: [Msg; CHAT_SLOTS],
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy)]
pub struct Msg {
    pub seat: u8,
    pub len: u8,
    pub text: [u8; MSG_LEN],
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Default)]
pub struct Ball {
    pub owner: u8,
    pub state: u8,
    pub row: u8,
    pub pos: u8,
    pub released: u32,
    pub golden: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Default)]
pub struct Bumper {
    pub owner: u8, // sim::NONE = unused
    pub row: u8,
    pub peg: u8,
    pub dir: u8, // 0 left, 1 right
    pub active: u32,
    pub hit: u8, // ball index that spent it, or sim::NONE
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AccountType {
    Board { id: u64 },
    Seed { id: u64 },
}

impl AccountType {
    fn seeds(&self) -> Vec<Vec<u8>> {
        match self {
            AccountType::Board { id } => vec![BOARD_SEED.to_vec(), id.to_le_bytes().to_vec()],
            AccountType::Seed { id } => vec![SEED_SEED.to_vec(), id.to_le_bytes().to_vec()],
        }
    }
}

#[error_code]
pub enum PegError {
    #[msg("This round is full.")]
    RoundFull,
    #[msg("You're already in this round.")]
    AlreadyJoined,
    #[msg("Only the host can do that.")]
    NotHost,
    #[msg("Wrong account for this round.")]
    WrongAccount,
    #[msg("Not allowed in this phase of the round.")]
    WrongPhase,
    #[msg("You have no balls left to drop.")]
    NoBalls,
    #[msg("That peg can't take a bumper, or you have none left.")]
    BadBumper,
    #[msg("The round isn't over.")]
    NotOver,
    #[msg("Already paid out.")]
    AlreadyPaid,
    #[msg("Too early to abort; the dice may still land.")]
    TooEarly,
    #[msg("Messages are 1 to 48 bytes.")]
    BadMessage,
    #[msg("The SOL/USD price feed is missing or stale.")]
    BadPrice,
    #[msg("That wallet didn't sign, and there's no live session key for it.")]
    NotYourSeat,
    #[msg("Bets close when the dice are rolled.")]
    BetsClosed,
    #[msg("Pick a seated player, bet more than zero; 12 bets per round.")]
    BadBet,
    #[msg("Pick 1 to 5 balls.")]
    BadBalls,
}

#[cfg(test)]
mod tests {
    use super::*;
    use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};

    #[test]
    fn money_math_holds() {
        // $0.25 at $110.36453884 (a real TEE snapshot): price i64 @73, exponent +8 @89, publish @93
        let mut d = vec![0u8; 134];
        d[73..81].copy_from_slice(&11_036_453_884i64.to_le_bytes());
        d[89..93].copy_from_slice(&8i32.to_le_bytes());
        d[93..101].copy_from_slice(&1_000i64.to_le_bytes());
        assert_eq!(quote_lamports(&d, 1_010, 25), Some(2_265_221));
        assert_eq!(quote_lamports(&d, 1_031, 25), None); // stale

        // 2 players deposit 3_000 per ball, cost locks at 2_000: each gets 5_000 back + points share
        let mut b = Board { players_len: 2, price: 3_000, ball_cost: 2_000, pot: 30_000, ..Default::default() };
        b.scores[0] = 30;
        b.scores[1] = 10;
        assert_eq!(share(&b, 0), 5_000 + 15_000);
        assert_eq!(share(&b, 1), 5_000 + 5_000);
        b.scores = [0; 8]; // nobody scored: even split
        assert_eq!(share(&b, 1), 15_000);
        // P2 bought 2 balls (6_000 in): pot 21_000, unspent 1_000 a ball back, 14_000 staked split 3:1
        let mut b = Board { players_len: 2, price: 3_000, ball_cost: 2_000, pot: 21_000, ..Default::default() };
        for ball in &mut b.balls[sim::BALLS + 2..2 * sim::BALLS] {
            ball.state = sim::VOID;
        }
        b.scores[0] = 30;
        b.scores[1] = 10;
        assert_eq!(share(&b, 0), 5_000 + 10_500);
        assert_eq!(share(&b, 1), 2_000 + 3_500);
        assert_eq!(share(&b, 0) + share(&b, 1), b.pot);

        // spectator bets: 30 on P1 (winner), 10 on P1, 60 on P2 -> P1 backers split 100 as 75/25
        let mut b = Board { players_len: 2, bets_len: 3, bet_total: 100, ..Default::default() };
        b.scores[0] = 50;
        for (i, (pick, amount)) in [(0u8, 30u64), (0, 10), (1, 60)].into_iter().enumerate() {
            b.bets[i] = Bet { bettor: Pubkey::default(), pick, amount };
        }
        assert_eq!((bet_payout(&b, 0), bet_payout(&b, 1), bet_payout(&b, 2)), (75, 25, 0));
        b.scores = [0, 9, 0, 0, 0, 0, 0, 0]; // P2 wins: its lone backer takes all 100
        assert_eq!(bet_payout(&b, 2), 100);
        b.bets[2].pick = 0; // nobody backed the winner: refunds
        assert_eq!((bet_payout(&b, 0), bet_payout(&b, 2)), (30, 60));

        let r: Vec<usize> = (0..1000u32).map(|i| { let mut s = [0u8; 32]; s[4..8].copy_from_slice(&i.wrapping_mul(2_654_435_761).to_le_bytes()); rarity(&s) }).collect();
        assert!(r.contains(&3) && r.iter().filter(|&&x| x == 0).count() > 600);
    }

    #[test]
    fn schedule_task_bytes_match_magicblock() {
        let tick = Instruction { program_id: crate::ID, accounts: vec![AccountMeta::new(TEE_VALIDATOR, false)], data: vec![1, 2, 3] };
        let ours = schedule_task_ix(TEE_VALIDATOR, 42, 250, 9, &[tick.clone()]).data;
        let official = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id: 42,
            execution_interval_millis: 250,
            iterations: 9,
            instructions: vec![tick],
        }))
        .unwrap();
        assert_eq!(ours, official);
    }
}
