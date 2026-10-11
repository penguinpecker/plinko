// Draws the live board. The rollup sends ball rows/positions every tick (~250 ms);
// this turns them into balls hopping peg to peg, bumpers, bins and score pops.
import type { BoardState } from "./chain";
import { BALL, NONE, POINTS, ROWS } from "./sim";

export const W = 760;
export const H = 700;
const CX = W / 2;
const DX = 52;
const DY = 44;
const Y0 = 64;
const PEG_R = 5;
const BALL_R = 9;
const BIN_Y = Y0 + ROWS * DY + 6;
const HOP_MS = 230;

// player colours: no green (wins are magenta/amber) and no amber (kept for money and the golden peg)
export const COLORS = ["#a4c9ff", "#f472b6", "#22d3ee", "#ff8a4c", "#a78bfa", "#f43f5e", "#e2e8f0", "#3b82f6"];
// bin tiers, edge (33) -> centre (0.3): magenta jackpots, pink, lavender, ice, then muted. Dark tiles, coloured edge and value.
const TIER = ["#f26aff", "#fda9ff", "#d0bcff", "#d0bcff", "#a4c9ff", "#8b919d", "#8b919d"];
export const BIN_COLORS = [...TIER, ...TIER.slice(0, -1).reverse()];
const HEAD = '"Space Grotesk", "Arial Narrow", system-ui, sans-serif';

export const pegX = (r: number, i: number) => CX + (i - (r + 2) / 2) * DX;
export const pegY = (r: number) => Y0 + r * DY;
const ballX = (row: number, pos: number) => (row >= ROWS ? CX + (pos - ROWS / 2) * DX : CX + (pos - row / 2) * DX);
const ballY = (row: number) => (row >= ROWS ? BIN_Y + 14 : pegY(row) - PEG_R - BALL_R + 2);
const label = (pts: number) => (pts / 10).toString();

interface Sprite { x: number; y: number; fx: number; fy: number; tx: number; ty: number; t0: number; row: number; trail: { x: number; y: number }[]; landedAt: number }
interface Pop { x: number; y: number; text: string; color: string; t0: number; big?: boolean }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; color: string }


export class BoardView {
  private g: CanvasRenderingContext2D;
  private sprites = new Map<number, Sprite>();
  private pops: Pop[] = [];
  private sparks: Spark[] = [];
  private binBump = new Array(ROWS + 1).fill(0);
  private seenHit = new Set<number>();
  private goldenSeen = false;
  private golden = new Set<number>();
  private audio: AudioContext | null = null;
  private flash = new Map<string, { a: number; color: string }>(); // peg "row:i" -> hit glow
  banner: { text: string; sub?: string; color?: string } | null = null;
  muted = false;
  onLand: ((bin: number, owner: number, golden: boolean, x: number, y: number) => void) | null = null;
  me = -1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    this.g = canvas.getContext("2d")!;
    this.g.scale(dpr, dpr);
  }

  reset() {
    this.sprites.clear();
    this.pops = [];
    this.sparks = [];
    this.seenHit.clear();
    this.goldenSeen = false;
    this.golden.clear();
    this.flash.clear();
  }

  /** Feed a fresh board from the rollup; starts hop animations for balls that moved. */
  update(b: BoardState, now: number) {
    if (b.golden[0] !== NONE && !this.goldenSeen) {
      this.goldenSeen = true;
      const x = pegX(b.golden[0], b.golden[1] + 1), y = pegY(b.golden[0]);
      this.pops.push({ x, y: y - 22, text: "GOLDEN PEG ×2", color: "#fbbf24", t0: now });
      this.blip(990, 0.1, "triangle");
    }
    b.balls.slice(0, b.playersLen * 5).forEach((ball, k) => {
      if (ball.state !== BALL.FALLING && ball.state !== BALL.LANDED) return;
      if (ball.golden) this.golden.add(k);
      const tx = ballX(ball.row, ball.pos), ty = ballY(ball.row);
      let s = this.sprites.get(k);
      if (!s) {
        s = { x: CX, y: Y0 - 40, fx: CX, fy: Y0 - 40, tx, ty, t0: now, row: -1, trail: [], landedAt: 0 };
        this.sprites.set(k, s);
      }
      if (s.row !== ball.row) {
        if (s.row >= 0 && ball.row > s.row && ball.row < ROWS) this.blip((320 + ball.row * 38) * (0.97 + Math.random() * 0.06), 0.03);
        if (ball.row < ROWS) {
          const key = `${ball.row}:${ball.pos + 1}`, color = COLORS[ball.owner];
          setTimeout(() => this.flash.set(key, { a: 1, color }), HOP_MS);
        }
        s.fx = s.x; s.fy = s.y; s.tx = tx; s.ty = ty; s.t0 = now; s.row = ball.row;
        if (ball.state === BALL.LANDED && !s.landedAt) {
          s.landedAt = now + HOP_MS;
          setTimeout(() => this.land(ball.pos, ball.owner, ball.golden), HOP_MS);
        }
      }
    });
    b.bumpers.forEach((m, j) => {
      if (m.owner === NONE || m.hit === NONE || this.seenHit.has(j)) return;
      this.seenHit.add(j);
      const x = pegX(m.row, m.peg + 1), y = pegY(m.row);
      for (let n = 0; n < 18; n++) {
        const a = Math.random() * Math.PI * 2, v = 1.5 + Math.random() * 3.5;
        this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color: COLORS[m.owner] });
      }
      this.pops.push({ x, y: y - 18, text: "BUMPED!", color: COLORS[m.owner], t0: now });
      this.blip(140, 0.08, "square");
    });
  }

  private land(bin: number, owner: number, golden: boolean) {
    this.binBump[bin] = 1;
    const pts = POINTS[bin] * (golden ? 2 : 1), big = POINTS[bin] >= 110, x = CX + (bin - ROWS / 2) * DX;
    this.pops.push({ x, y: BIN_Y - 8, text: `+${label(pts)}${golden ? " GOLD" : ""}`, color: golden || big ? "#fbbf24" : COLORS[owner], t0: performance.now(), big });
    this.blip(POINTS[bin] >= 200 ? 880 : POINTS[bin] >= 40 ? 660 : 440, POINTS[bin] >= 200 ? 0.12 : 0.06);
    if (owner === this.me && big) this.chime();
    this.onLand?.(bin, owner, golden, x, BIN_Y);
  }

  draw(b: BoardState | null, now: number) {
    const g = this.g;
    g.clearRect(0, 0, W, H);
    this.drawPegs(b);
    if (b && b.golden[0] !== NONE) this.drawGolden(b.golden[0], b.golden[1], now);
    this.drawBins();
    if (b) this.drawBumpers(b);
    this.drawBalls(now);
    this.drawFx(now);
    if (this.banner) this.drawBanner(this.banner);
  }

  private drawPegs(b: BoardState | null) {
    const g = this.g;
    for (let r = 0; r < ROWS; r++) {
      for (let i = 0; i < r + 3; i++) {
        const x = pegX(r, i), y = pegY(r);
        const f = this.flash.get(`${r}:${i}`), a = f?.a ?? 0;
        g.globalAlpha = f ? (1 + 2 * a) * 0.2 : 1;
        g.fillStyle = f ? f.color : "rgba(164,201,255,0.10)";
        g.beginPath(); g.arc(x, y, PEG_R + 4 + 6 * a, 0, 7); g.fill();
        g.globalAlpha = 1;
        g.fillStyle = b && b.status >= 2 ? "#ecdcff" : "#8b919d";
        g.beginPath(); g.arc(x, y, PEG_R * (1 + 0.4 * a), 0, 7); g.fill();
        if (f && (f.a *= 0.9) < 0.02) this.flash.delete(`${r}:${i}`);
      }
    }
  }

  private drawGolden(r: number, peg: number, now: number) {
    const g = this.g, x = pegX(r, peg + 1), y = pegY(r);
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    const glow = g.createRadialGradient(x, y, 2, x, y, 30);
    glow.addColorStop(0, `rgba(251,191,36,${0.55 + 0.3 * pulse})`);
    glow.addColorStop(1, "rgba(251,191,36,0)");
    g.fillStyle = glow;
    g.beginPath(); g.arc(x, y, 30, 0, 7); g.fill();
    const glass = g.createRadialGradient(x - 2, y - 2, 0, x, y, PEG_R + 2);
    glass.addColorStop(0, "#ffdc7a");
    glass.addColorStop(0.55, "#fbbf24");
    glass.addColorStop(1, "#d6930a");
    g.fillStyle = glass;
    g.beginPath(); g.arc(x, y, PEG_R + 2, 0, 7); g.fill();
    g.font = `700 11px ${HEAD}`;
    g.textAlign = "center";
    g.fillStyle = "#fbbf24";
    g.fillText("×2", x, y - 16);
  }

  private drawBins() {
    const g = this.g;
    for (let k = 0; k <= ROWS; k++) {
      const bump = this.binBump[k];
      this.binBump[k] *= 0.9;
      const x = CX + (k - ROWS / 2) * DX - DX / 2 + 3, y = BIN_Y + bump * 8, w = DX - 6, h = 28;
      const c = BIN_COLORS[k], jackpot = POINTS[k] >= 330;
      // 1px edge in the tier colour (glows while a ball lands), then the dark tile, then a tint
      if (bump > 0.05 || jackpot) { g.shadowColor = c; g.shadowBlur = jackpot ? 10 + 20 * bump : 24 * bump; }
      g.globalAlpha = jackpot ? 1 : 0.5 + 0.5 * bump;
      g.fillStyle = c;
      chamfer(g, x, y, w, h, 5); g.fill();
      g.shadowBlur = 0;
      g.globalAlpha = 1;
      const tile = g.createLinearGradient(0, y, 0, y + h);
      tile.addColorStop(0, "#2c1a4c");
      tile.addColorStop(1, "#170434");
      g.fillStyle = tile;
      chamfer(g, x + 1, y + 1, w - 2, h - 2, 4.6); g.fill();
      g.globalAlpha = (jackpot ? 0.3 : 0.08) + 0.5 * bump;
      g.fillStyle = c;
      g.fill();
      g.globalAlpha = 1;
      g.fillRect(x + 5, y + h - 3, w - 6, 2); // base line, like a bucket lip
      g.fillStyle = jackpot ? "#ffffff" : c;
      g.font = `700 13px ${HEAD}`;
      g.textAlign = "center";
      g.fillText(`${label(POINTS[k])}`, x + w / 2, y + 18);
    }
  }

  private drawBumpers(b: BoardState) {
    const g = this.g;
    b.bumpers.forEach((m) => {
      if (m.owner === NONE) return;
      const x = pegX(m.row, m.peg + 1), y = pegY(m.row);
      const spent = m.hit !== NONE, armed = m.active <= b.tick;
      g.globalAlpha = spent ? 0.28 : 1;
      if (armed && !spent) { g.shadowColor = COLORS[m.owner]; g.shadowBlur = 10; }
      this.bumperGlyph(x, y, m.dir, COLORS[m.owner], armed || spent);
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    });
  }

  private bumperGlyph(x: number, y: number, dir: number, color: string, solid: boolean) {
    const g = this.g;
    g.strokeStyle = color;
    g.lineWidth = 2.5;
    g.setLineDash(solid ? [] : [4, 4]);
    g.beginPath(); g.arc(x, y, PEG_R + 7, 0, 7); g.stroke();
    g.setLineDash([]);
    g.fillStyle = color;
    g.beginPath(); g.arc(x, y, PEG_R + 1, 0, 7); g.fill();
    const s = dir === 0 ? -1 : 1;
    g.beginPath();
    g.moveTo(x + s * 22, y);
    g.lineTo(x + s * 13, y - 7);
    g.lineTo(x + s * 13, y + 7);
    g.closePath(); g.fill();
  }


  private drawBalls(now: number) {
    const g = this.g;
    for (const [k, s] of this.sprites) {
      const u = Math.min(1, (now - s.t0) / HOP_MS);
      const e = u * (2 - u);
      s.x = s.fx + (s.tx - s.fx) * e;
      s.y = s.fy + (s.ty - s.fy) * e - Math.sin(Math.PI * u) * 14;
      s.trail.push({ x: s.x, y: s.y });
      if (s.trail.length > 10) s.trail.shift();
      const fade = s.landedAt ? Math.max(0, 1 - (now - s.landedAt) / 900) : 1;
      if (fade <= 0) continue;
      const color = COLORS[Math.floor(k / 5)], mine = Math.floor(k / 5) === this.me;
      g.globalCompositeOperation = "lighter";
      s.trail.forEach((p, i) => {
        g.globalAlpha = (i / s.trail.length) * 0.35 * fade;
        g.fillStyle = color;
        g.beginPath(); g.arc(p.x, p.y, BALL_R * (0.4 + (0.6 * i) / s.trail.length), 0, 7); g.fill();
      });
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = fade;
      if (mine) { g.shadowColor = color; g.shadowBlur = 14; }
      const grad = g.createRadialGradient(s.x - 3, s.y - 3, 1, s.x, s.y, BALL_R);
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.35, color);
      grad.addColorStop(1, shade(color));
      g.fillStyle = grad;
      g.beginPath(); g.arc(s.x, s.y, BALL_R, 0, 7); g.fill();
      g.shadowBlur = 0;
      if (this.golden.has(k)) {
        g.strokeStyle = "#fbbf24";
        g.lineWidth = 3;
        g.beginPath(); g.arc(s.x, s.y, BALL_R + 5, 0, 7); g.stroke();
      }
      if (mine) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2;
        g.beginPath(); g.arc(s.x, s.y, BALL_R + 2.5, 0, 7); g.stroke();
      }
      g.globalAlpha = 1;
    }
  }

  private drawFx(now: number) {
    const g = this.g;
    for (const s of this.sparks) {
      s.x += s.vx; s.y += s.vy; s.vy += 0.12; s.life -= 0.03;
      g.globalAlpha = Math.max(0, s.life);
      g.fillStyle = s.color;
      g.fillRect(s.x - 2, s.y - 2, 4, 4);
    }
    g.globalAlpha = 1;
    this.sparks = this.sparks.filter((s) => s.life > 0);
    for (const p of this.pops) {
      const u = (now - p.t0) / 1100;
      g.globalAlpha = Math.max(0, 1 - u);
      g.font = `italic 700 ${p.big ? 24 : 18}px ${HEAD}`;
      g.textAlign = "center";
      g.lineWidth = 4;
      g.strokeStyle = "rgba(13,2,32,0.9)";
      g.strokeText(p.text, p.x, p.y - u * 34);
      g.fillStyle = p.color;
      g.fillText(p.text, p.x, p.y - u * 34);
    }
    g.globalAlpha = 1;
    this.pops = this.pops.filter((p) => now - p.t0 < 1100);
  }

  private drawBanner(b: { text: string; sub?: string; color?: string }) {
    const g = this.g;
    g.fillStyle = "rgba(13,2,32,0.72)";
    g.fillRect(0, H / 2 - 70, W, 130);
    g.fillStyle = "rgba(208,188,255,0.14)";
    g.fillRect(0, H / 2 - 70, W, 1);
    g.fillRect(0, H / 2 + 59, W, 1);
    g.textAlign = "center";
    g.font = `italic 700 52px ${HEAD}`;
    g.fillStyle = b.color ?? "#ecdcff";
    if (b.color) { g.shadowColor = "#f26aff"; g.shadowBlur = 24; }
    g.fillText(b.text, W / 2, H / 2 + 6);
    g.shadowBlur = 0;
    if (b.sub) {
      g.font = '500 16px Satoshi, system-ui, sans-serif';
      g.fillStyle = "#c1c7d3";
      g.fillText(b.sub, W / 2, H / 2 + 40);
    }
  }

  /** Tiny synth blips; silent until the first user gesture unlocks audio. */
  private blip(freq: number, vol: number, type: OscillatorType = "sine") {
    if (this.muted) return;
    try {
      this.audio ??= new AudioContext();
      if (this.audio.state !== "running") return;
      const o = this.audio.createOscillator(), v = this.audio.createGain(), t = this.audio.currentTime;
      o.type = type;
      o.frequency.value = freq;
      v.gain.setValueAtTime(vol, t);
      v.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(v).connect(this.audio.destination);
      o.start(t);
      o.stop(t + 0.2);
    } catch { /* no audio available */ }
  }

  /** Rising triad for your own big landing. */
  chime() {
    [1046, 1318, 1568].forEach((f, i) => setTimeout(() => this.blip(f, 0.08, "triangle"), i * 70));
  }

  unlockAudio() {
    this.audio ??= new AudioContext();
    void this.audio.resume();
  }
}

/** Box with the top-right and bottom-left corners cut. */
function chamfer(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) {
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w - c, y);
  g.lineTo(x + w, y + c);
  g.lineTo(x + w, y + h);
  g.lineTo(x + c, y + h);
  g.lineTo(x, y + h - c);
  g.closePath();
}

function shade(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.45).toString(16).padStart(2, "0");
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}
