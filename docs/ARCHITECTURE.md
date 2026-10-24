# Architecture

Nijello is one decision function, shared by a fast simulator and a live client.
Everything that makes it strong (the tuned weights, the opponent models, the release gate) exists to feed that one function better numbers.

## The game in one paragraph

Six bots start with 5 hidden tiles and 100 coins.
The remaining 68 tiles are auctioned one at a time, one second each, sealed-bid, second-price (the winner pays the runner-up's bid).
At any moment a bot can spell a word from its rack; the reward is the sum of letter values times a length multiplier (1x up to 3 letters, 1.5x at 4, 2x at 5, 2.5x at 6, 3x at 7+), added to both score and coins.
Coins left at the end are worthless, and the last tile can never be played.
Full rules, checked against the server source: [RULES.md](../RULES.md).

## Layers

```
            data/wordlist.txt (172,820 words)
                        |
src/dict.ts      anagram-signature trie: best word, best 7+ word, best disjoint word set
                        |
src/strategy.ts  EvoBot: rack potential Q, letter value, budgeted bid, endgame dump  <-- 48 tuned weights
src/planner.ts   PlannerBot: endgame look-ahead over candidate bids, ~450 ms per decision
                        |
        +---------------+----------------+
        |                                |
src/game.ts  simulator             live/bot.ts  SpacetimeDB client
  (1-3 ms per match)                 (0.2 ms median per decision)
        |
src/opponents.ts + src/tables.ts   who Nijello trains against
        |
src/train.ts (CMA-ES)  ->  best.json  ->  ops/release.sh (replay gate)  ->  runs/live/params.json  ->  live bot
```

## Decision function (`src/strategy.ts`)

Three ideas, each with tunable weights.

**Calculation.**
For every auction, the bot measures what the letter on sale adds: the change in rack potential `Q(rack)` (per-letter keep values, vowel balance, duplicate and Q-without-U penalties), the change in the best word it could play now, and the change in the best 7+ letter word.
In the last `endN` auctions it switches to the exact value: how much the letter adds to the best disjoint set of words it can dump at the end.

**Memory.**
`Tracker` rebuilds which letters are still unseen (bag plus opponents' hidden starting tiles) from public events only, and tracks the table's recent prices.

**Budgeting.**
The bid is `value x e^c0 x (budget/3)^c1 x (market/12)^marketW`, capped by a fraction of the balance that opens up as the game ends.
In the endgame it scales up by `spendW`, and at the last playable auction it bids everything, because coins are worthless afterwards.

Word play is a second decision on the same numbers: a word is cashed in when its reward (boosted when coins are low) beats the rack potential it destroys by more than `playThresh`.

## Look-ahead (`src/planner.ts`)

The evolved policy decides in 0.2 ms, which leaves most of each one-second auction unused.
In the last 12 auctions, Nijello sends the policy's bid at once, then spends about 450 ms playing the rest of the match out from the real position, once per candidate bid.
In each rollout the opponents' unknown starting tiles are drawn from the letters it hasn't seen, the opponents at the table are played by their calibrated profiles, and Nijello plays on with its own policy.
All candidates share the same samples, and the policy's bid is replaced (the server keeps a bot's latest bid) only when a candidate beats it by more than one paired standard error.
`continueMatch` in `src/game.ts` resumes a simulation from any mid-match state for this.

On 4 replays of each of Nijello's 67 real matches since match 1056, look-ahead raised the placing score by 0.023 +- 0.006 and the win rate from 63.4% to 69.8%.
It went live at 04:49 on October 24.

## Dictionary (`src/dict.ts`)

Each word is stored under its sorted letters (its anagram signature) in a first-child/next-sibling trie.
Finding the best word for a rack is a walk that only follows letters the rack holds, so a full simulated match takes 1-3 ms instead of the 65 ms a scan took.
That speedup is what made 17 million training games affordable.

## Simulator (`src/game.ts`)

Mirrors the server's `closeAuction`: second-price payment, `min(1, bid)` with no runner-up, no-bid tiles discarded, server sims playing their longest word right after winning.
All bots receive the same public events a live client does.

## Live client (`live/bot.ts`)

Built on generated SpacetimeDB bindings.
It re-reads its parameter file at every match start (never mid-match), replays a match's history into the tracker if it reconnects, and logs every decision with its compute time.
Measured over 3,131 live decisions: median 0.2 ms, 99th percentile 1.6 ms, worst 4.4 ms, against a 1,000 ms auction.
