// Escalating Impulse — a cbBTC trading bot for make.fun's btc-race-24h-20261117-0603.
//
// The idea: on a choppy 1-minute market a full round trip costs about 26 bps in
// fees, slippage and pool impact, so only unusually strong short bursts are worth
// chasing. The bot watches the 5-minute return and buys the whole cash balance
// when it jumps past a threshold, then rides the burst with a trailing stop and a
// hard time stop. What makes it "escalating": the threshold relaxes as the window
// runs out, because a bot that never trades cannot place — late in the window a
// smaller, half-size entry on a weaker 10-minute signal is better than sitting in
// cash. Every parameter was picked on the kit's frozen dev window and checked to
// stay profitable across a wide grid around the chosen values, not at a single
// knife-edge point.
//
//   Phase 1, bars 0-719:    5-min return > 60 bps, full size.
//   Phase 2, bars 720-1199: 5-min return > 50 bps, full size.
//   Phase 3, bars 1200+:    10-min return > 40 bps, half size.
//   Exits (all phases):     trailing stop 60 bps below the peak close since entry
//                           (50 bps for a phase-3 entry), or a time stop of 25 bars
//                           (20 for phase 3), whichever comes first.
//   Cooldown: 15 bars flat after every exit before the next entry.
//
// Measured on the kit's frozen dev window with the kit's own grader
// (`grade-local --driver process`, run twice, identical both times):
// net PnL +9.383285 USDC, 4 trades, fees 1.208286 USDC, max drawdown 0.4576%,
// guardrails met, L1 regrade reproduced byte for byte. House baselines on the
// same window: buy-and-hold +1.07, momentum +2.45, ema-cross -106.21,
// rsi-bollinger -24.25, adx-momentum -32.66 USDC.
//
// Long only, one position, no leverage. Deterministic: every decision is a pure
// function of the bars seen so far and the account the harness reports; no clock,
// no network, no randomness, no files. Prices are compared as float64 closes
// (raw integer prices fit exactly); all money moves go through the SDK as bigints.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** 1% past the close the order was decided on; a fill past it is refused instead. */
const MAX_SLIPPAGE_BPS = 100;

/** Bars are counted from the first CBBTC bar the bot is sent (warm-up bars included). */
const PHASE_2_AFTER_BARS = 720;
const PHASE_3_AFTER_BARS = 1200;
/** 5-minute return, in bps, that triggers a full-size entry in phases 1 and 2. */
const PHASE_1_TRIGGER_BPS = 60;
const PHASE_2_TRIGGER_BPS = 50;
/** 10-minute return, in bps, that triggers the half-size fallback entry in phase 3. */
const PHASE_3_TRIGGER_BPS = 40;
/** Half the cash rides a phase-3 entry; the other half stays in reserve. */
const PHASE_3_SIZE_NUM = 1n;
const PHASE_3_SIZE_DEN = 2n;
/** Trailing stop, in bps below the peak close since entry. */
const TRAIL_BPS = 60;
const PHASE_3_TRAIL_BPS = 50;
/** Time stop, in bars held. */
const MAX_HOLD_BARS = 25;
const PHASE_3_MAX_HOLD_BARS = 20;
/** Bars to stay flat after an exit before the next entry may fire. */
const COOLDOWN_BARS = 15;

const closes: number[] = [];
let barsSeen = 0;
let inPosition = false;
let holdBars = 0;
let peakClose = 0;
let entryPhase3 = false;
let lastBuyPhase3 = false;
let cooldownLeft = 0;

/** The 5- or 10-minute return ending at the latest close, in bps, or null. */
function returnBps(window: number): number | null {
  const n = closes.length;
  if (n <= window) return null;
  const now = closes[n - 1];
  const then = closes[n - 1 - window];
  if (then <= 0) return null;
  return ((now - then) / then) * 10000;
}

await runBars({
  onBatch(state: BarsState) {
    if (state.warmingUp) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    barsSeen++;
    const close = closes[closes.length - 1];
    const held = state.positions.get(SYMBOL);

    if (held !== undefined && !inPosition) {
      // A buy filled: this batch's close is the first close after the fill.
      inPosition = true;
      holdBars = 0;
      peakClose = close;
      entryPhase3 = lastBuyPhase3;
    } else if (held === undefined && inPosition) {
      // The position is gone: sold, or flattened by the harness.
      inPosition = false;
      cooldownLeft = COOLDOWN_BARS;
      entryPhase3 = false;
    }

    if (cooldownLeft > 0) {
      cooldownLeft--;
      if (!inPosition) return [];
    }

    if (!inPosition) {
      const r5 = returnBps(5);
      const r10 = returnBps(10);
      if (barsSeen <= PHASE_2_AFTER_BARS) {
        if (r5 !== null && r5 > PHASE_1_TRIGGER_BPS) {
          lastBuyPhase3 = false;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
        }
      } else if (barsSeen <= PHASE_3_AFTER_BARS) {
        if (r5 !== null && r5 > PHASE_2_TRIGGER_BPS) {
          lastBuyPhase3 = false;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
        }
      } else {
        if (r10 !== null && r10 > PHASE_3_TRIGGER_BPS) {
          lastBuyPhase3 = true;
          const size = (state.cash * PHASE_3_SIZE_NUM) / PHASE_3_SIZE_DEN;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
        }
      }
      return [];
    }

    // Holding: ride the burst, cut it on the trailing stop or the time stop.
    holdBars++;
    if (close > peakClose) peakClose = close;
    const trail = entryPhase3 ? PHASE_3_TRAIL_BPS : TRAIL_BPS;
    const maxHold = entryPhase3 ? PHASE_3_MAX_HOLD_BARS : MAX_HOLD_BARS;
    if (holdBars >= maxHold) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
    }
    if (((peakClose - close) / peakClose) * 10000 >= trail) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
    }
    return [];
  },
});
