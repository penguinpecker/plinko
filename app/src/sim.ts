// Port of programs/pegwar/src/sim.rs. The chain referees the live round; the browser uses
// this only to replay a finished round from its revealed seed and check every bounce.
import { sha256 } from "@noble/hashes/sha2";

export const ROWS = 12;
export const BINS = ROWS + 1;
export const POINTS = [330, 110, 40, 20, 11, 6, 3, 6, 11, 20, 40, 110, 330];
export const MAX_PLAYERS = 8;
export const BALLS = 5;
export const BUMPERS = 3;
export const MAX_BALLS = MAX_PLAYERS * BALLS;
export const TICK_SLOTS = 25;
export const DROP_TICKS = 80;
export const BUMPER_DELAY = 2;
export const NONE = 255;
export const BALL = { IN_HAND: 0, QUEUED: 1, FALLING: 2, LANDED: 3, VOID: 4 } as const; // VOID: not bought

export interface Ball { owner: number; state: number; row: number; pos: number; released: number; golden: boolean }
export interface Bumper { owner: number; row: number; peg: number; dir: number; active: number; hit: number }

/** The hidden golden peg [row, peg]; any ball that touches it scores double. */
export function golden(seed: Uint8Array): [number, number] {
  const row = 3 + (seed[0] % (ROWS - 4));
  return [row, seed[1] % (row + 1)];
}

/** Bounce bits for every ball: bit r = direction at peg row r (1 = right). */
export function paths(seed: Uint8Array): number[] {
  return Array.from({ length: MAX_BALLS }, (_, k) => {
    const h = sha256(Uint8Array.from([...seed, k]));
    return h[0] | (h[1] << 8);
  });
}

/** Balls player `p` bought (1..BALLS). */
export const bought = (balls: Ball[], p: number) => balls.slice(p * BALLS, p * BALLS + BALLS).filter((b) => b.state !== BALL.VOID).length;

/** Re-run a finished round from its seed, release ticks and bumper placements. Returns the
 * balls that land somewhere other than where the chain says (empty = every bounce checks out). */
export function replay(seed: Uint8Array, playersLen: number, balls: Ball[], bumpers: Bumper[]): number[] {
  const bits = paths(seed);
  const [gr, gp] = golden(seed);
  const total = playersLen * BALLS;
  const sim: Ball[] = balls.slice(0, total).map((b) => ({ ...b, state: b.state === BALL.VOID ? BALL.VOID : BALL.IN_HAND, row: 0, pos: 0, golden: false }));
  const bm = bumpers.map((m) => ({ ...m, hit: NONE }));
  const lastTick = Math.max(0, ...sim.map((b) => b.released)) + ROWS + 1;
  for (let t = 1; t <= lastTick; t++) {
    sim.forEach((b, k) => {
      if (b.state !== BALL.FALLING) return;
      if (b.row === gr && b.pos === gp) b.golden = true;
      const m = bm.find((x) => x.owner !== NONE && x.owner !== b.owner && x.hit === NONE && x.row === b.row && x.peg === b.pos && x.active <= t);
      let dir = (bits[k] >> b.row) & 1;
      if (m) { m.hit = k; dir = m.dir; }
      b.pos += dir;
      b.row += 1;
      if (b.row === ROWS) b.state = BALL.LANDED;
    });
    sim.forEach((b) => { if (b.state === BALL.IN_HAND && b.released === t) b.state = BALL.FALLING; });
  }
  const ok = (b: Ball, k: number) => (b.state === BALL.VOID ? balls[k].state === BALL.VOID : b.state === BALL.LANDED && b.pos === balls[k].pos && b.golden === balls[k].golden);
  const badBalls = sim.flatMap((b, k) => (ok(b, k) ? [] : [k]));
  const badBumpers = bm.flatMap((m, j) => (m.hit === bumpers[j].hit ? [] : [MAX_BALLS + j]));
  return badBalls.concat(badBumpers);
}
