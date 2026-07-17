// Draft / hero intelligence model (v2).
// - Player hero-pool concentration (predictability)
// - Hero "counterability" from pro matchup winrates
// - Matchup-aware draft vulnerability (does the OPPONENT actually play the counters?)
//
// Shared ESM: build step precomputes heavy parts (computeHeroMeta, computePlayerPool);
// the browser only runs the light matchup analysis on the compact draft.json.

import { seriesWinProb } from "./model.mjs";

export const MIN_MATCHUP_GAMES = 20; // ignore tiny matchup samples
export const MIN_POOL_GAMES = 8;     // ignore heroes a player barely touched
export const MAX_PER_GAME_ADJ = 0.08; // draft can shift a per-game prob by at most ±8%

// ---------- BUILD-TIME helpers ----------

// Recency weight from a unix timestamp (seconds). Recent games count more.
export function recencyFactor(lastPlayedSec, nowSec = Date.now() / 1000) {
  const ageDays = (nowSec - (lastPlayedSec || 0)) / 86400;
  return Math.max(0.15, Math.min(1, 1 - ageDays / 900)); // ~2.5 years to floor
}

// From a hero's matchup list (wins of THIS hero vs each opponent), derive:
//  - counterability: how exploitable the hero is (0..1), from its worst matchups
//  - topCounters: opponents that beat this hero hardest
export function computeHeroCounters(matchups, heroName) {
  const rows = (matchups || [])
    .filter((m) => m.games_played >= MIN_MATCHUP_GAMES)
    .map((m) => ({ id: m.hero_id, wr: m.wins / m.games_played, games: m.games_played }));
  if (rows.length === 0) return { counterability: 0, topCounters: [] };

  rows.sort((a, b) => a.wr - b.wr); // worst matchups first (low winrate = strong counter)
  const worst = rows.slice(0, 4);
  // Average how far below 50% the worst matchups are, scaled to 0..1.
  const avgDeficit = worst.reduce((s, r) => s + Math.max(0, 0.5 - r.wr), 0) / worst.length;
  const counterability = Math.max(0, Math.min(1, avgDeficit * 3));
  const topCounters = rows.slice(0, 5).map((r) => ({ id: r.id, wr: r.wr, games: r.games }));
  return { counterability, topCounters, name: heroName };
}

// Build a player's hero pool profile from OpenDota's per-hero career rows.
export function computePlayerPool(heroesRaw, heroMeta, heroName) {
  const rows = (heroesRaw || [])
    .filter((h) => h.games >= MIN_POOL_GAMES)
    .map((h) => ({
      id: h.hero_id,
      games: h.games,
      wr: h.games ? h.win / h.games : 0,
      score: h.games * recencyFactor(h.last_played),
    }));
  if (rows.length === 0) {
    return { poolWidth: 0, predictability: 0, signature: [] };
  }
  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, 10);
  const sum = top.reduce((s, r) => s + r.score, 0) || 1;
  const weights = top.map((r) => r.score / sum);

  // Effective pool size (perplexity of the weight distribution).
  const entropy = -weights.reduce((s, w) => s + (w > 0 ? w * Math.log(w) : 0), 0);
  const poolWidth = Math.exp(entropy);
  const predictability = Math.max(0, Math.min(1, 1 - (poolWidth - 1) / 7));

  const signature = top.slice(0, 5).map((r, i) => {
    const meta = (heroMeta && heroMeta[r.id]) || { counterability: 0, topCounters: [] };
    return {
      id: r.id,
      name: heroName ? heroName(r.id) : String(r.id),
      weight: weights[i],
      games: r.games,
      wr: r.wr,
      counterability: meta.counterability || 0,
      topCounters: (meta.topCounters || []).slice(0, 3).map((c) => ({
        id: c.id,
        name: heroName ? heroName(c.id) : String(c.id),
        wr: c.wr,
      })),
    };
  });

  return { poolWidth, predictability, signature };
}

// Team-level generic vulnerability (opponent-agnostic), for quick display.
export function computeTeamVulnerability(roster) {
  const players = (roster || []).filter((p) => p.signature && p.signature.length);
  if (!players.length) return 0;
  const per = players.map((p) =>
    p.signature.reduce((s, h) => s + h.weight * (h.counterability || 0), 0)
  );
  return per.reduce((a, b) => a + b, 0) / per.length;
}

// ---------- CLIENT-TIME matchup analysis ----------

function playerExposure(player, oppHeroSet) {
  if (!player.signature || !player.signature.length) return { exposure: 0, threats: [] };
  let exposure = 0;
  const threats = [];
  for (const h of player.signature) {
    const oppPlays = (h.topCounters || []).some((c) => oppHeroSet.has(c.id));
    const term = h.weight * (h.counterability || 0) * (oppPlays ? 1.4 : 1);
    exposure += term;
    if ((h.counterability || 0) >= 0.28 && h.weight >= 0.12) {
      threats.push({
        heroId: h.id,
        heroName: h.name,
        weight: h.weight,
        wr: h.wr,
        counterability: h.counterability,
        counters: (h.topCounters || []).map((c) => ({ ...c, byOpp: oppHeroSet.has(c.id) })),
      });
    }
  }
  return { exposure, threats };
}

// Analyze how draft/pool dynamics favor one side.
// teamA/teamB: draft.json team objects ({ name, teamHeroes:[{id,...}], roster:[player...] }).
export function analyzeMatchup(teamA, teamB) {
  const aSet = new Set((teamA.teamHeroes || []).map((h) => h.id));
  const bSet = new Set((teamB.teamHeroes || []).map((h) => h.id));

  const aPlayers = (teamA.roster || []).map((p) => ({ player: p, ...playerExposure(p, bSet) }));
  const bPlayers = (teamB.roster || []).map((p) => ({ player: p, ...playerExposure(p, aSet) }));

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.exposure, 0) / arr.length : 0);
  const exposureA = mean(aPlayers);
  const exposureB = mean(bPlayers);
  const edge = exposureA - exposureB; // >0 → A more exposed → favors B

  const deltaPerGameA = Math.max(-MAX_PER_GAME_ADJ, Math.min(MAX_PER_GAME_ADJ, -edge * 0.22));

  const pickThreats = (players) =>
    players
      .filter((x) => x.threats.length)
      .sort((a, b) => b.exposure - a.exposure)
      .map((x) => ({ player: x.player.name, exposure: x.exposure, threats: x.threats }));

  return {
    exposureA,
    exposureB,
    edge,
    deltaPerGameA,
    threatsA: pickThreats(aPlayers), // A's players that B can punish
    threatsB: pickThreats(bPlayers), // B's players that A can punish
  };
}

// Apply the draft adjustment to an Elo-based prediction, recomputing series probs.
export function applyDraftAdjustment(prediction, analysis, format = "bo3") {
  const basePerGameA = prediction.perGame.a;
  const adjPerGameA = Math.max(0.02, Math.min(0.98, basePerGameA + analysis.deltaPerGameA));
  const seriesA = seriesWinProb(adjPerGameA, format);
  return {
    ...prediction,
    draft: {
      applied: true,
      deltaPerGameA: analysis.deltaPerGameA,
      exposureA: analysis.exposureA,
      exposureB: analysis.exposureB,
      edge: analysis.edge,
      basePerGame: { a: basePerGameA, b: 1 - basePerGameA },
      threatsA: analysis.threatsA,
      threatsB: analysis.threatsB,
    },
    perGame: { a: adjPerGameA, b: 1 - adjPerGameA },
    series: { a: seriesA, b: 1 - seriesA },
  };
}
