// Replay-grade match parse from Stratz (no .dem download).
// Extracts what actually happened: tip minute, fight clusters, lanes, objectives,
// carry performance — so learn_match can compare DRAFT BELIEFS vs EXECUTION FACTS.
//
// Leakage rules:
//   - All features here are POST-MATCH facts (labels / analysis), never fed into
//     pre-game Elo/ML snapshots as inputs for the same match.
//   - They enrich lessons + hero_evidence + replay_corpus for calibration and
//     future models trained on PAST matches only.

import { stratzQuery } from "./stratz.mjs";

const FIGHT_GAP_SEC = 18;
const FIGHT_MIN_KILLS = 3;
const TIP_GOLD = 5000;

export async function fetchReplayMatch(matchId) {
  const d = await stratzQuery(`{ match(id: ${matchId}) {
    id didRadiantWin durationSeconds startDateTime
    radiantTeamId direTeamId
    radiantTeam { name } direTeam { name }
    bottomLaneOutcome midLaneOutcome topLaneOutcome
    radiantNetworthLeads radiantExperienceLeads
    pickBans { heroId isPick isRadiant order }
    towerDeaths { time isRadiant npcId }
    playbackData {
      roshanEvents { time }
    }
    players {
      heroId isRadiant steamAccountId
      steamAccount { name }
      networth kills deaths assists
      heroDamage heroHealing towerDamage
      stats {
        killEvents { time }
        deathEvents { time }
        assistEvents { time }
        networthPerMinute
        level
      }
    }
  }}`);
  return d?.match || null;
}

function laneWin(side, outcome) {
  // outcome: RADIANT_VICTORY | DIRE_VICTORY | TIE | null
  if (!outcome || outcome === "TIE") return 0;
  if (side === "radiant") return outcome === "RADIANT_VICTORY" ? 1 : -1;
  return outcome === "DIRE_VICTORY" ? 1 : -1;
}

/** Cluster kill events into teamfights; credit the side that scored more kills. */
export function clusterFights(players) {
  const events = [];
  for (const p of players || []) {
    for (const k of p.stats?.killEvents || []) {
      if (k?.time == null) continue;
      events.push({ time: k.time, radiant: !!p.isRadiant, heroId: p.heroId });
    }
  }
  events.sort((a, b) => a.time - b.time);
  if (!events.length) return { fights: [], radiantWins: 0, direWins: 0, draws: 0 };

  const clusters = [];
  let cur = [events[0]];
  for (let i = 1; i < events.length; i++) {
    if (events[i].time - cur[cur.length - 1].time <= FIGHT_GAP_SEC) cur.push(events[i]);
    else { clusters.push(cur); cur = [events[i]]; }
  }
  clusters.push(cur);

  let radiantWins = 0, direWins = 0, draws = 0;
  const fights = [];
  for (const c of clusters) {
    if (c.length < FIGHT_MIN_KILLS) continue;
    const r = c.filter((e) => e.radiant).length;
    const d = c.length - r;
    let winner = "draw";
    if (r > d) { winner = "radiant"; radiantWins++; }
    else if (d > r) { winner = "dire"; direWins++; }
    else draws++;
    const heroesR = [...new Set(c.filter((e) => e.radiant).map((e) => e.heroId))];
    const heroesD = [...new Set(c.filter((e) => !e.radiant).map((e) => e.heroId))];
    fights.push({
      t0: c[0].time,
      t1: c[c.length - 1].time,
      min: Number((c[0].time / 60).toFixed(1)),
      killsR: r,
      killsD: d,
      winner,
      heroesR,
      heroesD,
    });
  }
  return { fights, radiantWins, direWins, draws };
}

/** First minute where winner holds ≥ TIP_GOLD lead (and still leads at tip+5 if available). */
export function findTipMinute(leads, didRadiantWin) {
  if (!Array.isArray(leads) || !leads.length) return null;
  const sign = didRadiantWin ? 1 : -1;
  for (let min = 5; min < leads.length; min++) {
    const nw = leads[min];
    if (nw == null) continue;
    if (Math.sign(nw) !== sign || Math.abs(nw) < TIP_GOLD) continue;
    const later = leads[Math.min(min + 5, leads.length - 1)];
    if (later != null && Math.sign(later) !== sign) continue;
    return { minute: min, nwDiff: nw };
  }
  return null;
}

export function objectivePace(towerDeaths, durationSec, didRadiantWin) {
  const towers = towerDeaths || [];
  // isRadiant on towerDeath = the tower that DIED belonged to radiant → dire destroyed it
  const byMin = { "10": { r: 0, d: 0 }, "20": { r: 0, d: 0 }, "30": { r: 0, d: 0 } };
  for (const t of towers) {
    const min = (t.time || 0) / 60;
    // radiant tower died → dire scored an objective
    const direScored = !!t.isRadiant;
    for (const cut of [10, 20, 30]) {
      if (min <= cut) {
        if (direScored) byMin[String(cut)].d++;
        else byMin[String(cut)].r++;
      }
    }
  }
  const winnerSide = didRadiantWin ? "radiant" : "dire";
  return {
    towersFallen: towers.length,
    byMinute: byMin,
    winnerObjectivesAt20: didRadiantWin ? byMin["20"].r : byMin["20"].d,
    loserObjectivesAt20: didRadiantWin ? byMin["20"].d : byMin["20"].r,
    durationMin: Number(((durationSec || 0) / 60).toFixed(1)),
    winnerSide,
  };
}

export function playerBoard(players, meta) {
  const hn = (id) => meta?.heroes?.[id]?.name || `Hero ${id}`;
  const rows = (players || []).map((p) => ({
    heroId: p.heroId,
    hero: hn(p.heroId),
    isRadiant: !!p.isRadiant,
    name: p.steamAccount?.name || null,
    accountId: p.steamAccountId || null,
    nw: p.networth || 0,
    k: p.kills || 0,
    d: p.deaths || 0,
    a: p.assists || 0,
    hd: p.heroDamage || 0,
    td: p.towerDamage || 0,
    heal: p.heroHealing || 0,
  }));
  rows.sort((a, b) => b.nw - a.nw);
  return rows;
}

/**
 * Full structured replay analysis for one match.
 * @param {object} m - fetchReplayMatch result
 * @param {object} meta - docs/data/meta.json
 * @param {object|null} draftBelief - optional { components, draftProbA, arch } from scoreDraft/analyzeDraft
 */
export function analyzeReplay(m, meta, draftBelief = null) {
  if (!m) return null;
  const didRad = !!m.didRadiantWin;
  const winnerSide = didRad ? "radiant" : "dire";
  const fights = clusterFights(m.players);
  const tip = findTipMinute(m.radiantNetworthLeads || [], didRad);
  const objectives = objectivePace(m.towerDeaths || m.playbackData?.buildingEvents, m.durationSeconds, didRad);
  const board = playerBoard(m.players, meta);
  const topWinner = board.find((p) => p.isRadiant === didRad) || null;
  const topLoser = board.find((p) => p.isRadiant !== didRad) || null;

  const fightWinRateR = fights.radiantWins + fights.direWins
    ? fights.radiantWins / (fights.radiantWins + fights.direWins)
    : 0.5;
  const fightWinnerSide = fights.radiantWins === fights.direWins
    ? "draw"
    : (fights.radiantWins > fights.direWins ? "radiant" : "dire");

  const lanes = {
    top: m.topLaneOutcome || null,
    mid: m.midLaneOutcome || null,
    bot: m.bottomLaneOutcome || null,
    radiantLaneScore:
      (laneWin("radiant", m.topLaneOutcome) > 0 ? 1 : 0) +
      (laneWin("radiant", m.midLaneOutcome) > 0 ? 1 : 0) +
      (laneWin("radiant", m.bottomLaneOutcome) > 0 ? 1 : 0),
  };

  // Roshan events from Stratz lack killer side — keep timestamps only.
  const rosh = (m.playbackData?.roshanEvents || []).map((e) => ({
    min: Number(((e.time || 0) / 60).toFixed(1)),
  }));

  // Draft belief vs reality (only when we have pre-game draft components)
  const mismatches = [];
  if (draftBelief?.components) {
    const fightComp = draftBelief.components.fight || 0;
    // Positive fight → model thought radiant had better teamfight draft
    const draftFightSide = Math.abs(fightComp) < 0.04 ? "neutral"
      : fightComp > 0 ? "radiant" : "dire";
    if (draftFightSide !== "neutral" && fightWinnerSide !== "draw" && draftFightSide !== fightWinnerSide) {
      mismatches.push({
        code: "paper_fight_lost",
        detail: `Draft fight term favored ${draftFightSide} (${fightComp >= 0 ? "+" : ""}${fightComp.toFixed(2)}), but fight clusters went to ${fightWinnerSide} (${fights.radiantWins}:${fights.direWins}).`,
      });
    }
    if (draftFightSide !== "neutral" && draftFightSide !== winnerSide && fightWinnerSide === winnerSide) {
      mismatches.push({
        code: "paper_fight_overrated",
        detail: `Draft overrated ${draftFightSide} teamfight; winner ${winnerSide} also won the fights on the map.`,
      });
    }
    const laneComp = draftBelief.components.lane || 0;
    const draftLaneSide = Math.abs(laneComp) < 0.03 ? "neutral" : laneComp > 0 ? "radiant" : "dire";
    const laneWinner = lanes.radiantLaneScore >= 2 ? "radiant" : lanes.radiantLaneScore <= 0 ? "dire" : "mixed";
    if (draftLaneSide !== "neutral" && laneWinner !== "mixed" && draftLaneSide !== laneWinner) {
      mismatches.push({
        code: "lane_belief_wrong",
        detail: `Draft lane favored ${draftLaneSide}, lane stage went ${laneWinner} (T/M/B ${lanes.top}/${lanes.mid}/${lanes.bot}).`,
      });
    }
  }

  if (tip && tip.minute <= 12 && Math.abs(tip.nwDiff) >= 8000) {
    mismatches.push({
      code: "early_stomp",
      detail: `Game tipped by ${tip.minute}′ (nw ${tip.nwDiff >= 0 ? "+" : ""}${tip.nwDiff}) — winner converted before late draft windows mattered.`,
    });
  }

  // Heroes that participated in won fights on the winning side → fight credit
  const fightCredit = {};
  for (const f of fights.fights) {
    if (f.winner !== winnerSide) continue;
    const ids = f.winner === "radiant" ? f.heroesR : f.heroesD;
    for (const id of ids) fightCredit[id] = (fightCredit[id] || 0) + 1;
  }

  return {
    matchId: m.id,
    durationMin: Number((m.durationSeconds / 60).toFixed(1)),
    winnerSide,
    tip,
    fights: {
      n: fights.fights.length,
      radiantWins: fights.radiantWins,
      direWins: fights.direWins,
      draws: fights.draws,
      winRateRadiant: Number(fightWinRateR.toFixed(3)),
      fightWinnerSide,
      samples: fights.fights.slice(0, 12),
    },
    lanes,
    objectives,
    roshan: rosh,
    board: {
      radiant: board.filter((p) => p.isRadiant),
      dire: board.filter((p) => !p.isRadiant),
      topWinner,
      topLoser,
    },
    fightCredit,
    mismatches,
    pickBans: (m.pickBans || []).filter((p) => p.isPick).map((p) => ({
      heroId: p.heroId,
      isRadiant: p.isRadiant,
      order: p.order,
    })),
  };
}

/** Merge replay mismatches into learn_match failureModes (no duplicates by code). */
export function mergeFailureModes(existing, replay) {
  const out = [...(existing || [])];
  const have = new Set(out.map((x) => x.code));
  for (const m of replay?.mismatches || []) {
    if (have.has(m.code)) continue;
    out.push(m);
    have.add(m.code);
  }
  return out;
}
