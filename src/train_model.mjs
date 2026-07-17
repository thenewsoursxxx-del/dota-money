// Train a calibrated logistic-regression outcome model from train.json.
// Honest evaluation: chronological holdout (train on the older 80%, test on the
// most recent 20%) plus an expanding walk-forward. Recent matches are weighted
// more so the model reflects the CURRENT meta/rosters, not year-old dominance.
// Exports docs/data/model.json for the browser to serve via docs/model_ml.mjs.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { featureVector, predictRaw, predictML } from "../docs/model_ml.mjs";
import { eloExpected } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "docs", "data");

const DAY = 86400;
const HALFLIFE_DAYS = Number(process.env.HALFLIFE || 90); // recency weighting
const L2 = Number(process.env.L2 || 1.0);
const ITERS = Number(process.env.ITERS || 4000);
const LR = Number(process.env.LR || 0.3);

const clamp = (p, e = 1e-6) => Math.min(1 - e, Math.max(e, p));
const brier = (rows, f) => rows.reduce((a, r) => a + (f(r) - r.y) ** 2, 0) / rows.length;
const logloss = (rows, f) => -rows.reduce((a, r) => { const p = clamp(f(r)); return a + (r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p)); }, 0) / rows.length;
const accuracy = (rows, f) => rows.reduce((a, r) => a + (((f(r) > 0.5) === (r.y === 1)) ? 1 : 0), 0) / rows.length;

function standardizer(X) {
  const n = X.length, d = X[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  return { mean, std };
}

// Weighted L2-regularized logistic regression via gradient descent.
function fitLR(X, y, w, { mean, std }, l2 = L2, iters = ITERS, lr = LR) {
  const n = X.length, d = X[0].length;
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const W = new Array(d).fill(0);
  let b = 0;
  const Wsum = w.reduce((a, v) => a + v, 0);
  for (let it = 0; it < iters; it++) {
    const gW = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += W[j] * Z[i][j];
      const err = (sigmoidLocal(z) - y[i]) * w[i];
      for (let j = 0; j < d; j++) gW[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) W[j] -= lr * (gW[j] / Wsum + (l2 * W[j]) / n);
    b -= lr * (gb / Wsum);
  }
  return { weights: W, intercept: b };
}
const sigmoidLocal = (z) => 1 / (1 + Math.exp(-z));
const logitLocal = (p) => Math.log(clamp(p) / (1 - clamp(p)));

// Fit Platt scaling p' = sigmoid(a*logit(p)+b) on (p, y).
function fitPlatt(ps, ys, iters = 3000, lr = 0.3) {
  let a = 1, b = 0;
  const n = ps.length;
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < n; i++) {
      const z = logitLocal(ps[i]);
      const p = sigmoidLocal(a * z + b);
      ga += (p - ys[i]) * z; gb += (p - ys[i]);
    }
    a -= (lr * ga) / n; b -= (lr * gb) / n;
  }
  return { a, b };
}

async function main() {
  const train = JSON.parse(await readFile(join(ROOT, "train.json"), "utf8"));
  const rows = [...train.rows].sort((a, b) => a.t - b.t);
  const nowSec = train.nowSec || Math.floor(Date.now() / 1000);
  console.log(`Строк: ${rows.length} (${new Date(rows[0].t * 1000).toISOString().slice(0,10)} … ${new Date(rows.at(-1).t * 1000).toISOString().slice(0,10)})`);

  const recWeight = (t) => Math.pow(0.5, (nowSec - t) / (HALFLIFE_DAYS * DAY));

  // Elo-only baseline predictor (decayed Elo snapshot).
  const eloP = (r) => eloExpected(r.a.elo, r.b.elo);

  // ---- Chronological holdout: train older 80%, test newest 20% ----
  const cut = Math.floor(rows.length * 0.8);
  const trainRows = rows.slice(0, cut);
  const testRows = rows.slice(cut);

  const Xtr = trainRows.map((r) => featureVector(r.a, r.b));
  const ytr = trainRows.map((r) => r.y);
  const wtr = trainRows.map((r) => recWeight(r.t));
  const std = standardizer(Xtr);

  // Fit LR on the first part of train, Platt on the tail of train (no test leakage).
  const calCut = Math.floor(trainRows.length * 0.85);
  const fitRows = trainRows.slice(0, calCut);
  const calRows = trainRows.slice(calCut);
  const lrFit = fitLR(fitRows.map((r) => featureVector(r.a, r.b)), fitRows.map((r) => r.y), fitRows.map((r) => recWeight(r.t)), std);
  const modelFit = { mean: std.mean, std: std.std, weights: lrFit.weights, intercept: lrFit.intercept, calibration: null };
  const calPs = calRows.map((r) => predictRaw(modelFit, r.a, r.b));
  const platt = fitPlatt(calPs, calRows.map((r) => r.y));
  const modelHold = { ...modelFit, calibration: platt };

  const mlRaw = (r) => predictRaw(modelHold, r.a, r.b);
  const mlCal = (r) => predictML(modelHold, r.a, r.b);

  const report = (name, f, set) => ({ name, acc: accuracy(set, f), brier: brier(set, f), logloss: logloss(set, f) });
  const holdout = {
    n: testRows.length,
    elo: report("Elo", eloP, testRows),
    mlRaw: report("ML(raw)", mlRaw, testRows),
    mlCal: report("ML(calibrated)", mlCal, testRows),
  };

  // ---- Expanding walk-forward (5 folds) for robustness ----
  const folds = 5;
  const wf = { elo: [], ml: [] };
  for (let k = 1; k <= folds; k++) {
    const trEnd = Math.floor((rows.length * k) / (folds + 1));
    const teEnd = Math.floor((rows.length * (k + 1)) / (folds + 1));
    const tr = rows.slice(0, trEnd), te = rows.slice(trEnd, teEnd);
    if (tr.length < 50 || te.length < 20) continue;
    const s = standardizer(tr.map((r) => featureVector(r.a, r.b)));
    const fit = fitLR(tr.map((r) => featureVector(r.a, r.b)), tr.map((r) => r.y), tr.map((r) => recWeight(r.t)), s, L2, 2500, LR);
    const mdl = { mean: s.mean, std: s.std, weights: fit.weights, intercept: fit.intercept, calibration: null };
    wf.elo.push(brier(te, eloP));
    wf.ml.push(brier(te, (r) => predictRaw(mdl, r.a, r.b)));
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  // ---- Final model: train on ALL rows, calibrate on newest 15% ----
  const allStd = standardizer(rows.map((r) => featureVector(r.a, r.b)));
  const fCut = Math.floor(rows.length * 0.85);
  const fFit = rows.slice(0, fCut), fCal = rows.slice(fCut);
  const finalLR = fitLR(fFit.map((r) => featureVector(r.a, r.b)), fFit.map((r) => r.y), fFit.map((r) => recWeight(r.t)), allStd);
  const finalNoCal = { mean: allStd.mean, std: allStd.std, weights: finalLR.weights, intercept: finalLR.intercept, calibration: null };
  const finalPlatt = fitPlatt(fCal.map((r) => predictRaw(finalNoCal, r.a, r.b)), fCal.map((r) => r.y));

  const model = {
    generatedAt: new Date().toISOString(),
    type: "logistic_regression",
    features: ["eloDiff", "form10Diff", "form45Diff", "actDiff", "rustDiff"],
    halflifeDays: HALFLIFE_DAYS,
    l2: L2,
    trainedRows: rows.length,
    mean: allStd.mean.map((x) => Number(x.toFixed(5))),
    std: allStd.std.map((x) => Number(x.toFixed(5))),
    weights: finalLR.weights.map((x) => Number(x.toFixed(5))),
    intercept: Number(finalLR.intercept.toFixed(5)),
    calibration: { a: Number(finalPlatt.a.toFixed(5)), b: Number(finalPlatt.b.toFixed(5)) },
    metrics: {
      holdout,
      walkForwardBrier: { elo: Number(avg(wf.elo).toFixed(4)), ml: Number(avg(wf.ml).toFixed(4)), folds: wf.ml.length },
    },
  };
  await writeFile(join(DATA_DIR, "model.json"), JSON.stringify(model, null, 2), "utf8");

  // ---- Console report ----
  const line = (r) => `acc ${(r.acc * 100).toFixed(1)}%  Brier ${r.brier.toFixed(4)}  LL ${r.logloss.toFixed(4)}`;
  console.log("\n================ ОБУЧЕНИЕ МОДЕЛИ ================");
  console.log(`Фичи: ${model.features.join(", ")}`);
  console.log(`Полураспад веса свежести: ${HALFLIFE_DAYS} дн; L2=${L2}`);
  console.log("\nВеса (стандартизованные):");
  model.features.forEach((f, i) => console.log(`  ${f.padEnd(12)} ${model.weights[i] >= 0 ? "+" : ""}${model.weights[i]}`));
  console.log(`  intercept    ${model.intercept}  (перевес Radiant/стороны A)`);
  console.log(`\n--- Холдаут (тест на свежих ${holdout.n} матчах) ---`);
  console.log(`  Elo baseline:   ${line(holdout.elo)}`);
  console.log(`  ML (raw):       ${line(holdout.mlRaw)}`);
  console.log(`  ML (calibr.):   ${line(holdout.mlCal)}`);
  console.log(`\n--- Walk-forward (${model.metrics.walkForwardBrier.folds} фолдов), средний Brier ---`);
  console.log(`  Elo: ${model.metrics.walkForwardBrier.elo}   ML: ${model.metrics.walkForwardBrier.ml}  (меньше = лучше)`);
  console.log("================================================");
  console.log("Сохранено: docs/data/model.json");
}

main().catch((e) => { console.error("Ошибка обучения:", e); process.exit(1); });
