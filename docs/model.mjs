// Prediction model: team strength via Elo built from Tier-1 match history,
// plus value / EV math against bookmaker odds.
// Shared ESM module — used both by the Node build step and the browser frontend.

export const ELO_START = 1500;
export const ELO_K = 32;

// Expected score (win probability) of A vs B given Elo ratings.
export function eloExpected(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Build Elo ratings from a chronologically-sorted list of games.
// Each game: { start_time, radiant_team_id, dire_team_id, radiant_win, radiant_name, dire_name }
export function buildElo(games) {
  const sorted = [...games].sort((a, b) => a.start_time - b.start_time);
  const teams = new Map(); // id -> { id, name, rating, games, wins, losses, lastPlayed }

  const ensure = (id, name) => {
    const clean = name ? String(name).trim() : "";
    if (!teams.has(id)) {
      teams.set(id, { id, name: clean || `Team ${id}`, rating: ELO_START, games: 0, wins: 0, losses: 0, lastPlayed: 0 });
    }
    const t = teams.get(id);
    if (clean) t.name = clean; // keep most recent name
    return t;
  };

  for (const g of sorted) {
    if (g.radiant_team_id == null || g.dire_team_id == null) continue;
    if (typeof g.radiant_win !== "boolean") continue;
    const R = ensure(g.radiant_team_id, g.radiant_name);
    const D = ensure(g.dire_team_id, g.dire_name);

    const expR = eloExpected(R.rating, D.rating);
    const scoreR = g.radiant_win ? 1 : 0;

    R.rating += ELO_K * (scoreR - expR);
    D.rating += ELO_K * ((1 - scoreR) - (1 - expR));

    R.games++; D.games++;
    if (g.radiant_win) { R.wins++; D.losses++; } else { R.losses++; D.wins++; }
    R.lastPlayed = D.lastPlayed = g.start_time;
  }

  return teams;
}

// Convert a per-game win probability into a series win probability.
export function seriesWinProb(p, format = "bo3") {
  switch (format) {
    case "bo1":
      return p;
    case "bo3": // first to 2
      return p * p * (3 - 2 * p);
    case "bo5": // first to 3
      return p * p * p * (6 * p * p - 15 * p + 10);
    default:
      return p;
  }
}

// Remove bookmaker margin (vig) from a pair of decimal odds to get fair implied probs.
export function fairImplied(oddsA, oddsB) {
  if (!oddsA || !oddsB || oddsA <= 1 || oddsB <= 1) return null;
  const rawA = 1 / oddsA;
  const rawB = 1 / oddsB;
  const overround = rawA + rawB;
  return { a: rawA / overround, b: rawB / overround, overround };
}

// Value assessment for betting side A at decimal odds `odds`, given model prob `p`.
export function valueForSide(p, odds) {
  if (!odds || odds <= 1) return null;
  const impliedRaw = 1 / odds;
  const ev = p * odds - 1;                 // expected profit per 1 unit staked
  const edge = p - impliedRaw;             // model prob minus (vig-inclusive) implied
  const kelly = (p * odds - 1) / (odds - 1); // full-Kelly fraction (can be negative)
  return { odds, impliedRaw, ev, edge, kelly };
}

// Reliability heuristic: how much history backs the rating (0..1).
export function reliability(gamesA, gamesB) {
  const g = Math.min(gamesA || 0, gamesB || 0);
  return Math.max(0, Math.min(1, g / 20));
}

// Full head-to-head prediction.
// teamA/teamB: { id, name, rating, games }
export function predict(teamA, teamB, { format = "bo3", oddsA = null, oddsB = null, pGameOverride = null } = {}) {
  // pGameOverride lets a richer model (e.g. the trained ML model) supply the per-game
  // probability while we reuse all the series/value/recommendation math below.
  const pGame = pGameOverride != null ? pGameOverride : eloExpected(teamA.rating, teamB.rating);
  const pSeriesA = seriesWinProb(pGame, format);
  const pSeriesB = 1 - pSeriesA;

  const out = {
    format,
    perGame: { a: pGame, b: 1 - pGame },
    series: { a: pSeriesA, b: pSeriesB },
    reliability: reliability(teamA.games, teamB.games),
    ratings: { a: teamA.rating, b: teamB.rating },
    market: null,
    value: null,
  };

  if (oddsA && oddsB) {
    const fair = fairImplied(oddsA, oddsB);
    const vA = valueForSide(pSeriesA, oddsA);
    const vB = valueForSide(pSeriesB, oddsB);
    out.market = fair ? { impliedA: fair.a, impliedB: fair.b, overround: fair.overround } : null;
    out.value = {
      a: vA,
      b: vB,
      recommendation: pickRecommendation(vA, vB, teamA, teamB),
    };
  }
  return out;
}

function pickRecommendation(vA, vB, teamA, teamB) {
  const candidates = [];
  if (vA && vA.ev > 0) candidates.push({ side: "a", team: teamA.name, ...vA });
  if (vB && vB.ev > 0) candidates.push({ side: "b", team: teamB.name, ...vB });
  if (candidates.length === 0) return { bet: false, reason: "Нет положительного матожидания" };
  candidates.sort((x, y) => y.ev - x.ev);
  const best = candidates[0];
  return {
    bet: best.ev >= 0.05, // require >=5% edge to flag as a value bet
    side: best.side,
    team: best.team,
    ev: best.ev,
    edge: best.edge,
    kelly: best.kelly,
    reason: best.ev >= 0.05 ? "Value-ставка: модель даёт больше, чем кэф" : "Небольшой перевес, но ниже порога 5%",
  };
}
