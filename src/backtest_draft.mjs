// Honest backtest + weight calibration for the DRAFT engine.
//
// Question we answer: does the draft layer (meta/synergy/counters/curves/lane/dmg/lock,
// blended on top of Elo) actually predict Tier-1 outcomes better than Elo alone — and
// are the hand-tuned weights any good, or can learned weights do better?
//
// Pipeline:
//   1) Assemble a cached set of Tier-1 matches WITH drafts: {start_time, teams, radiant_win, rad[], dire[]}.
//   2) Walk chronologically, maintain Elo from scratch (pre-game, out-of-sample), and for each
//      drafted match record: eloLogit, the raw draft components (from scoreDraft), and outcome.
//   3) Report accuracy / Brier / log-loss + calibration for: coin flip, Elo-only, draft-only,
//      hand-tuned blend.
//   4) Fit a logistic regression on [eloLogit + draft components] with a chronological 80/20
//      split (recency-weighted), and compare LEARNED weights vs the hand-tuned blend on the
//      SAME recent test slice. Save learned coefficients to docs/data/draft_model.json.
//
// Leakage note: meta.json / stratz.json reflect a recent window. To keep the test roughly
// contemporaneous with that meta, evaluation is limited to the last EVAL_DAYS of matches
// (Elo is still warmed on the full history before each match).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLeagues, getProMatches, getMatch } from "./opendota.mjs";
import { scoreDraft, blend } from "../docs/live_draft.mjs";
import { eloExpected, ELO_START, ELO_K } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "docs", "data");
const CACHE_DIR = join(ROOT, "cache");
const CACHE_FILE = join(CACHE_DIR, "draft_matches.json");

const PAGES = Number(process.env.PAGES || 60);       // proMatches pages to scan for Tier-1 ids
const MATCHES = Number(process.env.MATCHES || 1200); // how many recent Tier-1 matches to detail
const DELAY = Number(process.env.DELAY || 900);      // pacing for /matches
const WARMUP = Number(process.env.WARMUP || 5);      // min prior Elo games per team before a match counts
const EVAL_DAYS = Number(process.env.EVAL_DAYS || 150); // only evaluate matches newer than this
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clampP = (p, e = 1e-6) => Math.min(1 - e, Math.max(e, p));
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));

// ---------- 1) assemble cached match set ----------
async function loadCache() {
  try { return JSON.parse(await readFile(CACHE_FILE, "utf8")); }
  catch { return { matches: {} }; }
}

async function assembleMatches() {
  const cache = await loadCache();
  console.log(`Кеш: ${Object.keys(cache.matches).length} матчей уже загружено.`);

  console.log(`1/3 Ищу Tier-1 матчи (${PAGES} страниц про-матчей)...`);
  const leagues = await getLeagues();
  const TIER1 = new Set(["premium", "professional"]);
  const premiumIds = new Set(leagues.filter((l) => TIER1.has(l.tier)).map((l) => l.leagueid));
  const pro = await getProMatches({ pages: PAGES, delayMs: 350 });
  const tier1 = pro
    .filter((m) => premiumIds.has(m.leagueid) && m.radiant_team_id && m.dire_team_id && typeof m.radiant_win === "boolean")
    .sort((a, b) => b.start_time - a.start_time)
    .slice(0, MATCHES);
  console.log(`   Tier-1 матчей: ${tier1.length}`);

  const need = tier1.filter((m) => !cache.matches[m.match_id]);
  console.log(`2/3 Нужно догрузить деталей: ${need.length} (пейсинг ${DELAY}ms)...`);
  let got = 0, err = 0;
  for (const m of need) {
    try {
      const d = await getMatch(m.match_id);
      if (d && Array.isArray(d.picks_bans) && typeof d.radiant_win === "boolean") {
        const picks = d.picks_bans.filter((p) => p.is_pick && p.hero_id);
        const rad = picks.filter((p) => p.team === 0).map((p) => p.hero_id);
        const dire = picks.filter((p) => p.team === 1).map((p) => p.hero_id);
        cache.matches[m.match_id] = {
          match_id: m.match_id,
          start_time: d.start_time || m.start_time,
          radiant_team_id: m.radiant_team_id,
          dire_team_id: m.dire_team_id,
          radiant_win: d.radiant_win,
          rad, dire,
        };
        got++;
      }
    } catch { err++; }
    if ((got + err) % 25 === 0) {
      process.stdout.write(`\r   загружено ${got}, ошибок ${err}`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");
    }
    await sleep(DELAY);
  }
  process.stdout.write("\n");
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");

  // Chronological ascending. Include ALL Tier-1 for Elo; draft samples are those with picks.
  const all = tier1
    .map((m) => cache.matches[m.match_id] || { ...m, rad: null, dire: null })
    .sort((a, b) => a.start_time - b.start_time);
  return all;
}

// ---------- metrics ----------
function metrics(samples, predict) {
  let n = 0, correct = 0, brier = 0, ll = 0;
  for (const s of samples) {
    const p = clampP(predict(s));
    const y = s.y;
    n++;
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
    brier += (p - y) ** 2;
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return { n, acc: correct / n, brier: brier / n, logloss: ll / n };
}

function calibrationTable(samples, predict, bins = 10) {
  const rows = Array.from({ length: bins }, () => ({ sum: 0, y: 0, n: 0 }));
  for (const s of samples) {
    const p = clampP(predict(s));
    const b = Math.min(bins - 1, Math.floor(p * bins));
    rows[b].sum += p; rows[b].y += s.y; rows[b].n++;
  }
  return rows.map((r, i) => ({
    bin: `${(i / bins).toFixed(1)}-${((i + 1) / bins).toFixed(1)}`,
    pred: r.n ? r.sum / r.n : 0, actual: r.n ? r.y / r.n : 0, n: r.n,
  }));
}

// ---------- logistic regression (standardized, L2, recency-weighted) ----------
function standardize(X) {
  const d = X[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= X.length;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / X.length) || 1;
  const Z = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  return { mean, std, Z };
}

function fitLR(Z, y, w, { l2 = 1.0, iters = 500, lr = 0.3 } = {}) {
  const d = Z[0].length;
  let W = Array(d).fill(0), b = 0;
  const W_sum = w.reduce((a, c) => a + c, 0) || 1;
  for (let it = 0; it < iters; it++) {
    const gW = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = sigmoid(Z[i].reduce((a, v, j) => a + v * W[j], b));
      const e = (p - y[i]) * w[i];
      for (let j = 0; j < d; j++) gW[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) W[j] -= lr * (gW[j] / W_sum + (l2 * W[j]) / Z.length);
    b -= lr * (gb / W_sum);
  }
  return { W, b };
}

const FEATURES = ["eloLogit", "eMeta", "eSyn", "eCounter", "eLane", "eTiming", "eDmg", "eLock"];

// Build a meta object (same shape as meta.json) from a list of drafted matches, so a
// backtest can use ONLY past matches (no leakage from the games we're predicting).
// Hero static fields (name/roles/nw10) come from the reference meta; empirical winrate,
// power curves, synergy and counter matrices are recomputed from `matches` alone.
function buildMetaFrom(matches, refMeta) {
  const pairKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const heroes = {};
  for (const [id, h] of Object.entries(refMeta.heroes)) {
    heroes[id] = {
      name: h.name, roles: h.roles || [], primary: h.primary, attack: h.attack,
      nw10: h.nw10 != null ? h.nw10 : null, // hero-level economy prior (not target leakage)
      winrate: null, // recomputed empirically below; null falls back to stratz/0.5
      games: 0, wins: 0,
      dur: { short: { g: 0, w: 0 }, mid: { g: 0, w: 0 }, long: { g: 0, w: 0 } },
    };
  }
  const synergy = new Map(), counter = new Map();
  const bump = (m, k, won) => { let v = m.get(k); if (!v) { v = { g: 0, w: 0 }; m.set(k, v); } v.g++; if (won) v.w++; };
  for (const m of matches) {
    const rad = m.rad || [], dire = m.dire || [];
    if (rad.length < 4 || dire.length < 4) continue;
    const radWin = m.radiant_win;
    // duration unknown from cache → credit only games/wins + synergy/counter (curves stay flat).
    const credit = (ids, won) => { for (const id of ids) { const h = heroes[id]; if (h) { h.games++; if (won) h.wins++; } } };
    credit(rad, radWin); credit(dire, !radWin);
    const addSyn = (ids, won) => { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) bump(synergy, pairKey(ids[i], ids[j]), won); };
    addSyn(rad, radWin); addSyn(dire, !radWin);
    const addCnt = (mine, th, won) => { for (const a of mine) for (const b of th) bump(counter, `${a},${b}`, won); };
    addCnt(rad, dire, radWin); addCnt(dire, rad, !radWin);
  }
  const toObj = (map) => { const o = {}; for (const [k, v] of map) if (v.g >= 3) o[k] = [v.g, v.w]; return o; };
  return { heroes, synergy: toObj(synergy), counter: toObj(counter) };
}

async function main() {
  const meta = JSON.parse(await readFile(join(DATA_DIR, "meta.json"), "utf8"));
  const stratz = await readFile(join(DATA_DIR, "stratz.json"), "utf8").then(JSON.parse).catch(() => null);
  const knowledge = await readFile(join(DATA_DIR, "hero_knowledge.json"), "utf8").then(JSON.parse).catch(() => ({ heroes: {} }));

  const all = await assembleMatches();
  console.log(`3/3 Бэктест: всего Tier-1 ${all.length}, из них с драфтом ${all.filter((m) => m.rad && m.rad.length >= 4).length}`);

  // Chronological split by fraction so the meta-training slice is never empty (a fixed
  // day-cutoff fails when the whole cache is recent). Oldest EVAL_FRAC stays out of eval.
  const EVAL_FRAC = Number(process.env.EVAL_FRAC || 0.4);
  const draftedSorted = all.filter((m) => m.rad && m.rad.length >= 4).sort((a, b) => a.start_time - b.start_time);
  const cutIdx = Math.floor((1 - EVAL_FRAC) * draftedSorted.length);
  const evalCutoff = draftedSorted.length ? draftedSorted[cutIdx].start_time : Math.floor(Date.now() / 1000);

  // Point-in-time meta: synergy/counter/hero-winrate rebuilt from ONLY the matches
  // older than the eval cutoff → the draft features can't see the outcomes we predict.
  const trainDrafted = draftedSorted.filter((m) => m.start_time < evalCutoff);
  const ptMeta = buildMetaFrom(trainDrafted, meta);
  console.log(`   Point-in-time мета построена на ${trainDrafted.length} матчах (< cutoff), eval-доля ${EVAL_FRAC}.`);

  // Walk-forward Elo; collect draft samples in the eval window.
  const elo = new Map();
  const g = (id) => { if (!elo.has(id)) elo.set(id, { r: ELO_START, n: 0 }); return elo.get(id); };
  const samples = [];

  for (const m of all) {
    const R = g(m.radiant_team_id), D = g(m.dire_team_id);
    const expR = eloExpected(R.r, D.r);
    const warm = R.n >= WARMUP && D.n >= WARMUP;
    const hasDraft = m.rad && m.dire && m.rad.length >= 4 && m.dire.length >= 4;

    if (warm && hasDraft && m.start_time >= evalCutoff) {
      const clean = scoreDraft(m.rad, m.dire, { meta: ptMeta, stratz, knowledge });
      const leaky = scoreDraft(m.rad, m.dire, { meta, stratz, knowledge });
      const r = clean.raw;
      samples.push({
        t: m.start_time,
        y: m.radiant_win ? 1 : 0,
        eloProb: expR,
        eloLogit: logit(expR),
        draftProbA: clean.probA,        // leakage-free draft prob
        draftProbLeaky: leaky.probA,    // for contrast only
        eMeta: r.eMeta, eSyn: r.eSyn, eCounter: r.eCounter, eLane: r.eLane,
        eTiming: (r.eEarly + r.eLate) / 2, // representative curve/timing signal
        eDmg: r.eDmg, eLock: r.eLock,
      });
    }

    // update Elo
    const sR = m.radiant_win ? 1 : 0;
    R.r += ELO_K * (sR - expR); D.r += ELO_K * ((1 - sR) - (1 - expR));
    R.n++; D.n++;
  }

  console.log(`\nОценочных матчей (warmed + драфт, новейшая доля): ${samples.length}\n`);
  if (samples.length < 60) {
    console.log("Мало данных для надёжных выводов. Увеличь PAGES/MATCHES или EVAL_DAYS.");
  }

  // ---- baselines on full eval set ----
  const BLEND = 0.7; // must match live_draft.mjs
  const preds = {
    "Монетка (0.5)": () => 0.5,
    "Только Elo": (s) => s.eloProb,
    "Только драфт (clean)": (s) => s.draftProbA,
    "Elo + драфт (ручн., clean)": (s) => blend(s.eloProb, s.draftProbA),
    "Elo + драфт (ручн., LEAKY)": (s) => blend(s.eloProb, s.draftProbLeaky),
  };
  console.log("=== Базлайны на всей оценочной выборке ===");
  console.log("модель".padEnd(30), "acc     Brier   logloss");
  for (const [name, fn] of Object.entries(preds)) {
    const mm = metrics(samples, fn);
    console.log(name.padEnd(30), `${(mm.acc * 100).toFixed(1)}%  ${mm.brier.toFixed(4)}  ${mm.logloss.toFixed(4)}`);
  }

  // ---- learned weights: chronological 80/20 ----
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const split = Math.floor(sorted.length * 0.8);
  const train = sorted.slice(0, split), test = sorted.slice(split);
  const X = train.map((s) => FEATURES.map((f) => s[f]));
  const y = train.map((s) => s.y);
  // recency weight: newer training rows count more (half-life ~120 days)
  const tmax = train[train.length - 1].t;
  const w = train.map((s) => Math.pow(0.5, (tmax - s.t) / (120 * 86400)));

  const { mean, std, Z } = standardize(X);
  const { W, b } = fitLR(Z, y, w, { l2: 1.0, iters: 600, lr: 0.3 });

  const predLearned = (s) => {
    const z = FEATURES.map((f, j) => (s[f] - mean[j]) / std[j]);
    return sigmoid(z.reduce((a, v, j) => a + v * W[j], b));
  };

  console.log(`\n=== Обученные веса vs ручные (тест = последние ${test.length} матчей) ===`);
  console.log("модель".padEnd(30), "acc     Brier   logloss");
  for (const [name, fn] of [
    ["Только Elo", (s) => s.eloProb],
    ["Elo + драфт (ручные)", (s) => blend(s.eloProb, s.draftProbA)],
    ["Обученные веса (логрег)", predLearned],
  ]) {
    const mm = metrics(test, fn);
    console.log(name.padEnd(30), `${(mm.acc * 100).toFixed(1)}%  ${mm.brier.toFixed(4)}  ${mm.logloss.toFixed(4)}`);
  }

  console.log("\nВклад признаков (стандартизованные веса логрега):");
  FEATURES.forEach((f, j) => console.log(`  ${f.padEnd(10)} ${W[j] >= 0 ? " " : ""}${W[j].toFixed(3)}`));

  console.log("\nКалибровка обученной модели (тест):");
  for (const r of calibrationTable(test, predLearned)) {
    if (r.n) console.log(`  ${r.bin}  pred ${(r.pred * 100).toFixed(0)}%  факт ${(r.actual * 100).toFixed(0)}%  (n=${r.n})`);
  }

  const model = {
    generatedAt: new Date().toISOString(),
    features: FEATURES,
    mean, std, weights: W, intercept: b,
    trainN: train.length, testN: test.length,
    note: "Draft outcome model: logistic on eloLogit + draft components. Radiant perspective.",
  };
  await writeFile(join(DATA_DIR, "draft_model.json"), JSON.stringify(model), "utf8");
  console.log("\nСохранено: docs/data/draft_model.json");
}

main().catch((e) => { console.error("Ошибка бэктеста драфта:", e); process.exit(1); });
