/**
 * gil's mark: the "Dot cloud", a turning ball of loose points whose flares are stray points
 * flying out (chosen from the menu bar icon mockups). Pure. The drawing is plain canvas code kept
 * as a script, so main can run it in a hidden window to render the menu bar frames and the app
 * icon (main has no canvas of its own).
 */

/** What gil is doing, as the menu bar shows it. */
export type TrayStatus = 'idle' | 'capturing' | 'analyzing' | 'ready'

/**
 * Each status as three dials the drawing reads, the same dials as the mockup's states:
 * f how far out the flares are (0–1), b how busy they are (flares pop in and out), p how much of
 * a ringed planet it is (0 none, 1 ring).
 * - idle: a quiet ball, no flares (the mockup's "off").
 * - capturing: the ring (the mockup's "live"), like something in orbit being recorded.
 * - analyzing: flares popping (the mockup's "busy").
 * - ready: flares out and still (the mockup's "resting"), a finished sun.
 */
export const STATUS_DIALS: Record<TrayStatus, { f: number; b: number; p: number }> = {
  idle: { f: 0, b: 0, p: 0 },
  capturing: { f: 0, b: 0, p: 1 },
  analyzing: { f: 1, b: 1, p: 0 },
  ready: { f: 1, b: 0, p: 0 },
}

/** One full turn takes this long (s); the flares' beat repeats every 2 s, so this is one loop. */
export const LOOP_SECONDS = 18
/** Frames per second the menu bar icon is drawn at. */
export const TRAY_FPS = 12

/** How long "ready" shows after an analysis finishes before gil goes back to idle (ms). */
export const READY_MS = 10_000

/** The status to show, from what gil is doing. Capturing wins over analyzing, analyzing over ready. */
export function trayStatus(state: { capturing: boolean; analyzing: boolean; finishedAt: number | null; now: number }): TrayStatus {
  if (state.capturing) return 'capturing'
  if (state.analyzing) return 'analyzing'
  if (state.finishedAt !== null && state.now - state.finishedAt < READY_MS) return 'ready'
  return 'idle'
}

/**
 * The drawing, as a script that defines `drawDotCloud(ctx, S, D, t)`: ctx a 2D canvas context
 * with fillStyle set to the ink, S the size in CSS px, D the dials, t the time in seconds.
 * Taken from the mockup's "dots" style.
 */
export const DOT_CLOUD_SCRIPT = `
const TAU = Math.PI * 2, L = (a, b, k) => a + (b - a) * k;
const ease = x => x * x * (3 - 2 * x), frac = x => x - Math.floor(x);
const pop = x => x < .25 ? ease(x / .25) : x < .55 ? 1 : x < .8 ? 1 - ease((x - .55) / .25) : 0;
const flare = (D, i, t) => L(D.f, pop(frac(t / 2 + i * .618)), D.b) * (1 - D.p);
const PHI = (1 + Math.sqrt(5)) / 2, V = [];
for (const a of [-1, 1]) for (const b of [-1, 1]) for (const v of [[0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]]) { const l = Math.hypot(...v); V.push(v.map(x => x / l)); }
const CLOUD = Array.from({ length: 70 }, (_, i) => { const y = 1 - (i + .5) / 35, r = Math.sqrt(1 - y * y), a = i * 2.39996; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
const TILT = .5, cT = Math.cos(TILT), sT = Math.sin(TILT);
const turn = (p, ang) => { const ca = Math.cos(ang), sa = Math.sin(ang), x = p[0] * ca + p[2] * sa, z = -p[0] * sa + p[2] * ca; return [x, p[1] * cT - z * sT, p[1] * sT + z * cT]; };
const depth = z => Math.max(0, Math.min(1, (z / 1.15 + 1) / 2));
const ring3 = (ang, n) => Array.from({ length: n + 1 }, (_, i) => { const a = i / n * TAU, x = 1.2 * Math.cos(a); return turn([x * Math.cos(.38), x * Math.sin(.38), 1.2 * Math.sin(a)], ang); });
function drawDotCloud(ctx, S, D, t) {
  const c = S / 2, u = S * .38, ang = t / ${LOOP_SECONDS} * TAU, R = L(.85, .62, D.p);
  const dot = (p, r, a) => { ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(c + p[0] * u, c - p[1] * u, r, 0, TAU); ctx.fill(); };
  for (const v of CLOUD) { const p = turn(v, ang), d = depth(p[2]); dot(p.map(x => x * R), S * .02 * (.6 + .8 * d), .25 + .75 * d); }
  V.forEach((v, i) => { const k = flare(D, i, t); if (k < .04) return; const p = turn(v, ang), d = depth(p[2]); dot(p.map(x => x * L(R, 1.25, k)), S * .034, Math.min(1, k * 2) * (.35 + .65 * d)); });
  if (D.p > .02) for (const p of ring3(ang, 26).slice(1)) dot(p, S * .022, D.p * (.3 + .7 * depth(p[2])));
  ctx.globalAlpha = 1;
}
`
