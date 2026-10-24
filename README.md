# scrabblebot-evo

**Nijello**, an evolved bot for the [Cal Hacks 13.0 ScrabbleBot](https://scrabblebot.spacetimedb.com/) arena: sealed-bid letter auctions where six bots bid coins for tiles and race to spell high-scoring words.

Nijello's 48 strategy weights were evolved over about 17 million simulated matches on one NVIDIA DGX Spark.
It trains against statistical profiles of every competitive bot on the live server, fitted from public match data.
New strategies reach the live bot only after they beat it on replays of its own real matches.

## Results

Live arena, October 24, 2026, among 57 bots with 3+ matches:

| | |
|---|---|
| Peak rank | **4th**, rating 2145 |
| Matches played | 99 |
| Win rate | **34%** (a random seat at a 6-bot table wins 17%) |
| Average place | 2.58 |
| Decision time | 0.2 ms median, 1.6 ms at the 99th percentile, in a 1,000 ms auction |

Over their last ~75 matches each, Nijello and Chinese Dante (2nd on the leaderboard) were dead even: 34% vs 32% wins, average place 2.57 vs 2.55.

## What's different here

**A simulator checked against reality.**
Most bots are tuned in a simulator and hoped to transfer.
We replayed Nijello's real matches in ours and found it said 99% wins where reality said 31%.
So we profiled every live bot's bidding with censored regression (a loser's bid is only known to be below the price paid), calibrated until replays reproduce live prices, top bids and Nijello's own win rate at each bid level, and only then trained against it.
Details: [docs/PROFILING.md](docs/PROFILING.md).

**Evolution at scale.**
CMA-ES with common random numbers, a hall of fame of past champions, and peaks that must be confirmed on 3,000 fresh matches.
An anagram-signature trie made a full match take 1-3 ms, which is what made 17 million training matches fit in one night.
Details: [docs/TRAINING.md](docs/TRAINING.md).

**Look-ahead in the endgame.**
The evolved policy decides in 0.2 ms and then has most of a second to spare.
In the last 12 auctions Nijello bids at once, then plays the rest of the match out hundreds of times against the actual opponents' profiles and replaces its bid when a candidate is clearly better.
On replays of 67 real matches it raised the win rate from 63.4% to 69.8% (placing score +0.023 +- 0.006).
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**A release gate.**
Training proposes; real matches decide.
`ops/release.sh` replays our live matches with the current and the candidate parameters on identical tables, and swaps the live bot's parameters only on a win by more than two standard errors, at a match boundary.
Details: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Quick start

Requires Node 24 (TypeScript runs directly, no build step).

```bash
scripts/fetch-wordlist.sh      # official 172,820-word dictionary, checksum-verified
npm test                       # dictionary, strategy and regression tests
node src/bench.ts              # benchmark the default strategy
node src/field.ts              # pull the live leaderboard and field data
node src/profile.ts            # profile every live bot
node src/train.ts --hours 1 --out runs/try
node src/dashboard.ts --run runs/try
```

Play live (needs a bot token from the arena's Team page):

```bash
cd live && npm install
BOT_NAME=<your bot> BOT_TOKEN=<token> PARAMS=../params/nijello-live.json ./run.sh
```

After the first connection the client stores the token in `live/.token-<name>` (git-ignored), so later starts can drop `BOT_TOKEN`.

## Repository map

| Path | What it is |
|---|---|
| `RULES.md` | The game's rules, verified against the server source |
| `src/dict.ts` | Dictionary trie: best word, best 7+ word, best disjoint word set |
| `src/strategy.ts` | Nijello's decision function and its 48 weights |
| `src/planner.ts` | Endgame look-ahead: plays the match out per candidate bid |
| `src/game.ts` | Match simulator mirroring the server |
| `src/opponents.ts` | Server sims, starter kit, field models, `ProfileBot` |
| `src/train.ts`, `src/cmaes.ts`, `src/tables.ts`, `src/worker.ts` | The evolution |
| `src/field.ts`, `src/profile.ts`, `src/tobit.ts`, `src/calibrate.ts` | Measuring the live field |
| `src/dashboard.ts`, `src/monitor.ts`, `src/latency.ts` | Terminal dashboard and live monitor |
| `live/` | SpacetimeDB client for the real arena |
| `viewer/` | Web viewer: showcase matches and the live record |
| `ops/` | Recovery and release scripts |
| `params/nijello-live.json` | The parameters Nijello plays live |
| `docs/` | Architecture, training, profiling, operations |

## Credits

Game, server and dictionary: [clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot) (MIT), built on SpacetimeDB.
Built at Cal Hacks 13.0.
