// Look-ahead bidding. The evolved policy picks a bid in a fraction of a
// millisecond; the planner then plays the rest of the match out many times
// from the real position, once per candidate bid, and keeps the bid with
// the best average finishing place.
//
// In each rollout the opponents' unknown starting tiles are drawn from the
// letters we haven't seen, the opponents at the table are played by their
// models (calibrated profiles, src/profile.ts), and we play on with the
// evolved policy. All candidates share the same samples (common random
// numbers), and the policy's bid is only replaced when a candidate beats it
// by more than one paired standard error.

import type { Dictionary, Rack } from "./dict.ts";
import { type Action, type Bot, continueMatch, type MidMatch, type View } from "./game.ts";
import { Rng } from "./rng.ts";
import { BAG_COUNTS } from "./rules.ts";
import { EvoBot, type Params, type Tracker } from "./strategy.ts";

export interface PlanConfig {
  // Plan only when this many tiles or fewer are left in the bag.
  lastN: number;
  // Rollouts per candidate when no deadline is given (the simulator).
  samples: number;
}

// Model of the bot in a given seat, for rollouts.
export type SeatModel = (seat: number, seed: number) => Bot;

export interface PlanResult {
  bid: number;
  policyBid: number;
  candidates: number;
  samples: number;
  gain: number; // mean placing gain of the chosen bid over the policy's
  se: number;
  ms: number;
}

// Tournament Swiss points for one match, as a fraction of first place.
function placeFraction(scores: number[], seat: number): number {
  const n = scores.length;
  const place = scores.filter((s) => s > scores[seat]!).length;
  return (n - 1 - place) / (n - 1);
}

// Bids worth trying: the policy's, a token bid, and multiples of the larger
// of the policy's bid and the table's recent price, up to the whole balance.
// The token bid is 1, not 0, once the policy has bid: the server ignores
// bids of 0, so a live bot can lower its bid but never withdraw it.
export function candidateBids(policy: number, balance: number, market: number): number[] {
  const p = Math.max(policy, Math.round(market));
  const out = [policy];
  for (const b of [policy > 0 ? 1 : 0, Math.round(p * 0.5), Math.round(p * 1.5), Math.round(p * 2.2), balance]) {
    const c = Math.max(0, Math.min(balance, b));
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// Our seat in a rollout: bids `bid` in the open auction (its words were
// already applied to the state), then plays on with the evolved policy,
// knowing what the real bot knew.
class FirstBid implements Bot {
  readonly name = "us";
  private inner: EvoBot;
  private first = true;
  private bid: number;
  private known: Tracker;

  constructor(p: Params, bid: number, known: Tracker) {
    this.inner = new EvoBot(p, "us");
    this.bid = bid;
    this.known = known;
  }

  onStart(seat: number, n: number, rack: Rack, dict: Dictionary): string[] {
    this.inner.onStart(seat, n, rack, dict);
    this.inner.tracker.primeFrom(this.known);
    return [];
  }

  onAuction(v: View): Action {
    if (this.first) {
      this.first = false;
      return { words: [], bid: this.bid };
    }
    return this.inner.onAuction(v);
  }

  onResult(v: View, letter: number, winner: number, paid: number): string[] {
    return this.inner.onResult(v, letter, winner, paid);
  }

  onWord(seat: number, word: string): void {
    this.inner.onWord(seat, word);
  }
}

// An opponent model dropped into the middle of a match: if it tracks the
// game, it starts from what we know (prices so far, unseen letters).
function primed(b: Bot, known: Tracker): Bot {
  if (!(b instanceof EvoBot)) return b;
  return {
    name: b.name,
    onStart: (seat, n, rack, dict) => {
      b.onStart(seat, n, rack, dict);
      b.tracker.primeFrom(known);
      return [];
    },
    onAuction: (v) => b.onAuction(v),
    onResult: (v, letter, winner, paid) => b.onResult(v, letter, winner, paid),
    onWord: (seat, word) => b.onWord(seat, word),
  };
}

function drawFrom(pool: Int32Array, total: number, rng: Rng): number {
  let idx = rng.int(0, total - 1);
  for (let c = 0; c < 26; c++) {
    if (idx < pool[c]!) {
      pool[c]!--;
      return c;
    }
    idx -= pool[c]!;
  }
  return -1;
}

export class PlannerBot extends EvoBot {
  private cfg: PlanConfig;
  private seatModel: SeatModel;
  private rng: Rng;
  lastPlan: PlanResult | null = null;

  constructor(p: Params, cfg: PlanConfig, seatModel: SeatModel, seed = 1, name = "planner") {
    super(p, name);
    this.cfg = cfg;
    this.seatModel = seatModel;
    this.rng = new Rng(seed);
  }

  override onAuction(v: View): Action {
    const act = super.onAuction(v);
    if (!this.shouldPlan(v)) return act;
    return { words: act.words, bid: this.plan(v, act, { samples: this.cfg.samples }).bid };
  }

  shouldPlan(v: View): boolean {
    return v.auctionType === "Vickrey" && v.bagLeft > 0 && v.bagLeft <= this.cfg.lastN && v.balance > 0;
  }

  // Public so the live client can send the policy's bid first and plan
  // after, until `deadline` (performance.now() milliseconds).
  plan(v: View, act: Action, budget: { samples?: number; deadline?: number }): PlanResult {
    const t0 = performance.now();
    const d = this.dictionary;
    const me = v.seat;
    const myRack = Int32Array.from(v.rack);
    let myBal = v.balance;
    let myScore = v.score;
    for (const w of act.words) {
      const i = d.indexOf(w);
      d.spend(myRack, i);
      myBal += d.reward[i]!;
      myScore += d.reward[i]!;
    }
    const cands = candidateBids(act.bid, myBal, this.tracker.marketPrice());
    const diffs: number[][] = cands.map(() => []);
    const maxSamples = budget.samples ?? Infinity;
    let k = 0;
    while (k < maxSamples && (budget.deadline === undefined || performance.now() < budget.deadline)) {
      const seed = this.rng.u32();
      const state = this.sample(v, myRack, myBal, myScore);
      const vals = cands.map((b) => this.rollout(state, b, seed, me, v.nPlayers));
      for (let c = 1; c < cands.length; c++) diffs[c]!.push(vals[c]! - vals[0]!);
      k++;
    }
    let best = 0;
    let gain = 0;
    let se = 0;
    if (k >= 4) {
      for (let c = 1; c < cands.length; c++) {
        const xs = diffs[c]!;
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
        const s = sd / Math.sqrt(xs.length);
        if (mean > gain && mean > s) {
          best = c;
          gain = mean;
          se = s;
        }
      }
    }
    this.lastPlan = {
      bid: cands[best]!,
      policyBid: act.bid,
      candidates: cands.length,
      samples: k,
      gain,
      se,
      ms: performance.now() - t0,
    };
    return this.lastPlan;
  }

  // One guess at the hidden information: each opponent's unknown starting
  // tiles drawn from the letters we haven't seen; the rest is the bag.
  private sample(v: View, myRack: Rack, myBal: number, myScore: number): MidMatch {
    const pool = Int32Array.from(this.tracker.unseen);
    let total = pool.reduce((a, b) => a + b, 0);
    const racks: Rack[] = [];
    for (let s = 0; s < v.nPlayers; s++) {
      if (s === v.seat) {
        racks.push(Int32Array.from(myRack));
        continue;
      }
      const { known, hidden } = this.tracker.heldBy(s);
      const r = Int32Array.from(known);
      const h = Math.min(hidden, Math.max(0, total - v.bagLeft));
      for (let j = 0; j < h; j++) {
        const c = drawFrom(pool, total, this.rng);
        if (c < 0) break;
        r[c]!++;
        total--;
      }
      racks.push(r);
    }
    // The bag must hold exactly bagLeft tiles; trim or pad if our tracking
    // and the server disagree.
    while (total > v.bagLeft) {
      drawFrom(pool, total, this.rng);
      total--;
    }
    if (total < v.bagLeft) {
      const fill = Int32Array.from(BAG_COUNTS);
      let fillTotal = fill.reduce((a, b) => a + b, 0);
      while (total < v.bagLeft) {
        const c = drawFrom(fill, fillTotal--, this.rng);
        pool[c]!++;
        total++;
      }
    }
    const balances = [...v.balances];
    const scores = [...v.scores];
    balances[v.seat] = myBal;
    scores[v.seat] = myScore;
    return { racks, balances, scores, bag: pool, letter: v.letter, round: v.round };
  }

  private rollout(state: MidMatch, bid: number, seed: number, me: number, n: number): number {
    const bots: Bot[] = [];
    for (let s = 0; s < n; s++)
      bots.push(s === me ? new FirstBid(this.p, bid, this.tracker) : primed(this.seatModel(s, seed + 7919 * (s + 1)), this.tracker));
    const res = continueMatch(bots, this.dictionary, seed, state);
    return placeFraction(res.scores, me) + 0.0005 * res.scores[me]!;
  }
}
