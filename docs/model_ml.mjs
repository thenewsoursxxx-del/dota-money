// Shared ML model module — used by the Node trainer (src/train_model.mjs) and the
// browser client (docs/app.js). Defines the feature vector, standardization, the
// logistic predictor and probability calibration. Training and serving MUST use
// this exact code so features never drift between offline and online.

// A "snapshot" describes a team's state AS OF a given moment:
//   { elo, form10, form45, act, rust }
//     elo    – time-decayed Elo rating (regresses to 1500 on inactivity)
//     form10 – shrunk win rate over the last 10 games (0..1, 0.5 = neutral)
//     form45 – shrunk win rate over the last 45 days (0..1)
//     act    – games played in the last 45 days (recent activity / roster continuity)
//     rust   – days since the team last played (capped)
//
// Features are always A-minus-B differences, so the model predicts P(A wins).
// The radiant-side advantage is absorbed by the intercept (A = radiant by convention).

export const FEATURES = ["eloDiff", "form10Diff", "form45Diff", "actDiff", "rustDiff"];

export function featureVector(a, b) {
  return [
    (a.elo - b.elo) / 100,        // Elo gap in "hundreds"
    a.form10 - b.form10,          // short-term form (current roster/meta)
    a.form45 - b.form45,          // 45-day form
    (a.act - b.act) / 5,          // recent activity gap
    (b.rust - a.rust) / 30,       // rust gap (more rust = worse → sign favors A)
  ];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp = (p, e = 1e-6) => Math.min(1 - e, Math.max(e, p));
const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));

// Raw logistic probability from standardized features.
// model = { mean:[], std:[], weights:[], intercept, calibration:{a,b} }
export function predictRaw(model, a, b) {
  const x = featureVector(a, b);
  let z = model.intercept;
  for (let i = 0; i < x.length; i++) {
    const s = model.std[i] || 1;
    z += model.weights[i] * ((x[i] - model.mean[i]) / s);
  }
  return sigmoid(z);
}

// Apply Platt calibration (p' = sigmoid(a*logit(p) + b)) if present.
export function calibrate(p, calibration) {
  if (!calibration) return p;
  return sigmoid(calibration.a * logit(p) + calibration.b);
}

// Full per-game P(A wins).
export function predictML(model, a, b) {
  return calibrate(predictRaw(model, a, b), model.calibration);
}

export { sigmoid, logit, clamp };
