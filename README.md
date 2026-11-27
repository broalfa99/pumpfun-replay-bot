# Pump.fun Replay Sprint — Flip & Recycle Paper Bot

[![make.fun bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/broalfa99/pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/broalfa99/pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A TypeScript paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. Paper money only — it never connects a real wallet, never trades real funds.

## Strategy: Flip & Recycle

Most new pump.fun coins fade within minutes; a few run hard. The bot only buys once the tape itself proves early buying pressure, risks a small fixed stake, and exits fast:

- **Buy** (one per mint, 0.05 SOL): price up +1% to +20% vs the CreateEvent price within the coin's first 8 trades, with at least 2 of its last 3 trades buys, and the size cap allowing at least 0.02 SOL.
- **Sell** (whole holding): take profit +10%, stop loss −5%, trailing exit (peak ≥ +8%, then a 4% fall from the peak), or a 300-slot (~2 min) timeout.
- Fast exits recycle the 5 open-position slots and the 10 SOL of paper capital across many coins, clearing the guardrail of a ≥ 0.01 SOL round trip on each of ≥ 20 distinct mints.

Everything is deterministic — a pure function of the replayed events, no clock, no randomness, no environment — so the two grading runs produce identical orders. Prices are compared with exact bigint cross-multiplication, never floats.

## Run

```sh
node main.ts
```

The entrypoint is `main.ts` at the repo root, run by the grader as `node /bot/main.ts` (Node 22 runs TypeScript natively). The SDK shim is vendored at `vendor/makefun-bot.ts`.

## License

MIT — see [LICENSE](LICENSE).
