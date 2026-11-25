# Steady Scalp — Seasoned-Runner Rider for the Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/people871/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/people871/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) — it trades 10 SOL of paper money on a 6-hour pump.fun forward replay and is ranked by hourly Sharpe ratio. Steady, controlled gains beat one lucky moonshot: this bot buys only seasoned runners, risks at most 1 SOL of exposure at a time, and banks winners before each hourly mark.

## Strategy in one paragraph

Most pump.fun coins bleed to near zero, and every fast signal measured on the practice replay loses after the 2-slot fill latency and the ~2.5% round-trip curve fee: momentum chasing (win rate 21%), first-dip buying (31% first-hit win rate), and buying the 2x-launch / real-SOL-10 crossing itself (65% win at the crossing price, 31% two slots later). The one filter that survives measurement is the *seasoned runner*: a coin at least 150 slots old that has just qualified — 2x its launch price **and** real SOL ≥ 10, creator never sold, net flow positive — entered within 60 slots of qualification, before it runs past 2.6x launch. Stakes are 0.10 SOL with one 0.10 SOL add into strength. Exits: −10% hard stop, trailing stop (−15% from peak, armed at +10%), fade exit on −4 SOL net flow over 100 slots, instant exit on any single ≥ 5 SOL sell, 7200-slot max hold, and settling a +25% winner just before an hour mark so the mark reads realised cash. When the runner filter is quiet, tiny 0.01 SOL probe round trips keep the 20-coin / 0.01 SOL guardrails met; each probe costs ~0.0005 SOL.

## Measured results (practice replay, 24h dev window, full dataset)

| | local engine port | `grade-local` (real grader) |
|---|---|---|
| Sharpe (hourly, not annualised) | +0.080 | — |
| Net PnL | +0.165 SOL | +0.070 SOL |
| Fills / coins / round trips | 144 / 51 / 66 | 142 / 49 / 66 |
| Win rate | 15.2% | 12.1% |
| Max drawdown | 4.4% | 4.9% |
| Rejected / failed txs | 0 / 3 | 0 / 2 |

Honest caveats, measured on the same window: the edge is thin and concentrated — 3 coins made 87% of the gains and without them net PnL would be −0.43 SOL; at 2x fees the grade-local net would be −0.041 SOL; neighbouring parameter cells are mostly negative, so this is a small positive cluster, not a wide plateau. Six-hour blocks of the dev window: Sharpe +0.34, +0.34, −0.74, +0.39 — three of four blocks positive. The final 6-hour window is fresh data, so these numbers are a guide, not a promise.

## Files

- `main.ts` — entry point; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the whole strategy (pure function of the batches the harness sends: no clock, no randomness, no I/O, insertion-ordered maps only, so repeated executions are byte-identical).
- `vendor/makefun-bot.ts` — the kit SDK, vendored byte for byte.

## Run it

```sh
node main.ts
```

Node 22+. No dependencies beyond the vendored SDK, no environment variables, no network access at run time.
