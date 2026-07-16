/**
 * Advisory market-state — PURE logic for the cross-system bridge (ADR: the
 * cockpit and the iamrossi trend system advise each other READ-ONLY; neither
 * executes through the other; every consumer fails open/soft when this data is
 * missing or stale).
 *
 * The event-window math lives here so both the advisory endpoint and any
 * internal consumer (straddle prep, panels) share ONE definition of "inside an
 * event window".
 */

export interface MacroEvent {
  name: string;
  /** The print instant, epoch ms UTC. */
  printAtMs: number;
  severity: 'high' | 'medium';
}

export interface EventWindowState {
  /** The next event at/after `now − postWindowMs` (a just-printed event still counts). */
  next: MacroEvent | null;
  /** Hours from now until the print (negative = printed within the post window). */
  hoursToPrint: number | null;
  /** True when now ∈ [print − preWindowMs, print + postWindowMs]. */
  inWindow: boolean;
}

/** Default risk window: 12h before a print (an 8h-candle system holding leveraged
 *  positions decides at most one candle ahead), 1h after (the immediate whipsaw). */
export const DEFAULT_PRE_WINDOW_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_POST_WINDOW_MS = 60 * 60 * 1000;

/** Parse the curated calendar JSON (unknown shape in, typed events out; bad rows dropped). */
export function parseCalendar(raw: unknown): MacroEvent[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const events = (raw as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const out: MacroEvent[] = [];
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const row = e as { name?: unknown; printAt?: unknown; severity?: unknown };
    const printAtMs = typeof row.printAt === 'string' ? Date.parse(row.printAt) : NaN;
    if (typeof row.name !== 'string' || !Number.isFinite(printAtMs)) continue;
    out.push({
      name: row.name,
      printAtMs,
      severity: row.severity === 'high' ? 'high' : 'medium',
    });
  }
  return out.sort((a, b) => a.printAtMs - b.printAtMs);
}

/** Resolve the event-window state at `now`. PURE. */
export function eventWindowState(
  events: ReadonlyArray<MacroEvent>,
  now: number,
  preWindowMs = DEFAULT_PRE_WINDOW_MS,
  postWindowMs = DEFAULT_POST_WINDOW_MS,
): EventWindowState {
  const upcoming = events.filter((e) => e.printAtMs >= now - postWindowMs);
  const next = upcoming[0] ?? null;
  if (!next) return { next: null, hoursToPrint: null, inWindow: false };
  const hoursToPrint = (next.printAtMs - now) / 3_600_000;
  const inWindow = now >= next.printAtMs - preWindowMs && now <= next.printAtMs + postWindowMs;
  return { next, hoursToPrint, inWindow };
}
