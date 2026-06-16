/**
 * Live smoke test (NOT a unit test — hits real Supabase + real Hyperliquid).
 *
 * Run: pnpm tsx --tsconfig tsconfig.scripts.json scripts/_smoke.ts
 *
 * Step 1 (Supabase): connect with the server (service-role) client, INSERT a
 * test `sessions` row, write a child `context_gauge` row (proves FK + child
 * write), read both back, then DELETE the session (cascade removes children) so
 * the DB is left clean.
 *
 * Step 2 (Hyperliquid live): fetch BTC 1h candles for the last 2 days and the
 * BTC l2Book (the orderbook path paperFill depends on).
 *
 * Prints PASS/FAIL per step with concrete (non-secret) values.
 */

import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';

// Load .env.local before importing anything that reads process.env at module
// init. Node 24 provides process.loadEnvFile natively (no dotenv dependency).
try {
  process.loadEnvFile('.env.local');
} catch {
  // .env.local may be absent in CI — env vars may already be set in the shell.
}

let failures = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`FAIL  ${msg}`);
};

async function smokeSupabase(): Promise<void> {
  console.log('\n=== Step 1: Supabase (server service-role client) ===');
  // Import AFTER env is loaded; the module reads env lazily at call time anyway.
  const { getServiceRoleClient } = await import('@/lib/cockpit/supabase-server');

  let db;
  try {
    db = getServiceRoleClient();
  } catch (err) {
    fail(`could not construct service-role client: ${String(err)}`);
    return;
  }

  // INSERT a test session.
  const { data: session, error: insErr } = await db
    .from('sessions')
    .insert({ status: 'active', mode: 'paper', title: '__smoke_test__' })
    .select('id, status, mode, title')
    .single();
  if (insErr || !session) {
    fail(`INSERT sessions failed: ${insErr?.message ?? 'no row returned'}`);
    return;
  }
  pass(`INSERT sessions -> id=${session.id} status=${session.status} mode=${session.mode}`);
  const sessionId: string = session.id;

  try {
    // Child write (proves FK).
    const { data: gauge, error: gErr } = await db
      .from('context_gauge')
      .insert({ session_id: sessionId, approx_pct: 12.5, zone: 'ok' })
      .select('id, session_id, approx_pct, zone')
      .single();
    if (gErr || !gauge) {
      fail(`INSERT context_gauge (child/FK) failed: ${gErr?.message ?? 'no row returned'}`);
    } else {
      pass(`INSERT context_gauge -> id=${gauge.id} approx_pct=${gauge.approx_pct} zone=${gauge.zone}`);
    }

    // Read both back.
    const { data: readSession, error: rsErr } = await db
      .from('sessions')
      .select('id, title')
      .eq('id', sessionId)
      .single();
    if (rsErr || !readSession) {
      fail(`read-back sessions failed: ${rsErr?.message ?? 'not found'}`);
    } else {
      pass(`read-back sessions -> id matches=${readSession.id === sessionId} title=${readSession.title}`);
    }

    const { data: readGauges, error: rgErr } = await db
      .from('context_gauge')
      .select('id, zone')
      .eq('session_id', sessionId);
    if (rgErr || !readGauges) {
      fail(`read-back context_gauge failed: ${rgErr?.message ?? 'not found'}`);
    } else {
      pass(`read-back context_gauge -> child rows=${readGauges.length}`);
    }
  } finally {
    // Cleanup: delete the session; FK cascade removes context_gauge children.
    const { error: delErr } = await db.from('sessions').delete().eq('id', sessionId);
    if (delErr) {
      fail(`cleanup DELETE sessions failed (DB NOT clean): ${delErr.message}`);
    } else {
      // Verify cascade actually removed the child.
      const { count } = await db
        .from('context_gauge')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sessionId);
      if (count && count > 0) {
        fail(`cleanup: ${count} orphan context_gauge rows remain (cascade did not fire)`);
      } else {
        pass('cleanup DELETE sessions -> session removed, cascade cleared children (DB clean)');
      }
    }
  }
}

async function smokeHyperliquid(): Promise<void> {
  console.log('\n=== Step 2: Hyperliquid live ===');
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

  const candleRes = await fetchCandles('BTC', '1h', twoDaysAgo, now);
  if (candleRes.error || candleRes.candles.length === 0) {
    fail(`fetchCandles(BTC,1h,now-2d,now): ${candleRes.error ?? 'zero candles'}`);
  } else {
    const last = candleRes.candles[candleRes.candles.length - 1];
    pass(
      `fetchCandles(BTC,1h,now-2d,now) -> count=${candleRes.candles.length} ` +
        `lastClose=${last.close} stale=${candleRes.stale}`,
    );
  }

  try {
    const book = await fetchL2Book('BTC');
    if (book.bids.length === 0 || book.asks.length === 0) {
      fail(`fetchL2Book(BTC) returned empty book: bids=${book.bids.length} asks=${book.asks.length}`);
    } else {
      const bestBid = book.bids[0].px;
      const bestAsk = book.asks[0].px;
      pass(
        `fetchL2Book(BTC) -> bids=${book.bids.length} asks=${book.asks.length} ` +
          `bestBid=${bestBid} bestAsk=${bestAsk} mid=${((bestBid + bestAsk) / 2).toFixed(1)}`,
      );
    }
  } catch (err) {
    fail(`fetchL2Book(BTC) threw: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  await smokeSupabase();
  await smokeHyperliquid();
  console.log(`\n=== SMOKE ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s)) ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
