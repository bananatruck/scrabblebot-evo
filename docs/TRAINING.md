# How Nijello was trained

All training ran on one NVIDIA DGX Spark during Cal Hacks 13.0 (October 23-24, 2026).
About 17.0 million simulated matches across six runs, at roughly 1,000 matches per second.

## The machine

| | |
|---|---|
| Machine | NVIDIA DGX Spark (GB10) |
| CPU | 20 Arm cores (10 Cortex-X925 + 10 Cortex-A725) |
| Memory | 121 GiB unified CPU/GPU memory |
| Runtime | Node 24, TypeScript run directly (type stripping, no build step) |
| Throughput | 850-1,070 matches/s on 16-19 worker threads |

The search is CPU-bound: each candidate plays hundreds of full matches, and matches are branchy dictionary walks, not tensor math.
The GPU was tried for a local LLM match reviewer (Qwen 3.5 27B on Ollama), and dropped: see [OPERATIONS.md](OPERATIONS.md).

## The optimizer

[CMA-ES](https://arxiv.org/abs/1604.00772) over 48 weights (26 per-letter keep values plus 22 strategy weights), each searched in a normalized space where one unit is a quarter of its allowed range.

- **Population:** 64 candidates per generation, 400 matches each, 25,600 matches per generation.
- **Common random numbers:** every candidate in a generation plays the same 400 tables, so differences are skill, not luck.
- **Fitness:** mean placing score `(n - place) / (n - 1)`, the tournament's Swiss points, plus a tiny score tiebreak.
- **Hall of fame:** every 25 generations the mean joins a league of past champions (up to 24), so the bot can't forget how to beat itself.
- **Confirmed peaks:** a new best is only written after it beats the previous best on 3,000 fresh matches. One lucky benchmark can't replace it.

## Runs, in order

| Run | Opponents | Generations | Matches | What it taught us |
|---|---|---|---|---|
| v1-selfplay | sims, starter kits, past champions | 107 | 2.75M | Self-play plateaus: the bot gets good at beating itself. |
| v2-field | models of the live field's bids | 218 | 5.67M | Training against the real field moves the needle. |
| v3-endgame | v2 + endgame dump rules | 34 | 0.90M | Value the last tiles by the exact final dump; bid everything at the last playable tile. |
| main | refreshed field data | 26 | 0.68M | The live-deployed baseline. |
| v4-refresh | newest top-bot models | 188 | 4.91M | 127 generations without a confirmed gain, then one at generation 180, which Nijello plays live. The opponent models had little left to teach. |
| v5-profiles | calibrated profiles of 53 live bots | running | 2.08M+ | The current run. |

## The lesson that mattered most

When v4 stalled at generation 127, its benchmark said Nijello wins 88% of matches against models of the top live bots.
Live, over the same hours, it won about a third (13 of 42 matches).

Those models only copied what each bot had paid before.
Real bots bid on what a letter is worth to their own rack, so the table regularly has someone bidding 25-30+ for exactly the tile that completes their word.
Nijello's real win rate by its own bid shows it: a 15-24 coin bid wins only 33% of the time live.

So we stopped trusting the simulator and started measuring the field: [PROFILING.md](PROFILING.md).
Even the first bid profiles, fitted per bot on its own rack and coins, replayed Nijello's real matches as a 99% win until we calibrated how far the table's top bid sits above the price paid.
Calibrated, the replay gives 67%, with prices, top bids and Nijello's win rate by bid all matching live.
Against these opponents the live parameters win 57% in training instead of 86%, which is closer to reality and leaves real room to improve.

## Running it yourself

```bash
scripts/fetch-wordlist.sh                 # the official dictionary
node src/field.ts                         # live leaderboard + field models -> data/field.json
node src/profile.ts --recent 40           # profile every live bot -> data/profiles.json
node src/profile.ts --calibrate params/nijello-live.json --since <first match played with it>
FOCUS="postturing,Chinese Dante" node src/train.ts --hours 10 --workers 18 \
  --lambda 64 --games 400 --hof-every 25 --hof-max 24 --bench-every 10 \
  --init params/nijello-live.json --sigma 0.25 --out runs/v5-profiles
node src/dashboard.ts --run runs/v5-profiles   # live terminal dashboard
```

`FOCUS` sends half of the top-bot seats to the named bots, here the two highest-rated at the time.
