/**
 * PURE arm-readiness validation for a ladder — the static gate the arm route runs
 * before it will flip a ladder to `armed` (architecture §2 pyramiding guardrails +
 * §3.5 caps). Returns blocking `warnings` (empty ⇒ safe to arm) plus the §3.5 risk
 * read for the preview. No I/O, no keys.
 *
 * What's checked HERE (static, arm-time):
 *   - title/thesis present; expiry in the future; caps present + positive
 *   - each rung: valid trigger params; sized; stop on the LOSS side; leverage in band
 *   - per-coin single leverage (HL is per-coin) — via computeLadderRisk breaches
 *   - caps not breached (notional, worst-case loss) — via computeLadderRisk breaches
 *   - PYRAMIDING: adds use DECREASING size, and the per-coin stop only ever TIGHTENS
 *
 * What is NOT checked here (it's RUNTIME, enforced at fire): the inviolable
 * "each add's risk must be covered by the existing position's unrealized profit" rule
 * needs live unrealized PnL, so /ladder/fire-rung checks it per-fire — never here.
 */

import type { Ladder, LadderRung, LadderSide, RungAction, RungTriggerKind, RungTriggerMeta } from './ladder-types';
import {
  computeLadderRisk,
  rungEntryPx,
  type LadderCaps,
  type LadderRiskRead,
  type RungRisk,
} from './ladder-risk-business-logic';

/** A rung resolved for arm-time validation (caller fills entryPx from the trigger
 *  level + sizeCoins from explicit/risk-based sizing). */
export interface ArmRung {
  seq: number;
  coin: string;
  side: LadderSide;
  action: RungAction;
  triggerKind: RungTriggerKind;
  triggerPx: number | null;
  triggerMeta: RungTriggerMeta | null;
  /** Resolved fill level (= triggerPx for price kinds). */
  entryPx: number | null;
  /** Resolved size in coins (open/add must have one; reduce/close may be null = full). */
  sizeCoins: number | null;
  leverage: number | null;
  stopPx: number | null;
}

export interface ValidateLadderInput {
  title: string;
  thesis?: string | null;
  /** Epoch ms the ladder expires (INJECTED); must be in the future. */
  expiresAtMs: number | null;
  caps: LadderCaps;
  rungs: ArmRung[];
  /** Epoch ms — INJECTED (no Date.now in pure code). */
  now: number;
  /** Coin → its HL max leverage (caller resolves; the validator clamps against it). */
  coinMaxLeverage: (coin: string) => number;
}

export interface ValidateLadderResult {
  warnings: string[];
  risk: LadderRiskRead;
}

const INCREASES_EXPOSURE = (a: RungAction): boolean => a === 'open' || a === 'add';

/** Validate trigger params for a rung's kind. Returns a reason when invalid, else null. */
function triggerProblem(r: ArmRung): string | null {
  switch (r.triggerKind) {
    case 'price_above':
    case 'price_below':
      return r.triggerPx != null && r.triggerPx > 0 ? null : `rung ${r.seq}: ${r.triggerKind} needs a positive triggerPx`;
    case 'volume':
      return r.triggerMeta?.minVolume != null && r.triggerMeta.minVolume > 0 ? null : `rung ${r.seq}: volume trigger needs minVolume > 0`;
    case 'funding':
      return (r.triggerMeta?.op === 'above' || r.triggerMeta?.op === 'below') && r.triggerMeta?.fundingRate != null && Number.isFinite(r.triggerMeta.fundingRate)
        ? null
        : `rung ${r.seq}: funding trigger needs op + a finite fundingRate`;
    case 'indicator':
      return (r.triggerMeta?.op === 'above' || r.triggerMeta?.op === 'below') && !!r.triggerMeta?.indicatorName && r.triggerMeta?.indicatorValue != null && Number.isFinite(r.triggerMeta.indicatorValue)
        ? null
        : `rung ${r.seq}: indicator trigger needs op + name + a finite value`;
    default:
      return `rung ${r.seq}: unknown trigger kind`;
  }
}

/** Is the stop on the LOSS side of entry for the side? long stops BELOW, short ABOVE. */
function stopOnLossSide(side: LadderSide, entryPx: number, stopPx: number): boolean {
  return side === 'long' ? stopPx < entryPx : stopPx > entryPx;
}

/**
 * Static arm-readiness validation. PURE. An empty `warnings` array means the ladder is
 * safe to arm (per the static checks); the route still does the runtime precondition +
 * caps re-check at fire.
 */
export function validateLadderForArm(input: ValidateLadderInput): ValidateLadderResult {
  const warnings: string[] = [];
  const { rungs, caps } = input;

  if (!input.title.trim()) warnings.push('A ladder title is required.');
  if (rungs.length === 0) warnings.push('A ladder needs at least one rung.');

  if (input.expiresAtMs == null) {
    warnings.push('An expiry is required — an armed ladder is not open-ended authorization.');
  } else if (input.expiresAtMs <= input.now) {
    warnings.push('Expiry must be in the future.');
  }

  if (caps.maxTotalNotionalUsd == null || !(caps.maxTotalNotionalUsd > 0)) warnings.push('A max total notional cap (USD) is required.');
  if (caps.maxTotalLossUsd == null || !(caps.maxTotalLossUsd > 0)) warnings.push('A max total loss cap (USD) is required.');

  // ---- Per-rung validity ----
  for (const r of rungs) {
    const tp = triggerProblem(r);
    if (tp) warnings.push(tp);
    // The autofire watcher only builds price + volume snapshots; funding/indicator
    // triggers would arm but NEVER fire (fail-closed) — reject so an armed rung is honest.
    if (r.triggerKind === 'funding' || r.triggerKind === 'indicator') {
      warnings.push(`rung ${r.seq}: ${r.triggerKind} triggers aren't yet evaluated by the watcher — use a price or volume trigger.`);
    }

    if (INCREASES_EXPOSURE(r.action)) {
      if (r.entryPx == null || !(r.entryPx > 0)) warnings.push(`rung ${r.seq}: needs a positive entry level.`);
      if (r.sizeCoins == null || !(r.sizeCoins > 0)) warnings.push(`rung ${r.seq}: needs a positive size.`);
      if (r.leverage == null || !(r.leverage >= 1)) {
        warnings.push(`rung ${r.seq}: leverage must be ≥ 1.`);
      } else {
        const max = input.coinMaxLeverage(r.coin);
        if (r.leverage > max) warnings.push(`rung ${r.seq}: leverage ${r.leverage}× exceeds ${r.coin} max ${max}×.`);
      }
      // An exposure-increasing rung MUST rest a protective stop on the loss side.
      if (r.stopPx == null || !(r.stopPx > 0)) {
        warnings.push(`rung ${r.seq}: an open/add rung must carry a protective stop.`);
      } else if (r.entryPx != null && r.entryPx > 0 && !stopOnLossSide(r.side, r.entryPx, r.stopPx)) {
        warnings.push(`rung ${r.seq}: stop ${r.stopPx} is not on the loss side of a ${r.side} entry ${r.entryPx}.`);
      }
    } else if (r.sizeCoins != null && !(r.sizeCoins > 0)) {
      warnings.push(`rung ${r.seq}: a reduce/close size must be positive (or null for full close).`);
    }
  }

  // ---- Pyramiding guardrails (§2): per coin, in seq order, over exposure-increasing
  // rungs — adds use DECREASING size, and the stop only ever TIGHTENS. ----
  const byCoin = new Map<string, ArmRung[]>();
  for (const r of rungs) {
    if (!INCREASES_EXPOSURE(r.action)) continue;
    const k = r.coin.toUpperCase();
    (byCoin.get(k) ?? byCoin.set(k, []).get(k)!).push(r);
  }
  for (const [coin, rs] of byCoin) {
    const ordered = [...rs].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      // Decreasing size: each add ≤ the prior rung (keeps the average entry near the
      // first — the opposite of martingale averaging-down).
      if (cur.action === 'add' && cur.sizeCoins != null && prev.sizeCoins != null && cur.sizeCoins > prev.sizeCoins + 1e-12) {
        warnings.push(`${coin}: rung ${cur.seq} add size ${cur.sizeCoins} > prior ${prev.sizeCoins} — adds must DECREASE (no averaging-up beyond the base).`);
      }
      // Tightening stop: the aggregate stop only ever moves toward the mark. long →
      // stop must rise (or hold); short → stop must fall (or hold).
      if (cur.stopPx != null && prev.stopPx != null) {
        const tighter = cur.side === 'long' ? cur.stopPx >= prev.stopPx - 1e-9 : cur.stopPx <= prev.stopPx + 1e-9;
        if (!tighter) {
          warnings.push(`${coin}: rung ${cur.seq} stop ${cur.stopPx} loosens vs prior ${prev.stopPx} — the aggregate stop must only TIGHTEN.`);
        }
      }
    }
  }

  // ---- Caps + per-coin leverage consistency (§3.5) via the risk read ----
  const risk = computeLadderRisk(toRungRisk(rungs), caps);
  warnings.push(...risk.breaches);

  return { warnings, risk };
}

/**
 * Resolve a persisted LadderRung into the ArmRung the validator/risk math consume:
 * entry = the trigger level (price kinds); size = explicit, else risk-based
 * (riskUsd / (entry·stopFrac)); stop = explicit, else derived from stopFrac off entry.
 * PURE. Non-price-triggered rungs keep entry=null (sized at fire against the live mark).
 */
export function resolveArmRung(rung: LadderRung): ArmRung {
  const entryPx = rungEntryPx(rung, null);
  // stopFrac is a fraction of entry — bound to (0, 1), the canonical open-sizer's
  // range. Outside it, leave size/stop unresolved so the validator flags the rung
  // (a >= 1 stopFrac would derive a non-positive long stop / oversize the position).
  const validStopFrac = rung.stopFrac != null && rung.stopFrac > 0 && rung.stopFrac < 1;
  // open/add are RISK-sized to MATCH the fire path (fireOpenOrAdd → buildOpenProposal,
  // which ignores any explicit sizeCoins). Honoring an explicit sizeCoins here would make
  // the ARM-time consent preview diverge from what FIRE executes. An explicit sizeCoins is
  // kept only for reduce/close (the trim amount). Parity = the operator consents to the real size.
  const increasesExposure = rung.action === 'open' || rung.action === 'add';
  let sizeCoins = increasesExposure ? null : rung.sizeCoins;
  if ((sizeCoins == null || !(sizeCoins > 0)) && rung.riskUsd != null && rung.riskUsd > 0 && validStopFrac && entryPx != null && entryPx > 0) {
    sizeCoins = rung.riskUsd / (entryPx * (rung.stopFrac as number));
  }
  let stopPx = rung.stopPx;
  if ((stopPx == null || !(stopPx > 0)) && validStopFrac && entryPx != null && entryPx > 0) {
    const frac = rung.stopFrac as number;
    stopPx = rung.side === 'long' ? entryPx * (1 - frac) : entryPx * (1 + frac);
  }
  return {
    seq: rung.seq,
    coin: rung.coin,
    side: rung.side,
    action: rung.action,
    triggerKind: rung.triggerKind,
    triggerPx: rung.triggerPx,
    triggerMeta: rung.triggerMeta,
    entryPx,
    sizeCoins: sizeCoins ?? null,
    leverage: rung.leverage,
    stopPx: stopPx ?? null,
  };
}

/**
 * The exact phrase a LIVE arm must type — `arm <id8>` (lowercased), where id8 is the
 * ladder's first 8 id chars. Specific to THIS ladder (can't be muscle-memory'd across
 * ladders), mirrors the entry/exit typed-phrase gates. The arm IS the authorization.
 */
export function ladderArmConfirmPhrase(ladder: Pick<Ladder, 'id'>): string {
  return `arm ${ladder.id.slice(0, 8)}`.toLowerCase();
}

/** Map ArmRung[] → the RungRisk[] the risk math consumes. */
function toRungRisk(rungs: ArmRung[]): RungRisk[] {
  return rungs.map((r) => ({
    coin: r.coin,
    side: r.side,
    action: r.action,
    entryPx: r.entryPx,
    sizeCoins: r.sizeCoins,
    leverage: r.leverage,
    stopPx: r.stopPx,
  }));
}
