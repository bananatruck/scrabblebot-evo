// Stand-ins for named top bots on the live server, built from their public
// history (data/topbots.json, written by fetch-top.ts). Each model bids by
// sampling that bot's own winning bids for the letter and game phase, scaled
// so it wins about as many letters per match as the real bot, and plays
// words the way the real bot does: 7+ letter words first, short words at
// its observed rate. Only winning bids are public, so these are models of
// the bots, not the bots themselves.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Dictionary, Rack } from "../scrabblebot-evo/src/dict.ts";
import { type Action, type Bot, playMatch, type View } from "../scrabblebot-evo/src/game.ts";
import { Rng } from "../scrabblebot-evo/src/rng.ts";
import { FACE } from "../scrabblebot-evo/src/rules.ts";
import { decode, EvoBot } from "../scrabblebot-evo/src/strategy.ts";

export interface TopProfile {
  id: number;
  name: string;
  matches: number;
  winRate: number;
  avgScore: number;
  avgPlace: number;
  tilesPerMatch: number;
  wordsPerMatch: number;
  wordLens: number[];
  bids: number[][][];
}

export interface TopData {
  fetchedAt: string;
  matches: number;
  bots: TopProfile[];
}

export function loadTop(path: string): TopData | null {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as TopData;
    return d.bots?.length ? d : null;
  } catch {
    return null;
  }
}

// Word habits derived from a profile's word-length counts.
interface Habits {
  shortLen: number; // most common length under 5
  shortPerAuction: number; // chance per auction of cashing in a short word
}

function habits(p: TopProfile, nAuctions: number): Habits {
  const total = p.wordLens.reduce((a, b) => a + b, 0) || 1;
  let shortLen = 2;
  let shortCount = 0;
  let best = -1;
  for (let l = 2; l < 5; l++) {
    shortCount += p.wordLens[l] ?? 0;
    if ((p.wordLens[l] ?? 0) > best) {
      best = p.wordLens[l] ?? 0;
      shortLen = l;
    }
  }
  const shortPerMatch = (p.wordsPerMatch * shortCount) / total;
  return { shortLen, shortPerAuction: Math.min(0.5, shortPerMatch / nAuctions) };
}

export class TopBot extends EvoBot {
  readonly profile: TopProfile;
  private pool: number[][][];
  private scale: number;
  private rng: Rng;
  private habits: Habits;
  private nAuctions = 68;
  private cashFloor: number;
  tilesWon = 0;

  constructor(profile: TopProfile, fallback: number[][][], scale: number, seed: number) {
    super(decode([]), profile.name);
    this.profile = profile;
    this.scale = scale;
    this.rng = new Rng(seed);
    this.cashFloor = 10 + 15 * this.rng.float();
    this.habits = habits(profile, this.nAuctions);
    // A letter/phase with too few of this bot's own wins borrows the pooled
    // top-bot bids for it.
    this.pool = profile.bids.map((phases, c) => phases.map((own, ph) => (own.length >= 3 ? own : fallback[c]![ph]!)));
  }

  override onStart(seat: number, n: number, rack: Rack, dict: Dictionary): string[] {
    this.nAuctions = 98 - 5 * n;
    this.habits = habits(this.profile, this.nAuctions);
    return super.onStart(seat, n, rack, dict);
  }

  override chooseWords(r: Rack, balance: number, _bagLeft: number): string[] {
    const d = this.dictionary;
    const out: string[] = [];
    for (;;) {
      let i = d.best(r, 7);
      if (i < 0 && balance < this.cashFloor) i = d.best(r, 5);
      if (i < 0 && this.rng.float() < this.habits.shortPerAuction) i = d.best(r, this.habits.shortLen);
      if (i < 0) break;
      d.spend(r, i);
      balance += d.reward[i]!;
      out.push(d.words[i]!);
    }
    return out;
  }

  override onAuction(v: View): Action {
    const act = super.onAuction(v);
    if (v.bagLeft === 0) return act;
    const phase = Math.min(2, Math.floor((3 * (v.round - 1)) / this.nAuctions));
    const pool = this.pool[v.letter]![phase]!;
    const sample = pool.length ? pool[this.rng.int(0, pool.length - 1)]! : FACE[v.letter]! * 6;
    let balance = v.balance;
    for (const w of act.words) balance += this.wordReward(w);
    return { words: act.words, bid: Math.max(0, Math.min(balance, Math.round(sample * this.scale))) };
  }

  override onResult(v: View, letter: number, winner: number, paid: number): string[] {
    if (winner === v.seat) this.tilesWon++;
    return super.onResult(v, letter, winner, paid);
  }
}

// Every top bot's winning bids merged, per letter and phase.
export function pooledBids(data: TopData): number[][][] {
  const out: number[][][] = Array.from({ length: 26 }, () => [[], [], []]);
  for (const b of data.bots) b.bids.forEach((phases, c) => phases.forEach((xs, ph) => out[c]![ph]!.push(...xs)));
  for (const l of out) for (const p of l) p.sort((a, b) => a - b);
  return out;
}

export interface Fidelity {
  name: string;
  tiles: number;
  words: number;
  score: number;
  win: number;
}

// Plays all-model tables and reports each model's letters, words, score and
// win rate per match. `scales` maps name -> bid scale.
export function simulate(data: TopData, dict: Dictionary, scales: Map<string, number>, games: number, seed: number): Fidelity[] {
  const pooled = pooledBids(data);
  const rng = new Rng(seed);
  const acc = new Map(data.bots.map((b) => [b.name, { tiles: 0, words: 0, score: 0, win: 0, n: 0 }]));
  for (let g = 0; g < games; g++) {
    const s = rng.u32();
    const names = data.bots.map((b) => b.name);
    rng.shuffle(names);
    const bots = names.slice(0, 6).map((n, k) => new TopBot(data.bots.find((b) => b.name === n)!, pooled, scales.get(n)!, s + 7 * k));
    const res = playMatch(bots as Bot[], dict, s, "Vickrey");
    const top = Math.max(...res.scores);
    bots.forEach((b, i) => {
      const a = acc.get(b.profile.name)!;
      a.tiles += b.tilesWon;
      a.words += res.wordsPlayed[i]!;
      a.score += res.scores[i]!;
      a.win += res.scores[i] === top ? 1 : 0;
      a.n++;
    });
  }
  return data.bots.map((b) => {
    const a = acc.get(b.name)!;
    const n = Math.max(1, a.n);
    return { name: b.name, tiles: a.tiles / n, words: a.words / n, score: a.score / n, win: a.win / n };
  });
}

// Per-bot bid scale so each model's share of the letters matches the real
// bot's share relative to the other top bots. Absolute counts can't match:
// real top bots win ~14 letters a match because they sit with weaker bots,
// and six of them at one table would need more letters than the bag holds.
// The average scale is pinned at 0.8, the middle of the field model's
// range. Cached next to the data, keyed by its fetch time.
export function calibrate(data: TopData, dict: Dictionary, cachePath: string, log = console.log): Map<string, number> {
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8"));
      if (c.fetchedAt === data.fetchedAt) return new Map(Object.entries(c.scales as Record<string, number>));
    } catch {
      // recalibrate
    }
  }
  const scales = new Map(data.bots.map((b) => [b.name, 0.8]));
  const realMean = data.bots.reduce((a, b) => a + b.tilesPerMatch, 0) / data.bots.length;
  for (let iter = 0; iter < 10; iter++) {
    const fid = simulate(data, dict, scales, 300, 4242 + iter);
    const simMean = fid.reduce((a, f) => a + f.tiles, 0) / fid.length;
    let err = 0;
    for (const b of data.bots) {
      const f = fid.find((x) => x.name === b.name)!;
      const want = b.tilesPerMatch / realMean;
      const got = f.tiles / Math.max(0.1, simMean);
      err += Math.abs(got - want);
      scales.set(b.name, scales.get(b.name)! * Math.pow(want / Math.max(0.05, got), 0.5));
    }
    let logSum = 0;
    for (const s of scales.values()) logSum += Math.log(s);
    const norm = 0.8 / Math.exp(logSum / scales.size);
    for (const [k, s] of scales) scales.set(k, Math.min(2, Math.max(0.2, s * norm)));
    log(`calibration round ${iter + 1}: mean letter-share error ${((100 * err) / data.bots.length).toFixed(1)}%`);
  }
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: data.fetchedAt, scales: Object.fromEntries(scales) }));
  return scales;
}
