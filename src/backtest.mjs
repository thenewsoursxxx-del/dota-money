// Honest walk-forward backtest of the Elo model on Tier-1 history.
// For each chronological match we predict P(radiant win) using ONLY prior games,
// then update Elo. This is genuinely out-of-sample. We report accuracy, Brier,
// log-loss and a calibration table, compare against baselines, and fit a
// time-split calibration (temperature + radiant-side bias) to see if the raw
// Elo probabilities can be sharpened.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLeagues, getProMatches } from "./opendota.mjs";
import { eloExpected, ELO_START, ELO_K } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

const PAGES = Number(process.env.PAGES || 50);
const WARMUP = Number(process.env.WARMUP || 5); // min prior games per team before a match counts

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (p, e = 1e-6) => Math.min(1 - e, Math.max(e, p));

function brier(samples, f = (s) => s.p) {
  return samples.reduce((a, s) => a + (f(s) - s.y) ** 2, 0) / samples.length;
}
function logloss(samples, f = (s) => s.p) {
  return -samples.reduce((a, s) => {
    const p = clamp(f(s));
    return a + (s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p));
  }, 0) / samples.length;
}
function accuracy(samples, f = (s) => s.p) {
  let ok = 0;
  for (const s of samples) {
    const p = f(s);
    if (Math.abs(p - 0.5) < 1e-9) continue;
    if ((p > 0.5) === (s.y === 1)) ok++;
  }
  return ok / samples.length;
}
function calibration(samples, bins = 10, f = (s) => s.p) {
  const rows = Array.from({ length: bins }, () => ({ n: 0, psum: 0, ysum: 0 }));
  for (const s of samples) {
    const p = f(s);
    let i = Math.floor(p * bins);
    if (i >= bins) i = bins - 1;
    if (i < 0) i = 0;
    rows[i].n++; rows[i].psum += p; rows[i].ysum += s.y;
  }
  return rows.map((r, i) => ({
    bucket: `${(i * 100) / bins}-${((i + 1) * 100) / bins}%`,
    n: r.n,
    predicted: r.n ? r.psum / r.n : null,
    actual: r.n ? r.ysum / r.n : null,
  }));
}

// Fit p' = sigmoid(a * logit(p) + b) by gradient descent on log-loss.
function fitCalibration(train, iters = 4000, lr = 0.2) {
  let a = 1, b = 0;
  const n = train.length;
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0;
    for (const s of train) {
      const z = logit(clamp(s.p));
      const p = sigmoid(a * z + b);
      ga += (p - s.y) * z;
      gb += (p - s.y);
    }
    a -= (lr * ga) / n;
    b -= (lr * gb) / n;
  }
  return { a, b };
}

async function main() {
  console.log("1/3 Загружаю Tier-1 лиги...");
  const leagues = await getLeagues();
  const TIER1 = new Set(["premium", "professional"]);
  const premiumIds = new Set(leagues.filter((l) => TIER1.has(l.tier)).map((l) => l.leagueid));

  console.log(`2/3 Загружаю историю про-матчей (${PAGES} страниц)...`);
  const raw = await getProMatches({ pages: PAGES });
  const tier1 = raw
    .filter((m) => premiumIds.has(m.leagueid) && m.radiant_team_id && m.dire_team_id && typeof m.radiant_win === "boolean")
    .sort((a, b) => a.start_time - b.start_time);
  console.log(`   Tier-1 матчей в истории: ${tier1.length}`);

  console.log("3/3 Прогоняю walk-forward Elo...");
  const rating = new Map();
  const gcount = new Map();
  const get = (id) => (rating.has(id) ? rating.get(id) : ELO_START);
  const samples = [];
  for (const m of tier1) {
    const R = m.radiant_team_id, D = m.dire_team_id;
    const rr = get(R), rd = get(D);
    const gR = gcount.get(R) || 0, gD = gcount.get(D) || 0;
    const p = eloExpected(rr, rd);
    const y = m.radiant_win ? 1 : 0;
    if (Math.min(gR, gD) >= WARMUP) samples.push({ t: m.start_time, p, y });
    // update
    rating.set(R, rr + ELO_K * (y - p));
    rating.set(D, rd + ELO_K * ((1 - y) - (1 - p)));
    gcount.set(R, gR + 1); gcount.set(D, gD + 1);
  }

  const N = samples.length;
  const radiantWR = samples.reduce((a, s) => a + s.y, 0) / N;
  const p0 = radiantWR; // base-rate baseline
  const baseBrier = samples.reduce((a, s) => a + (p0 - s.y) ** 2, 0) / N;

  const acc = accuracy(samples);
  const br = brier(samples);
  const ll = logloss(samples);

  // Time-split calibration: fit on first 70%, evaluate on last 30% (honest, out-of-sample).
  const split = Math.floor(N * 0.7);
  const train = samples.slice(0, split);
  const test = samples.slice(split);
  const cal = fitCalibration(train);
  const calP = (s) => sigmoid(cal.a * logit(clamp(s.p)) + cal.b);

  const testRawBrier = brier(test);
  const testRawLL = logloss(test);
  const testCalBrier = brier(test, calP);
  const testCalLL = logloss(test, calP);
  const testRawAcc = accuracy(test);
  const testCalAcc = accuracy(test, calP);

  const report = {
    generatedAt: new Date().toISOString(),
    matchesInHistory: tier1.length,
    evaluatedMatches: N,
    warmupGames: WARMUP,
    radiantWinRate: Number(radiantWR.toFixed(4)),
    overall: {
      accuracy: Number(acc.toFixed(4)),
      brier: Number(br.toFixed(4)),
      logloss: Number(ll.toFixed(4)),
      baselineBrier_baseRate: Number(baseBrier.toFixed(4)),
      brierSkillScore: Number((1 - br / baseBrier).toFixed(4)),
    },
    calibration: calibration(samples),
    timeSplitCalibration: {
      trainN: train.length,
      testN: test.length,
      fitted: { scale_a: Number(cal.a.toFixed(4)), sideBias_b: Number(cal.b.toFixed(4)) },
      testRaw: { accuracy: Number(testRawAcc.toFixed(4)), brier: Number(testRawBrier.toFixed(4)), logloss: Number(testRawLL.toFixed(4)) },
      testCalibrated: { accuracy: Number(testCalAcc.toFixed(4)), brier: Number(testCalBrier.toFixed(4)), logloss: Number(testCalLL.toFixed(4)) },
    },
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "backtest.json"), JSON.stringify(report, null, 2), "utf8");

  // Pretty console summary.
  console.log("\n================ РЕЗУЛЬТАТЫ БЭКТЕСТА ================");
  console.log(`Матчей в истории:        ${tier1.length}`);
  console.log(`Оценено (после разогрева ${WARMUP} игр): ${N}`);
  console.log(`Radiant win rate:        ${(radiantWR * 100).toFixed(1)}%`);
  console.log("--- Точность модели (walk-forward, out-of-sample) ---");
  console.log(`Accuracy (кто фаворит — тот и выиграл): ${(acc * 100).toFixed(1)}%`);
  console.log(`Brier:   ${br.toFixed(4)}  (базлайн base-rate: ${baseBrier.toFixed(4)})`);
  console.log(`LogLoss: ${ll.toFixed(4)}`);
  console.log(`Brier Skill Score vs base-rate: ${((1 - br / baseBrier) * 100).toFixed(1)}%  (>0 = лучше базлайна)`);
  console.log("--- Калибровка (предсказано → реально) ---");
  for (const r of report.calibration) {
    if (!r.n) continue;
    const bar = "#".repeat(Math.round((r.actual || 0) * 20));
    console.log(`  ${r.bucket.padEnd(10)} n=${String(r.n).padStart(4)}  pred ${(r.predicted * 100).toFixed(0).padStart(3)}% → real ${(r.actual * 100).toFixed(0).padStart(3)}%  ${bar}`);
  }
  console.log("--- Тайм-сплит калибровка (обучили на 70%, тест на 30%) ---");
  console.log(`  Подобрано: scale a=${cal.a.toFixed(3)}, side-bias b=${cal.b.toFixed(3)} (b>0 = у Radiant реальный перевес)`);
  console.log(`  Тест RAW:        acc ${(testRawAcc * 100).toFixed(1)}%  Brier ${testRawBrier.toFixed(4)}  LL ${testRawLL.toFixed(4)}`);
  console.log(`  Тест CALIBRATED: acc ${(testCalAcc * 100).toFixed(1)}%  Brier ${testCalBrier.toFixed(4)}  LL ${testCalLL.toFixed(4)}`);
  console.log("====================================================");
  console.log("Сохранено: docs/data/backtest.json");
}

main().catch((e) => {
  console.error("Ошибка бэктеста:", e);
  process.exit(1);
});
