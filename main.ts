// FadeCatcher — a paper-trading bot for the Pump.fun Bot Sprint.
// Reads the agent-fun/replay/v2 stream (hello / batch / done) on stdin and
// answers every batch with one reply carrying its orders. Paper trading only.
//
// Strategy (long-only, one buy per mint ever, never short):
//   * Buy a young coin whose price is climbing but has NOT already faded:
//     price up >= 7% over the last ~2 min, still within 3% of its ~4 min high
//     (the reversion filter: a coin that spiked and already pulled back is
//     skipped), and not overextended: <= 30% above its first-seen price.
//   * Size 0.10 SOL per buy, capped under the per-mint order-size cap.
//   * Sell on take-profit +30%, stop-loss -12%, a ~20 min max hold, or when
//     the curve completes. Deterministic: no clock, no randomness, no network;
//     mints are considered in sorted order every batch.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, Curve, OrderInput } from './vendor/makefun-bot.ts';

const BUY_SIZE = LAMPORTS_PER_SOL / 10n; // 0.10 SOL per buy
const MIN_BUY = 10_000_000n; // 0.01 SOL round-trip gate
const MAX_SLIPPAGE_BPS = 500;
const YOUNG_SLOTS = 13_500; // ~90 min at ~2.5 slots/s
const MOMENTUM_WINDOW = 300; // ~2 min lookback for the momentum read
const MOMENTUM_MIN = 1.1; // need +10% over the lookback window
const HIGH_WINDOW = 600; // ~4 min window for the "still near its high" test
const NEAR_HIGH_MIN = 0.98; // current price must hold >= 98% of recent high
const OVEREXTENDED_MAX = 1.3; // skip coins already > 30% above first price
const MIN_TRADES = 4; // need a little tape before trusting the price
const TAKE_PROFIT = 1.4; // sell at +40%: let the few runners pay for the losers
const STOP_LOSS = 0.92; // sell at -8%: cut fades fast, they rarely come back
const MAX_HOLD_SLOTS = 3_000; // ~20 min max hold
const HISTORY_CAP = 96; // price samples kept per candidate mint

interface MintTrack {
  firstSlot: number;
  firstPrice: number;
  /** [slot, price] samples, oldest first. */
  samples: Array<[number, number]>;
  buySlot: number | null;
}

const tracks = new Map<string, MintTrack>();
const traded = new Set<string>();

function priceOf(curve: Curve): number {
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

/** Price of the mint at (or just before) a target slot, from its samples. */
function priceAt(track: MintTrack, targetSlot: number): number | null {
  let found: number | null = null;
  for (const [slot, price] of track.samples) {
    if (slot > targetSlot) break;
    found = price;
  }
  return found;
}

/** Highest sampled price inside the recent window ending at `slot`. */
function recentHigh(track: MintTrack, slot: number, window: number): number {
  let high = 0;
  for (const [s, price] of track.samples) {
    if (s >= slot - window && price > high) high = price;
  }
  return high;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = batch.slot;
  const maxOpen = state.hello.caps.max_open_positions;

  // Refresh the price history of every young, never-traded, live candidate.
  for (const [mint, curve] of state.curves) {
    // A mint already traded and no longer held needs no history; a held mint
    // keeps its track so the max-hold exit can read its buy slot.
    if ((traded.has(mint) && !state.positions.has(mint)) || curve.complete) {
      tracks.delete(mint);
      continue;
    }
    const firstSlot = curve.created_slot ?? curve.reserves_slot;
    // Age out old candidates, but never a mint currently held: its track
    // carries the buy slot the max-hold exit reads.
    if (slot - firstSlot > YOUNG_SLOTS && !state.positions.has(mint)) {
      tracks.delete(mint);
      continue;
    }
    const price = priceOf(curve);
    if (price <= 0) continue;
    let track = tracks.get(mint);
    if (track === undefined) {
      track = { firstSlot, firstPrice: price, samples: [], buySlot: null };
      tracks.set(mint, track);
    }
    const last = track.samples[track.samples.length - 1];
    if (last === undefined || last[0] !== slot) {
      track.samples.push([slot, price]);
      if (track.samples.length > HISTORY_CAP) track.samples.shift();
    }
  }

  // Exits first: every held position is judged on its own value vs cost.
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    const track = tracks.get(mint);
    const price = curve !== undefined ? priceOf(curve) : 0;
    const cost = Number(holding.cost_lamports);
    const value = Number(holding.token_amount) * price;
    const ratio = cost > 0 && price > 0 ? value / cost : 0;
    const buySlot = track?.buySlot;
    const heldTooLong = buySlot !== null && buySlot !== undefined && slot - buySlot >= MAX_HOLD_SLOTS;
    const completed = curve !== undefined && curve.complete;
    if (completed || ratio >= TAKE_PROFIT || (ratio > 0 && ratio <= STOP_LOSS) || heldTooLong) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // Entries: one buy per mint, only while a position slot is free.
  if (state.committedPositionCount() < maxOpen) {
    const mints = [...tracks.keys()].sort();
    for (const mint of mints) {
      if (state.committedPositionCount() >= maxOpen) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (traded.has(mint) || state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      const track = tracks.get(mint);
      if (curve === undefined || track === undefined || curve.complete) continue;
      if (curve.trades < MIN_TRADES) continue;
      const price = priceOf(curve);
      if (price <= 0) continue;
      // Momentum: up >= 7% over the lookback window.
      const oldPrice = priceAt(track, slot - MOMENTUM_WINDOW);
      if (oldPrice === null || oldPrice <= 0) continue;
      if (price < oldPrice * MOMENTUM_MIN) continue;
      // Reversion filter: still near its recent high (has not faded already).
      const high = recentHigh(track, slot, HIGH_WINDOW);
      if (high <= 0 || price < high * NEAR_HIGH_MIN) continue;
      // Not overextended from where it started.
      if (price > track.firstPrice * OVEREXTENDED_MAX) continue;
      // Size: 0.10 SOL, capped under the mint's order-size cap, never tiny.
      const cap = state.maxBuyLamports(mint);
      let size = BUY_SIZE;
      const capped = (cap * 9n) / 10n;
      if (capped < size) size = capped;
      if (size < MIN_BUY) continue;
      if (state.freeCashLamports() < size + 2n * state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
      traded.add(mint);
      track.buySlot = slot;
    }
  }

  return orders;
}

await runBot({ onBatch });
