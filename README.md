# Escalating Impulse — cbBTC trading bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![Rank](https://make.fun/badge/btc-race-24h-20261117-0603/madara200599/btc-race-bot-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![Reward](https://make.fun/badge/btc-race-24h-20261117-0603/madara200599/btc-race-bot-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

A make.fun bounty entry for **btc-race-24h-20261117-0603** ("Race a BTC trading bot
live for 24 hours"). The bot trades Coinbase Wrapped BTC (cbBTC) against USDC,
long only, on 1-minute bars, starting from $1,000 of paper money.

## Strategy: escalating impulse

On a choppy 1-minute market a full round trip costs about 26 bps in fees,
slippage and pool impact, so only unusually strong short bursts are worth
chasing. The bot watches the 5-minute return and buys the whole cash balance
when it jumps past a threshold, then rides the burst with a trailing stop and a
hard time stop. The threshold **escalates down as the window runs out**,
because a bot that never trades cannot place — late in the window a smaller,
half-size entry on a weaker 10-minute signal is better than sitting in cash.

- **Phase 1, bars 0–719:** 5-min return > 60 bps → full-size entry.
- **Phase 2, bars 720–1199:** 5-min return > 50 bps → full-size entry.
- **Phase 3, bars 1200+:** 10-min return > 40 bps → half-size entry.
- **Exits:** trailing stop 60 bps below the peak close since entry (50 bps for
  a phase-3 entry), or a time stop of 25 bars (20 for phase 3), whichever comes
  first.
- **Cooldown:** 15 bars flat after every exit before the next entry may fire.

Long only, one position, no leverage. Deterministic: every decision is a pure
function of the bars seen so far and the account the harness reports — no
clock, no network, no randomness, no files outside the repo.

## Measured results (dev window, kit's own grader)

Graded locally with the kit's `grade-local --driver process` (run twice;
both runs identical):

| Metric | Value |
|---|---|
| Net PnL | **+9.383285 USDC** (+0.938% return) |
| Trades | 4 (2 round trips, 50% win rate) |
| Fees paid | 1.208286 USDC |
| Max drawdown | 0.4576% |
| Net PnL at 2x fees | +8.172209 USDC |
| Guardrails | met (≥1 trade, drawdown ≤ 25%) |
| Determinism | L1 regrade reproduced byte for byte |
| result_sha256 | `0f060869524a6186bcee0ad9e5c7ffdfcf09f65466d25811daf8fcae299997c7` |

House baselines on the same dev window, for comparison: buy-and-hold +$1.07,
momentum +$2.45, ema-cross −$106.21, rsi-bollinger −$24.25, adx-momentum
−$32.66. The parameters were checked to stay profitable across a wide grid
around the chosen values (all 108 nearby configurations positive on the dev
window, worst +$2.59), not tuned to a single knife-edge point.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim.

## Grade locally

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Entered via referral code tvfbjxfd
