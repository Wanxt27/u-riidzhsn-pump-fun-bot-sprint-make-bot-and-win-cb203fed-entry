# Pump Sprint — FadeCatcher Paper Bot

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Wanxt27/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Wanxt27/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Referral code: `qzc860x6`

A paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on make.fun. One program, `main.ts` (Node 22), speaking the `agent-fun/replay/v2` protocol: it reads `hello` / `batch` / `done` NDJSON on stdin and answers each batch with one `reply` carrying its orders. Paper trading only — no real funds, ever.

## Strategy

Long-only momentum entry with a reversion filter, one buy per mint, ever:

- **Price** per mint = virtual quote reserves / virtual token reserves, from the bot's own per-mint price history (sampled each batch).
- **Buy** a young coin (first seen within ~90 min) when its price is up ≥10% over the last ~2 min, still within 2% of its ~4 min high (the reversion filter: a coin that spiked and already faded is skipped), and not overextended (≤30% above its first-seen price). Needs at least 4 trades on the curve first.
- **Size** 0.10 SOL per buy, capped under 90% of the mint's per-order size cap, never below the 0.01 SOL round-trip gate.
- **Sell** on take-profit +40%, stop-loss −8%, a ~20 min max hold, or a `CompleteEvent`.
- **Never re-buys** a mint it already traded, and never shorts. Deterministic: no randomness, no clock, no network; mints considered in sorted order.

## Dev grade (kit's `grade-local`, `--driver process`)

- Net PnL **−0.121 SOL** on the dev window (90% interval −0.332 … +0.102 SOL), return −1.2%
- **80 coins** traded, 80 round trips (≥ 0.01 SOL each), 160 fills, win rate 18.8%
- Max drawdown **2.8%** — guardrails met (≥ 20 coins, drawdown ≤ 50%)
- Two executions reproduce byte for byte (deterministic); 34 orders rejected, 4 failed
- Fees: 0.097 SOL curve + 0.017 SOL tx; net PnL at 2× fees −0.233 SOL
- Top 3 coins made 39% of the gains; without them net PnL is −0.25 SOL

The dev window is a hard tape for momentum (most coins fade after their first spike). The bot is built to survive it with a small drawdown and a wide coin count rather than to chase a single runner. PnL is below holding cash on this window, so it would rank but win no prize here; the final tape is recorded after entries close, so the same rules run on unseen coins.

## Run

```sh
node main.ts  # reads agent-fun/replay/v2 NDJSON on stdin, replies on stdout
```

## License

MIT — see [LICENSE](LICENSE).
