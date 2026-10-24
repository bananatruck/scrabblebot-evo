// Pull the live game's public tables once and build per-bot profiles of the
// strongest real bots: their own winning bids by letter and game phase, the
// lengths of the words they play, and how many letters they win per match.
// Writes data/topbots.json next to this file (never into scrabblebot-evo).
//
//   node fetch-top.ts            top 8 bots with 20+ finished matches
//   node fetch-top.ts --top 12 --min 15

import { mkdirSync, writeFileSync } from "node:fs";

const HOST = "https://maincloud.spacetimedb.com";
const DB = "scrabblebot";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}
const TOP = Number(arg("top", "8"));
const MIN_MATCHES = Number(arg("min", "20"));

type Row = Record<string, unknown>;

async function anonToken(): Promise<string> {
  const r = await fetch(`${HOST}/v1/identity`, { method: "POST" });
  return ((await r.json()) as { token: string }).token;
}

async function sql(token: string, query: string): Promise<Row[]> {
  const r = await fetch(`${HOST}/v1/database/${DB}/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: query,
  });
  if (!r.ok) throw new Error(`${query}: HTTP ${r.status} ${await r.text()}`);
  const [res] = (await r.json()) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
  const cols = res!.schema.elements.map((e) => e.name.some);
  return res!.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// SATS sum values arrive as [variantIndex, payload].
const tag = (v: unknown): number => (v as [number, unknown])[0];
const some = (v: unknown): number | undefined => {
  const [t, x] = v as [number, unknown];
  return t === 0 ? Number(x) : undefined;
};

export interface TopProfile {
  id: number;
  name: string;
  matches: number;
  winRate: number;
  avgScore: number;
  avgPlace: number;
  tilesPerMatch: number; // auctions won per match
  wordsPerMatch: number;
  wordLens: number[]; // count of played words by length, index = length (0..15)
  bids: number[][][]; // [letter][phase] this bot's winning bids, sorted
}

async function main(): Promise<void> {
  const token = await anonToken();
  const [bots, matches, parts, results, tops, words] = await Promise.all([
    sql(token, "SELECT * FROM bot"),
    sql(token, "SELECT * FROM match_state"),
    sql(token, "SELECT * FROM match_participant"),
    sql(token, "SELECT * FROM auction_result"),
    sql(token, "SELECT * FROM auction_top_bid_archive"),
    sql(token, "SELECT * FROM word_play"),
  ]);
  const isSim = new Map(bots.map((b) => [Number(b.id), Boolean(b.is_simulated)]));
  const name = new Map(bots.map((b) => [Number(b.id), String(b.name)]));
  const ended = new Set(matches.filter((m) => tag(m.status) === 2).map((m) => Number(m.id)));

  const byMatch = new Map<number, Row[]>();
  for (const p of parts) {
    const id = Number(p.match_id);
    if (ended.has(id)) (byMatch.get(id) ?? byMatch.set(id, []).get(id)!).push(p);
  }
  const agg = new Map<number, { n: number; score: number; place: number; win: number }>();
  for (const ps of byMatch.values()) {
    for (const p of ps) {
      const id = Number(p.bot_id);
      if (isSim.get(id) !== false) continue;
      const place = ps.filter((q) => Number(q.score) > Number(p.score)).length;
      const a = agg.get(id) ?? { n: 0, score: 0, place: 0, win: 0 };
      a.n++;
      a.score += Number(p.score);
      a.place += place + 1;
      a.win += place === 0 ? 1 : 0;
      agg.set(id, a);
    }
  }
  const chosen = [...agg.entries()]
    .filter(([, a]) => a.n >= MIN_MATCHES)
    .sort((x, y) => y[1].score / y[1].n - x[1].score / x[1].n)
    .slice(0, TOP);

  const profiles = new Map<number, TopProfile>();
  for (const [id, a] of chosen)
    profiles.set(id, {
      id,
      name: name.get(id) ?? `#${id}`,
      matches: a.n,
      winRate: a.win / a.n,
      avgScore: a.score / a.n,
      avgPlace: a.place / a.n,
      tilesPerMatch: 0,
      wordsPerMatch: 0,
      wordLens: new Array<number>(16).fill(0),
      bids: Array.from({ length: 26 }, () => [[], [], []]),
    });

  // Auction order within each match gives the phase (first, middle, last third).
  const topBid = new Map(tops.map((t) => [Number(t.auction_id), Number(t.top_bid)]));
  const perMatch = new Map<number, Row[]>();
  for (const r of results) {
    const id = Number(r.match_id);
    if (ended.has(id)) (perMatch.get(id) ?? perMatch.set(id, []).get(id)!).push(r);
  }
  for (const rs of perMatch.values()) {
    rs.sort((x, y) => Number(x.auction_id) - Number(y.auction_id));
    rs.forEach((r, k) => {
      const w = some(r.winner_bot_id);
      const p = w === undefined ? undefined : profiles.get(w);
      if (!p) return;
      p.tilesPerMatch++;
      const tb = topBid.get(Number(r.auction_id));
      if (tb === undefined) return;
      const phase = Math.min(2, Math.floor((3 * k) / rs.length));
      p.bids[String(r.letter).charCodeAt(0) - 65]![phase]!.push(tb);
    });
  }
  for (const w of words) {
    if (!ended.has(Number(w.match_id))) continue;
    const p = profiles.get(Number(w.bot_id));
    if (!p) continue;
    p.wordsPerMatch++;
    p.wordLens[Math.min(15, String(w.word).length)]!++;
  }
  for (const p of profiles.values()) {
    p.tilesPerMatch /= p.matches;
    p.wordsPerMatch /= p.matches;
    for (const l of p.bids) for (const ph of l) ph.sort((x, y) => x - y);
  }

  const out = { fetchedAt: new Date().toISOString(), matches: ended.size, bots: [...profiles.values()] };
  mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./data/topbots.json", import.meta.url), JSON.stringify(out));
  console.log(`${ended.size} finished matches; top ${out.bots.length} real bots with ${MIN_MATCHES}+ matches:`);
  console.log("bot                matches  win%  avgScore  place  tiles/match  words/match  common word lengths");
  for (const p of out.bots) {
    const lens = p.wordLens.map((c, l) => [l, c] as [number, number]).filter(([, c]) => c > 0).sort((x, y) => y[1] - x[1]).slice(0, 3);
    console.log(
      `${p.name.slice(0, 18).padEnd(18)} ${String(p.matches).padStart(7)}  ${(100 * p.winRate).toFixed(0).padStart(4)}  ` +
        `${p.avgScore.toFixed(1).padStart(8)}  ${p.avgPlace.toFixed(2)}  ${p.tilesPerMatch.toFixed(1).padStart(11)}  ` +
        `${p.wordsPerMatch.toFixed(1).padStart(11)}  ${lens.map(([l, c]) => `${l}:${c}`).join(" ")}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
