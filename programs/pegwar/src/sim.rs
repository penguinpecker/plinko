// The board referee. Integer-only and deterministic: every ball moves one peg row per tick,
// bouncing left or right from the sealed seed unless a rival's bumper is waiting on that peg.
// One hidden golden peg (also from the seed) doubles the points of every ball that hits it.
// app/src/sim.ts is a line-for-line port the browser uses to replay and verify a finished round.
use crate::{Ball, Board, Bumper};

pub const ROWS: u8 = 12;
pub const BINS: usize = ROWS as usize + 1;
/// Points per bin, edges to centre and back (Stake's 12-row "medium" table x10).
pub const POINTS: [u32; BINS] = [330, 110, 40, 20, 11, 6, 3, 6, 11, 20, 40, 110, 330];

pub const MAX_PLAYERS: usize = 8;
pub const BALLS: usize = 5; // per player
pub const BUMPERS: usize = 3; // per player
pub const MAX_BALLS: usize = MAX_PLAYERS * BALLS;
pub const MAX_BUMPERS: usize = MAX_PLAYERS * BUMPERS;

pub const TICK_SLOTS: u64 = 25; // ~250 ms per row on a ~10 ms-slot rollup
pub const COUNTDOWN_SLOTS: u64 = 300; // ~3 s between the dice landing and the first tick
pub const DROP_TICKS: u32 = 80; // ~20 s to drop by hand; after that the rest drop themselves
pub const RELEASE_GAP: u32 = 2; // ticks between two balls from the same player
pub const BUMPER_DELAY: u32 = 2; // a bumper arms this many ticks after it's placed
pub const MAX_STEPS: u32 = 40; // ticks simulated per transaction, bounds compute

pub const NONE: u8 = u8::MAX;

pub const IN_HAND: u8 = 0;
pub const QUEUED: u8 = 1;
pub const FALLING: u8 = 2;
pub const LANDED: u8 = 3;
pub const VOID: u8 = 4; // a ball the player didn't buy (they chose fewer than BALLS)

/// Run the board forward to `slot`. Every instruction calls this first, so the board moves
/// whenever anyone acts, a client heartbeat ticks, or the rollup's crank fires.
pub fn advance(b: &mut Board, paths: &[u16; MAX_BALLS], golden: [u8; 2], slot: u64) {
    if b.status != crate::LIVE || slot < b.start_slot {
        return;
    }
    let target = (slot - b.start_slot) / TICK_SLOTS;
    let mut n = 0;
    while (b.tick as u64) < target && n < MAX_STEPS && b.status == crate::LIVE {
        step(b, paths, golden);
        n += 1;
    }
}

pub fn step(b: &mut Board, paths: &[u16; MAX_BALLS], golden: [u8; 2]) {
    b.tick += 1;
    let t = b.tick;
    let total = b.players_len as usize * BALLS;
    // 1. falling balls hit their next peg
    for k in 0..total {
        if b.balls[k].state != FALLING {
            continue;
        }
        let (row, pos, owner) = (b.balls[k].row, b.balls[k].pos, b.balls[k].owner);
        if [row, pos] == golden {
            b.balls[k].golden = true;
            b.golden = golden; // revealed the first time a ball touches it
        }
        let dir = match b.bumpers.iter_mut().find(|m| {
            m.owner != NONE && m.owner != owner && m.hit == NONE && m.row == row && m.peg == pos && m.active <= t
        }) {
            Some(m) => {
                m.hit = k as u8;
                m.dir
            }
            None => ((paths[k] >> row) & 1) as u8,
        };
        let ball = &mut b.balls[k];
        ball.pos += dir;
        ball.row += 1;
        if ball.row == ROWS {
            ball.state = LANDED;
            b.scores[owner as usize] += POINTS[ball.pos as usize] * if ball.golden { 2 } else { 1 };
            b.landed += 1;
        }
    }
    // 2. each player releases their next queued ball, at most one per RELEASE_GAP ticks
    for p in 0..b.players_len as usize {
        let first = p * BALLS;
        if t >= DROP_TICKS {
            for ball in &mut b.balls[first..first + BALLS] {
                if ball.state == IN_HAND {
                    ball.state = QUEUED;
                }
            }
        }
        if t < b.next_release[p] {
            continue;
        }
        if let Some(ball) = b.balls[first..first + BALLS].iter_mut().find(|x| x.state == QUEUED) {
            ball.state = FALLING;
            ball.released = t;
            b.next_release[p] = t + RELEASE_GAP;
        }
    }
    if b.balls[..total].iter().all(|x| x.state == LANDED || x.state == VOID) {
        b.status = crate::OVER;
    }
}

/// How many balls player `p` bought.
pub fn bought(b: &Board, p: usize) -> u64 {
    b.balls[p * BALLS..(p + 1) * BALLS].iter().filter(|x| x.state != VOID).count() as u64
}

/// Queue one of the player's balls for release at the next allowed tick.
pub fn queue_ball(b: &mut Board, p: usize) -> bool {
    let first = p * BALLS;
    match b.balls[first..first + BALLS].iter_mut().find(|x| x.state == IN_HAND) {
        Some(ball) => {
            ball.state = QUEUED;
            true
        }
        None => false,
    }
}

/// Place a bumper; it arms BUMPER_DELAY ticks from now so nobody can react to a bounce they just saw.
pub fn place_bumper(b: &mut Board, p: usize, row: u8, peg: u8, dir: u8) -> bool {
    if row == 0 || row >= ROWS || peg > row || dir > 1 {
        return false;
    }
    if b.bumpers.iter().any(|m| m.owner != NONE && m.row == row && m.peg == peg) {
        return false;
    }
    let first = p * BUMPERS;
    match b.bumpers[first..first + BUMPERS].iter_mut().find(|m| m.owner == NONE) {
        Some(m) => {
            *m = Bumper { owner: p as u8, row, peg, dir, active: b.tick + BUMPER_DELAY, hit: NONE };
            true
        }
        None => false,
    }
}

/// Where the golden peg sits: rows 3..ROWS-2, any peg a ball can reach on that row.
pub fn golden(seed: &[u8; 32]) -> [u8; 2] {
    let row = 3 + seed[0] % (ROWS - 4);
    [row, seed[1] % (row + 1)]
}

/// Bounce bits for every ball, from the sealed seed: bit `r` = direction at peg row `r`.
pub fn paths(seed: &[u8; 32]) -> [u16; MAX_BALLS] {
    let mut out = [0u16; MAX_BALLS];
    for (k, o) in out.iter_mut().enumerate() {
        let h = solana_sha256_hasher::hashv(&[seed, &[k as u8]]).to_bytes();
        *o = u16::from_le_bytes([h[0], h[1]]);
    }
    out
}

pub fn empty_ball(owner: u8) -> Ball {
    Ball { owner, state: IN_HAND, row: 0, pos: 0, released: 0, golden: false }
}

pub fn empty_bumper() -> Bumper {
    Bumper { owner: NONE, row: 0, peg: 0, dir: 0, active: 0, hit: NONE }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(players: u8) -> Board {
        let mut b = Board { players_len: players, status: crate::LIVE, golden: [NONE; 2], ..Default::default() };
        for p in 0..MAX_PLAYERS {
            for i in 0..BALLS {
                b.balls[p * BALLS + i] = empty_ball(p as u8);
            }
        }
        for m in b.bumpers.iter_mut() {
            *m = empty_bumper();
        }
        b
    }

    const NO_GOLD: [u8; 2] = [NONE; 2];

    fn run(b: &mut Board, paths: &[u16; MAX_BALLS]) {
        for _ in 0..500 {
            if b.status != crate::LIVE {
                return;
            }
            step(b, paths, NO_GOLD);
        }
        panic!("round never ended");
    }

    #[test]
    fn bought_fewer_balls() {
        // P1 bought 2 balls, P2 all 5: the round ends once those 7 land, the 3 unbought never move
        let mut b = board(2);
        for ball in &mut b.balls[2..BALLS] {
            ball.state = VOID;
        }
        assert_eq!((bought(&b, 0), bought(&b, 1)), (2, 5));
        run(&mut b, &[u16::MAX; MAX_BALLS]);
        assert_eq!(b.status, crate::OVER);
        assert_eq!(b.landed, 7);
        assert!(b.balls[2..BALLS].iter().all(|x| x.state == VOID && x.released == 0));
        assert_eq!(b.scores[0], 2 * POINTS[BINS - 1]);
        assert!(!queue_ball(&mut board_with_void(), 0)); // nothing in hand to drop
    }

    fn board_with_void() -> Board {
        let mut b = board(1);
        for ball in &mut b.balls[..BALLS] {
            ball.state = VOID;
        }
        b
    }

    #[test]
    fn referee_rules_hold() {
        // all-right paths land in the last bin; all-left in the first
        let right = [u16::MAX; MAX_BALLS];
        let mut b = board(2);
        run(&mut b, &right);
        assert!(b.balls[..10].iter().all(|x| x.state == LANDED && x.pos == ROWS));
        assert_eq!(b.scores[0], 5 * POINTS[BINS - 1]);
        assert_eq!(b.landed, 10);
        assert_eq!(b.status, crate::OVER);

        // nothing dropped by hand: everything auto-drops after DROP_TICKS, spaced by RELEASE_GAP
        let mut b = board(1);
        run(&mut b, &[0; MAX_BALLS]);
        assert_eq!(b.balls[0].released, DROP_TICKS);
        assert_eq!(b.balls[1].released, DROP_TICKS + RELEASE_GAP);
        assert!(b.balls[..5].iter().all(|x| x.pos == 0));

        // a hand-dropped ball releases on the next tick
        let mut b = board(1);
        assert!(queue_ball(&mut b, 0));
        step(&mut b, &right, NO_GOLD);
        assert_eq!((b.balls[0].state, b.balls[0].released), (FALLING, 1));
        assert!(queue_ball(&mut b, 0));
        step(&mut b, &right, NO_GOLD); // gap not yet over
        assert_eq!(b.balls[1].state, QUEUED);
        step(&mut b, &right, NO_GOLD);
        assert_eq!((b.balls[1].state, b.balls[1].released), (FALLING, 3));

        // a rival bumper deflects the first rival ball, once; own balls pass through
        let mut b = board(2);
        assert!(place_bumper(&mut b, 1, 1, 1, 0)); // P2: row 1, peg 1, push left
        assert!(!place_bumper(&mut b, 0, 1, 1, 1)); // peg taken
        assert!(!place_bumper(&mut b, 0, 1, 2, 1)); // peg 2 doesn't exist on row 1
        assert!(!place_bumper(&mut b, 0, 0, 0, 1)); // top peg can't hold a bumper
        queue_ball(&mut b, 0);
        queue_ball(&mut b, 1);
        run(&mut b, &right);
        let m = b.bumpers[BUMPERS];
        assert_eq!(m.hit, 0); // P1's first ball
        assert_eq!(b.balls[0].pos, ROWS - 1); // knocked left once, right every other row
        assert_eq!(b.balls[5].pos, ROWS); // P2's own ball ignored its bumper
        assert_eq!(b.balls[1].pos, ROWS); // bumper already spent

        // a bumper isn't armed until BUMPER_DELAY ticks after placement
        let mut b = board(2);
        queue_ball(&mut b, 0);
        step(&mut b, &right, NO_GOLD); // tick 1: P1's ball released at the top
        step(&mut b, &right, NO_GOLD); // tick 2: ball row 0 -> 1, pos 1
        assert!(place_bumper(&mut b, 1, 1, 1, 0)); // arms at tick 4
        step(&mut b, &right, NO_GOLD); // tick 3: ball hits (1,1) before the bumper arms
        assert_eq!(b.bumpers[BUMPERS].hit, NONE);
        assert_eq!((b.balls[0].row, b.balls[0].pos), (2, 2));

        // three bumpers per player
        let mut b = board(1);
        for r in 1..=3 {
            assert!(place_bumper(&mut b, 0, r, 0, 1));
        }
        assert!(!place_bumper(&mut b, 0, 4, 0, 1));

        // the golden peg doubles every ball that touches it and reveals itself on first touch
        let mut b = board(1);
        queue_ball(&mut b, 0);
        for _ in 0..20 {
            step(&mut b, &right, [3, 3]); // all-right path passes (3,3)
        }
        assert!(b.balls[0].golden);
        assert_eq!(b.golden, [3, 3]);
        assert_eq!(b.scores[0], 2 * POINTS[BINS - 1]);
        let s = [9u8; 32];
        let [row, peg] = golden(&s);
        assert!((3..ROWS - 1).contains(&row) && peg <= row);

        // paths are deterministic and differ by ball
        let s = [7u8; 32];
        assert_eq!(paths(&s), paths(&s));
        assert_ne!(paths(&s)[0], paths(&s)[1]);

        // advance never runs ahead of the clock and is bounded per call
        let mut b = board(1);
        b.start_slot = 1000;
        advance(&mut b, &right, NO_GOLD, 999);
        assert_eq!(b.tick, 0);
        advance(&mut b, &right, NO_GOLD, 1000 + 3 * TICK_SLOTS + 1);
        assert_eq!(b.tick, 3);
        advance(&mut b, &right, NO_GOLD, 1000 + 10_000 * TICK_SLOTS);
        assert_eq!(b.tick, 3 + MAX_STEPS);
    }
}
