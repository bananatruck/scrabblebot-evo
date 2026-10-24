// How does the training run's current best do against models of the named
// top bots? Plays the same tables twice: once with the trained bot, once
// with the untrained gen-0 bot, and prints win rate, place and head-to-head.
//
//   nice -n 19 node bench-top.ts [games]

import { readFileSync } from "node:fs";
import { Dictionary } from "../scrabblebot-evo/src/dict.ts";
import { type Bot, playMatch } from "../scrabblebot-evo/src/game.ts";
import { Rng } from "../scrabblebot-evo/src/rng.ts";
import { decode, EvoBot, jsonToX } from "../scrabblebot-evo/src/strategy.ts";
import { calibrate, loadTop, pooledBids, simulate, TopBot } from "./topbots.ts";

const EVO = new URL("../scrabblebot-evo/", import.meta.url).pathname;
const GAMES = Number(process.argv[2] ?? 600);
const dict = Dictionary.load(`${EVO}data/wordlist.txt`);
const data = loadTop(new URL("./data/topbots.json", import.meta.url).pathname);
if (!data) throw new Error("data/topbots.json missing: run fetch-top.ts first");
const scales = calibrate(data, dict, new URL("./data/topbots-cal.json", import.meta.url).pathname);
const pooled = pooledBids(data);
const best = JSON.parse(readFileSync(`${EVO}runs/main/best.json`, "utf8"));

function run(label: string, make: () => Bot) {
  const rng = new Rng(777);
  let wins = 0;
  let place = 0;
  let score = 0;
  const h2h = new Map<string, { beat: number; met: number }>();
  for (let g = 0; g < GAMES; g++) {
    const seed = rng.u32();
    const names = data!.bots.map((b) => b.name);
    rng.shuffle(names);
    const opps = names.slice(0, 5).map((n, k) => {
      const p = data!.bots.find((b) => b.name === n)!;
      return new TopBot(p, pooled, scales.get(n) ?? 0.8, seed + 31 * k);
    });
    const seat = rng.int(0, 5);
    const bots: Bot[] = [...opps];
    bots.splice(seat, 0, make());
    const res = playMatch(bots, dict, seed, "Vickrey");
    const me = res.scores[seat]!;
    const pl = 1 + res.scores.filter((s) => s > me).length;
    if (pl === 1) wins++;
    place += pl;
    score += me;
    opps.forEach((o) => {
      const s = res.scores[bots.indexOf(o)]!;
      const h = h2h.get(o.profile.name) ?? { beat: 0, met: 0 };
      h.met++;
      if (me > s) h.beat++;
      h2h.set(o.profile.name, h);
    });
  }
  console.log(
    `${label.padEnd(26)} win ${((100 * wins) / GAMES).toFixed(1).padStart(5)}%   avg place ${(place / GAMES).toFixed(2)}   avg score ${(score / GAMES).toFixed(1)}`,
  );
  return h2h;
}

// Fidelity: do the models, playing each other, look like the real bots?
console.log("model check (all-model tables) vs the real bot on the live server");
console.log("  bot               score model/real   letters model/real   words model/real   win model/real");
for (const f of simulate(data, dict, scales, 400, 99)) {
  const b = data.bots.find((x) => x.name === f.name)!;
  console.log(
    `  ${f.name.slice(0, 16).padEnd(16)} ${f.score.toFixed(0).padStart(6)} / ${b.avgScore.toFixed(0).padEnd(8)} ${f.tiles.toFixed(1).padStart(8)} / ${b.tilesPerMatch.toFixed(1).padEnd(9)}` +
      ` ${f.words.toFixed(1).padStart(7)} / ${b.wordsPerMatch.toFixed(1).padEnd(8)} ${(100 * f.win).toFixed(0).padStart(6)}% / ${(100 * b.winRate).toFixed(0)}%`,
  );
}
console.log("");
console.log(`${GAMES} Vickrey games per bot vs 5 of ${data.bots.length} top-bot models (data from ${data.matches} real matches, fetched ${data.fetchedAt})`);
console.log(`fair share of wins at a 6-seat table: 16.7%\n`);
const trained = run(`trained bot (gen ${best.gen})`, () => new EvoBot(decode(jsonToX(best.params)), "evo"));
const untrained = run("untrained gen-0 bot", () => new EvoBot(decode(new Float64Array(0)), "gen0"));
console.log("\nhead-to-head: share of matches our bot finished above each model (trained / untrained)");
for (const b of data.bots) {
  const t = trained.get(b.name)!;
  const u = untrained.get(b.name)!;
  console.log(
    `  ${b.name.slice(0, 16).padEnd(16)} ${((100 * t.beat) / t.met).toFixed(0).padStart(3)}%  /  ${((100 * u.beat) / u.met).toFixed(0).padStart(3)}%   ` +
      `(real bot: ${(100 * b.winRate).toFixed(0)}% wins, ${b.tilesPerMatch.toFixed(1)} letters/match, scale ${(scales.get(b.name) ?? 0).toFixed(2)})`,
  );
}
