// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
// "Flip & Recycle": an early-momentum paper-trading bot for the pump.fun
// bonding-curve replay. Paper money only — it never touches a real wallet,
// never trades real funds, and runs entirely inside the replay harness.
//
// Idea: most new pump.fun coins fade within minutes, but a few run hard.
// So the bot only buys a coin once the tape itself proves early buying
// pressure, risks a small fixed stake, and exits fast on a tight plan —
// take the quick double-or-nothing flip, cut losers early, and recycle the
// freed slot and cash into the next fresh coin. Over a 24-hour window that
// turns the 5 open-position slots over many times, which is also what clears
// the guardrail (a >= 0.01 SOL round trip on each of >= 20 distinct mints).
//
// Rules (all deterministic — a pure function of the replayed events, no
// clock, no randomness, no environment; two runs produce identical orders):
//   BUY  (one per mint, 0.05 SOL stake):
//     - price (virtual SOL / virtual token) up between +8% and +80% versus
//       the CreateEvent price, seen within the coin's first 60 trades;
//     - at least 2 of its last 3 trades are buys (real buying pressure,
//       not one wash trade);
//     - the size cap lets it buy at least 0.02 SOL;
//     - a free position slot and enough free cash.
//   SELL (the whole holding, first rule that fires):
//     - take profit at +50% versus the buy price;
//     - stop loss at -20% versus the buy price;
//     - trailing exit: once the peak is +30% or better, sell if the price
//       falls 15% or more below that peak;
//     - timeout: sell after 6000 slots (~40 minutes) whatever the price.
//   The harness closes positions itself when a curve completes, so the bot
//   never needs a sell for those.
//
// Prices are compared with exact bigint cross-multiplication, never floats,
// so the decisions are identical on every run.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --- tunables -------------------------------------------------------------
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL: cap must allow this.
const MAX_SLIPPAGE_BPS = 10_000; // Wide open: never refuse a fill on latency drift.
const ENTRY_MIN_BPS = 800; // Buy only once the price is up >= +8% from create.
const ENTRY_MAX_BPS = 8_000; // ... and not already up more than +80% (no chasing tops).
const ENTRY_MAX_TRADES = 60; // Entry window: the coin's first 60 trades.
const TAKE_PROFIT_BPS = 5_000; // Sell all at +50% vs the buy price.
const STOP_LOSS_BPS = -2_000; // Sell all at -20% vs the buy price.
const TRAIL_ARM_BPS = 3_000; // Trailing stop arms once the peak is +30%.
const TRAIL_DROP_BPS = 1_500; // ... then sell on a 15% fall from the peak.
const MAX_HOLD_SLOTS = 6_000; // Timeout: sell after ~40 minutes in a position.

/** Gain of price (q/t) versus base price (q0/t0), in basis points. */
function gainBps(q: bigint, t: bigint, q0: bigint, t0: bigint): bigint {
  if (q0 === 0n || t0 === 0n || t === 0n) return 0n;
  return (q * t0 * 10_000n) / (t * q0) - 10_000n;
}

interface Coin {
  createQ: bigint;
  createT: bigint;
  trades: number;
  /** Last three trades, true = buy. */
  recentBuys: boolean[];
  decided: boolean; // Bought, skipped, or its buy failed: never reconsider.
  entryQ: bigint | null; // Price reserves at the buy decision.
  entryT: bigint | null;
  entrySlot: number | null;
  peakBps: bigint; // Best gain vs entry since the buy, in bps.
}

const coins = new Map<string, Coin>();

function freshCoin(createQ: bigint, createT: bigint): Coin {
  return {
    createQ,
    createT,
    trades: 0,
    recentBuys: [],
    decided: false,
    entryQ: null,
    entryT: null,
    entrySlot: null,
    peakBps: 0n,
  };
}

await runBot({
  onBatch(state: BotState, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // --- fold this batch's events into the per-coin tape -----------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(
            e.mint,
            freshCoin(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          );
        }
        continue;
      }
      if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined || c.decided) continue;
        c.trades += 1;
        c.recentBuys.push(e.is_buy);
        if (c.recentBuys.length > 3) c.recentBuys.shift();
        if (c.trades > ENTRY_MAX_TRADES) c.decided = true; // Entry window closed.
        continue;
      }
      // CompleteEvent: the curve is done; drop the coin so it never re-enters.
      coins.delete(e.mint);
    }

    // --- clean up entries whose buy never filled (rejected / failed tx) ---
    for (const [mint, c] of coins) {
      if (c.entryQ === null) continue;
      if (state.positions.has(mint)) continue;
      let buyPending = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'buy') {
          buyPending = true;
          break;
        }
      }
      if (!buyPending) {
        // The buy resolved without tokens: one shot per mint, do not retry.
        c.decided = true;
        c.entryQ = null;
        c.entryT = null;
        c.entrySlot = null;
      }
    }

    // --- exits first: free slots and cash before considering new buys ----
    for (const [mint, holding] of state.positions) {
      const c = coins.get(mint);
      if (c === undefined || c.entryQ === null || c.entryT === null || c.entrySlot === null) {
        continue;
      }
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'sell') {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const gain = gainBps(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        c.entryQ,
        c.entryT,
      );
      if (gain > c.peakBps) c.peakBps = gain;
      const timedOut = state.slot - c.entrySlot > MAX_HOLD_SLOTS;
      const trailing =
        c.peakBps >= TRAIL_ARM_BPS && gain <= c.peakBps - TRAIL_DROP_BPS;
      if (gain >= TAKE_PROFIT_BPS || gain <= STOP_LOSS_BPS || trailing || timedOut) {
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(sell);
      }
    }

    // --- entries: fresh coins showing real early buying pressure ---------
    let free = state.freeCashLamports();
    // Orders already queued in this reply also consume cash and slots.
    const queuedBuys = orders.filter((o) => o.side === 'buy').length;
    let slots = caps.max_open_positions - state.committedPositionCount() - queuedBuys;
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      const c = coins.get(e.mint);
      if (c === undefined || c.decided || c.trades < 2) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        c.decided = true;
        continue;
      }
      const gain = gainBps(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        c.createQ,
        c.createT,
      );
      if (gain < ENTRY_MIN_BPS || gain > ENTRY_MAX_BPS) continue;
      const buys = c.recentBuys.filter(Boolean).length;
      if (buys < 2) continue; // Need 2 of the last 3 trades to be buys.
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      c.decided = true;
      c.entryQ = curve.virtual_quote_reserves;
      c.entryT = curve.virtual_token_reserves;
      c.entrySlot = state.slot;
      c.peakBps = 0n;
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
