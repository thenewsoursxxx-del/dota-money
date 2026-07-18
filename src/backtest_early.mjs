// Backtest + calibration of the EARLY-GAME layer (applyEarlyGame).
//
// Legit predictive setup (NOT leakage): stand at minute 10, observe the game state
// (gold/xp lead, towers, first blood), and predict the FINAL winner. This is exactly
// what the live app does. We measure how much the 10-min economy lifts accuracy over the
// pre-game Elo prior, whether the hand-tuned coefficients are any good, and what a learned
// logistic model would use instead.
//
// Reuses the match list already cached by backtest_draft (cache/draft_matches.json for
// teams/outcome/time → Elo), and fetches per-match early state into cache/early.json.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMatch } from "./opendota.mjs";
import { applyEarlyGame } from "../docs/live_draft.mjs";
import { eloExpected, ELO_START, ELO_K } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "docs", "data");
const CACHE_DIR = join(ROOT, "cache");
const MATCH_CACHE = join(CACHE_DIR, "draft_matches.json");
const EARLY_CACHE = join(CACHE_DIR, "early.json");

const DELAY = Number(process.env.DELAY || 900);
const WARMUP = Number(process.env.WARMUP || 5);
const LIMIT = Number(process.env.LIMIT || 0); // 0 = fetch all missing; else cap fetches this run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clampP = (p, e = 1e-6) => Math.min(1 - e, Math.max(e, p));
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));

// Extract 10-min state from a parsed OpenDota match. Returns null if not parsed.
function extractEarly(m) {
  if (!m || !Array.isArray(m.radiant_gold_adv) || m.radiant_gold_adv.length <= 10) return null;
  const gold10 = m.radiant_gold_adv[10];
  const xp10 = Array.isArray(m.radiant_xp_adv) && m.radiant_xp_adv.length > 10 ? m.radiant_xp_adv[10] : 0;
  let radTowers = 0, direTowers = 0, fb = 0;
  for (const o of m.objectives || []) {
    if (o.type === "building_kill" && (o.time || 0) < 600 && typeof o.key === "string" && o.key.includes("tower")) {
      if (o.key.includes("badguys")) radTowers++;      // dire building destroyed → radiant took it
      else if (o.key.includes("goodguys")) direTowers++;
    }
    if (o.type === "CHAT_MESSAGE_FIRSTBLOOD" && (o.time || 0) < 600) {
      const slot = o.player_slot != null ? o.player_slot : o.slot;
      if (slot != null) fb = slot < 5 || (slot >= 0 && slot < 128) ? 1 : -1;
    }
  }
  return { gold10, xp10, radTowers, direTowers, fb, duration: m.duration || 0 };
}

async function loadJSON(p, dflt) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return dflt; } }

async function main() {
  const matchCache = await loadJSON(MATCH_CACHE, { matches: {} });
  const list = Object.values(matchCache.matches).sort((a, b) => a.start_time - b.start_time);
  console.log(`Матчей в кеше (для Elo): ${list.length}`);

  const early = await loadJSON(EARLY_CACHE, { m: {} });
  const missing = list.filter((m) => !(m.match_id in early.m));
  const toFetch = LIMIT ? missing.slice(0, LIMIT) : missing;
  console.log(`Early-состояние: есть ${Object.keys(early.m).length}, догружаю ${toFetch.length} (пейсинг ${DELAY}ms)...`);

  let got = 0, err = 0, unparsed = 0;
  for (const m of toFetch) {
    try {
      const d = await getMatch(m.match_id);
      const e = extractEarly(d);
      early.m[m.match_id] = e; // may be null (unparsed) → cached so we don't refetch
      if (e) got++; else unparsed++;
    } catch { err++; }
    if ((got + unparsed + err) % 25 === 0) {
      process.stdout.write(`\r  ок ${got}, без парса ${unparsed}, ошибок ${err}`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(EARLY_CACHE, JSON.stringify(early), "utf8");
    }
    await sleep(DELAY);
  }
  process.stdout.write("\n");
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(EARLY_CACHE, JSON.stringify(early), "utf8");

  // Walk-forward Elo over the full list; sample matches that have early data + warmed teams.
  const elo = new Map();
  const g = (id) => { if (!elo.has(id)) elo.set(id, { r: ELO_START, n: 0 }); return elo.get(id); };
  const samples = [];
  for (const m of list) {
    const R = g(m.radiant_team_id), D = g(m.dire_team_id);
    const expR = eloExpected(R.r, D.r);
    const warm = R.n >= WARMUP && D.n >= WARMUP;
    const e = early.m[m.match_id];
    if (warm && e) {
      samples.push({
        t: m.start_time, y: m.radiant_win ? 1 : 0,
        eloProb: expR, eloLogit: logit(expR),
        gold10: e.gold10, xp10: e.xp10, radTowers: e.radTowers, direTowers: e.direTowers, fb: e.fb,
      });
    }
    const sR = m.radiant_win ? 1 : 0;
    R.r += ELO_K * (sR - expR); D.r += ELO_K * ((1 - sR) - (1 - expR));
    R.n++; D.n++;
  }
  console.log(`\nОценочных матчей (early + warmed Elo): ${samples.length}\n`);
  if (!samples.length) { console.log("Нет early-данных. Запусти снова (докачается кеш)."); return; }

  const metrics = (S, predict) => {
    let n = 0, ok = 0, brier = 0, ll = 0;
    for (const s of S) { const p = clampP(predict(s)); n++; if ((p >= 0.5 ? 1 : 0) === s.y) ok++; brier += (p - s.y) ** 2; ll += -(s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p)); }
    return { n, acc: ok / n, brier: brier / n, logloss: ll / n };
  };

  const handEarly = (s) => applyEarlyGame(s.eloProb, {
    nwDiff: s.gold10, xpDiff: s.xp10, towersA: s.radTowers, towersB: s.direTowers,
    firstBlood: s.fb === 1 ? "a" : s.fb === -1 ? "b" : null,
  }).probA;

  console.log("=== База: до-игровой Elo vs +early (10 мин) ===");
  console.log("модель".padEnd(34), "acc     Brier   logloss");
  for (const [name, fn] of [
    ["Только Elo (до игры)", (s) => s.eloProb],
    ["Elo + early (ручные коэф.)", handEarly],
  ]) {
    const mm = metrics(samples, fn);
    console.log(name.padEnd(34), `${(mm.acc * 100).toFixed(1)}%  ${mm.brier.toFixed(4)}  ${mm.logloss.toFixed(4)}`);
  }

  // Learned logistic: outcome ~ eloLogit + economy features (chronological 80/20).
  const F = (s) => [s.eloLogit, s.gold10 / 1000, s.xp10 / 1000, s.radTowers - s.direTowers, s.fb];
  const NAMES = ["eloLogit", "gold10k", "xp10k", "towerDiff", "fb"];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const split = Math.floor(sorted.length * 0.8);
  const tr = sorted.slice(0, split), te = sorted.slice(split);

  // standardize
  const X = tr.map(F), y = tr.map((s) => s.y);
  const d = X[0].length, mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const r of X) for (let j = 0; j < d; j++) mean[j] += r[j];
  for (let j = 0; j < d; j++) mean[j] /= X.length;
  for (const r of X) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / X.length) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
  // recency weight
  const tmax = tr[tr.length - 1].t;
  const w = tr.map((s) => Math.pow(0.5, (tmax - s.t) / (120 * 86400)));
  const wsum = w.reduce((a, c) => a + c, 0) || 1;

  let W = Array(d).fill(0), b = 0;
  for (let it = 0; it < 800; it++) {
    const gW = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = sigmoid(Z[i].reduce((a, v, j) => a + v * W[j], b));
      const e = (p - y[i]) * w[i];
      for (let j = 0; j < d; j++) gW[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) W[j] -= 0.3 * (gW[j] / wsum + (1.0 * W[j]) / Z.length);
    b -= 0.3 * (gb / wsum);
  }
  const learned = (s) => { const z = F(s).map((v, j) => (v - mean[j]) / std[j]); return sigmoid(z.reduce((a, v, j) => a + v * W[j], b)); };

  console.log(`\n=== Обученные коэф. vs ручные (тест = ${te.length} свежих) ===`);
  console.log("модель".padEnd(34), "acc     Brier   logloss");
  for (const [name, fn] of [
    ["Только Elo", (s) => s.eloProb],
    ["Elo + early (ручные)", handEarly],
    ["Обученные коэф. (логрег)", learned],
  ]) {
    const mm = metrics(te, fn);
    console.log(name.padEnd(34), `${(mm.acc * 100).toFixed(1)}%  ${mm.brier.toFixed(4)}  ${mm.logloss.toFixed(4)}`);
  }
  console.log("\nВклад признаков (стандартизованные):");
  NAMES.forEach((f, j) => console.log(`  ${f.padEnd(10)} ${W[j] >= 0 ? " " : ""}${W[j].toFixed(3)}`));

  // Calibration of hand-tuned early on the whole set.
  console.log("\nКалибровка Elo+early (ручные), вся выборка:");
  const bins = Array.from({ length: 10 }, () => ({ s: 0, y: 0, n: 0 }));
  for (const s of samples) { const p = clampP(handEarly(s)); const bi = Math.min(9, Math.floor(p * 10)); bins[bi].s += p; bins[bi].y += s.y; bins[bi].n++; }
  bins.forEach((r, i) => { if (r.n) console.log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}  pred ${(100 * r.s / r.n).toFixed(0)}%  факт ${(100 * r.y / r.n).toFixed(0)}%  (n=${r.n})`); });
}

main().catch((e) => { console.error("Ошибка early-бэктеста:", e); process.exit(1); });
