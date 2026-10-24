# Profiling the live field

`src/profile.ts` turns the server's public match history into a bid function for every competitive bot, then calibrates those functions until a replay of our own real matches looks like what actually happened.

## What the server reveals

For every auction: the letter, the winner, the winner's exact bid and the price paid (the second-highest bid).
For every word: who played it, when, and for how much.
Losing bids are private.

From that, for every bot at every auction, we rebuild what it knew:

- **Coins:** 100 plus word rewards minus prices paid, up to that moment.
- **Rack:** tiles it bought, plus starting tiles its words later revealed, minus letters it played.
- **Letter value:** how much the letter on sale adds to its best word, and to its best 7+ letter word, using our dictionary.
- **Table prices:** the shrunk mean of the match's recent prices.

## Censored regression

The winner's bid is an exact observation.
Every loser's bid is only known to be at most the price paid.
`src/tobit.ts` fits `log1p(bid) = w . features + sigma * noise` by maximum likelihood with both kinds of observation (a Tobit model).
Its test generates synthetic data with two thirds of observations censored and checks the fit recovers the true weights.

On 1,242 second-price matches it profiled 49 bots in 30 seconds.
Every one of them bids more when a letter improves its best word, and more when it is rich.
postturing, the bot that later took first place, has by far the most consistent bidding (noise 0.34 against about 0.8 for the field).

## Calibration against reality

One Gaussian in log space can't hold both a bot's zero bids on letters it doesn't want and its high bids on letters it does, so the raw fit underbids the top of the table.
`--calibrate` fits two numbers per game phase, a level shift and a spread, until replays of our real matches reproduce the live prices paid and the live winning bids.
Then we check the things we did not fit:

| Replaying Nijello's 42 real matches | Live | Raw profiles | Calibrated profiles |
|---|---|---|---|
| Nijello wins the match | 31% | 99% | 67% |
| Tiles per match | 13.0 | 25.9 | 15.7 |
| Price paid, median (early / mid / late) | 12 / 11 / 13 | 10 / 9 / 10 | 12 / 11 / 12 |
| Winning bid, median (early / mid / late) | 15 / 14 / 18 | 15 / 14 / 18 | 16 / 15 / 17 |
| Nijello's win rate when it bids 10-14 / 15-24 / 25+ | 24 / 33 / 62% | 45 / 58 / 68% | 26 / 43 / 60% |

The auction now matches live closely.
The remaining gap is word play: profiled opponents use our own word-play logic and score about 8 points less than the real bots.

## Learning from Chinese Dante

Over their last ~75 matches each, the two were dead even: Nijello 34% wins and average place 2.57, Chinese Dante 32% and 2.55.
They get there differently.

| | Chinese Dante | Nijello |
|---|---|---|
| Tiles bought early / mid / late | 4.6 / 4.2 / 3.5 | 3.1 / 3.4 / 6.2 |
| First mid-game word | after auction 21 | after auction 46 |
| Exactly 7-letter words | 133 of 230 | 74 of 214 |
| Points per tile | 7.52 | 7.08 |
| Coins wasted at the end | 21 | 28 |
| Pays a premium for | V 19, F 20, H 22, P 18 | cheap vowels, T, U |

We transplanted each Dante habit into Nijello's parameters and replayed the 42 real matches, paired:

| Dante habit | Place vs Nijello |
|---|---|
| Play words earlier | -0.032 +- 0.012 |
| Buy early | -0.141 +- 0.017 |
| Value V, F, H, P higher | +0.000 +- 0.012 |
| Bonus for 7+ words | -0.014 +- 0.013 |
| All of them | -0.307 +- 0.019 |

Dante's style works as a whole system; Nijello's weights are tuned around a different one (hoard, buy late when the table is broke, dump big words at the end).
Instead of copying habits, Dante's real bidding is now one of the two focus opponents Nijello trains against.
