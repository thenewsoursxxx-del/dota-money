// Live draft intelligence engine (v3) — client-side, pure functions.
// Given two drafted line-ups (+ optional player assignment) it scores the matchup
// on the factors research shows actually decide games: meta strength, synergy,
// counters, power-curve/timing, lane economy, damage balance, lockdown, composition,
// and player-pool lock. Produces a draft win-probability, a blended prob with Elo,
// a confidence level, and a commentator-style explanation.
//
// Draft-only prediction is capped (~55-70%) on purpose: peer-reviewed models show
// draft alone tops out there; high confidence needs early-game economy (next stage).

import { eloExpected, seriesWinProb } from "./model.mjs";

// ---------- math helpers ----------
const K_SHRINK = 6; // pull thin winrate samples toward 0.5
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4)));
const shrunkWR = (g, w, prior = 0.5) => (w + K_SHRINK * prior) / (g + K_SHRINK);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const pairKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

// ---------- weights (edge in logit-ish units, A's perspective) ----------
const W = {
  meta: 1.0,
  synergy: 0.9,
  counter: 1.3,
  lane: 0.7,
  timing: 0.4,
  dmg: 0.6,
  lock: 0.35,
  pool: 1.1,
  player: 0.8, // individual human factor (recent form / prime / real on-hero comfort)
};
const EDGE_CAP = 0.75; // base cap on total draft edge
const EDGE_CAP_EXTREME = 1.05; // when strong pool-lock / hard counters present
const K_PROB = 1.7; // edge -> probability steepness
// How much the draft logit adds on top of the Elo/ML base. Kept deliberately low: leakage-free
// backtests show draft-alone is ~coin-flip out-of-sample and a heavy blend only makes predictions
// MORE extreme without improving accuracy (it compounds with form, which already encodes team
// quality). So the draft nudges the prior; the real upset-catching signal is the live economy.
const BLEND = 0.3;

// ---------- per-hero lookups ----------
// STRATZ current-patch, role-aware winrate. We pick the position the hero is ACTUALLY
// played most (max games), so a hero can read strong as a core and weak as a support.
// Returns { wr, games, pos } or null.
function stratzHeroWR(stratz, id) {
  if (!stratz || !stratz.heroes) return null;
  const h = stratz.heroes[id];
  if (!h) return null;
  let best = null;
  for (const [pos, v] of Object.entries(h.pos || {})) {
    if (v && v.games && (!best || v.games > best.games)) best = { wr: v.wr, games: v.games, pos: Number(pos) };
  }
  if (!best && h.overall && h.overall.wr != null) best = { wr: h.overall.wr, games: h.overall.games, pos: null };
  return best;
}

// Hero strength as a winrate. Pro Tier-1 sample (meta.json) is the most relevant but
// thin; STRATZ high-MMR is huge and reflects the CURRENT patch. Blend the two so the
// meta term tracks the live patch instead of a stale pro average.
function heroWR(meta, id, stratz) {
  const h = meta.heroes[id];
  let proWR = 0.5, hasPro = false;
  if (h) {
    if (h.games >= 6) { proWR = shrunkWR(h.games, h.wins); hasPro = true; }
    else if (h.winrate != null) { proWR = h.winrate; hasPro = true; }
  }
  const s = stratzHeroWR(stratz, id);
  if (!s) return proWR;
  if (!hasPro) return s.wr;
  return 0.55 * proWR + 0.45 * s.wr;
}

function heroCurve(meta, id) {
  const h = meta.heroes[id];
  const d = h && h.dur;
  const b = (x) => (x && x.g ? shrunkWR(x.g, x.w) : 0.5);
  return { early: b(d && d.short), mid: b(d && d.mid), late: b(d && d.long) };
}

function heroKnow(knowledge, meta, id) {
  const name = meta.heroes[id] && meta.heroes[id].name;
  const k = name && knowledge.heroes[name];
  if (k) return k;
  // Fallback from roles when not curated.
  const roles = (meta.heroes[id] && meta.heroes[id].roles) || [];
  const has = (r) => roles.includes(r);
  return {
    dmg: "mix",
    lock: has("Disabler") ? 2 : 0,
    tf: has("Initiator") ? 2 : has("Nuker") ? 1 : 0,
    push: has("Pusher") ? 2 : 0,
    pickoff: has("Escape") || has("Nuker") ? 2 : 1,
    save: has("Support") ? 0 : 0,
    scale: has("Carry") ? "late" : "mid",
    _inferred: true,
  };
}

// ---------- team aggregates ----------
function teamMeta(meta, ids, stratz) {
  return avg(ids.map((id) => heroWR(meta, id, stratz) - 0.5));
}

function teamSynergy(meta, ids) {
  const vals = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const e = meta.synergy[pairKey(ids[i], ids[j])];
      if (e) vals.push(shrunkWR(e[0], e[1]) - 0.5);
    }
  return avg(vals);
}

// Average winrate of `mine` heroes vs `theirs` (directional counter signal).
// Prefer STRATZ high-MMR matchups (hundreds of games/pair) over the pro-only co-occurrence
// matrix (usually 0-6 games/pair = noise). Falls back to the pro matrix when a matchup is missing.
function teamCounter(meta, matchups, mine, theirs) {
  const vals = [];
  const hardCounters = [];
  for (const a of mine)
    for (const b of theirs) {
      let wr = null, g = 0, src = null;
      const mu = matchups && matchups.heroes[a] && matchups.heroes[a].vs[b]; // [games, wins] of a vs b
      if (mu && mu[0] >= 30) { wr = shrunkWR(mu[0], mu[1]); g = mu[0]; src = "stratz"; }
      else {
        const e = meta.counter[`${a},${b}`];
        if (e && e[0] >= 4) { wr = shrunkWR(e[0], e[1]); g = e[0]; src = "pro"; }
      }
      if (wr == null) continue;
      vals.push(wr - 0.5);
      // Hard counter: robust Stratz sample can trust a tighter bar; thin pro sample needs a harder one.
      const bar = src === "stratz" ? 0.46 : 0.43;
      if (wr <= bar) hardCounters.push({ a, b, wr, g, src });
    }
  return { edge: avg(vals), hardCounters };
}

function teamCurves(meta, ids) {
  const cs = ids.map((id) => heroCurve(meta, id));
  return {
    early: avg(cs.map((c) => c.early)),
    mid: avg(cs.map((c) => c.mid)),
    late: avg(cs.map((c) => c.late)),
  };
}

function teamNW10(meta, ids) {
  const vals = ids.map((id) => meta.heroes[id] && meta.heroes[id].nw10).filter((x) => x != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function teamDamage(knowledge, meta, ids) {
  const counts = { phys: 0, mag: 0, pure: 0, mix: 0 };
  for (const id of ids) counts[heroKnow(knowledge, meta, id).dmg]++;
  // mixed heroes split their weight.
  const phys = counts.phys + counts.mix * 0.5;
  const mag = counts.mag + counts.pure + counts.mix * 0.5;
  const total = phys + mag || 1;
  const fracPhys = phys / total;
  const dominant = fracPhys >= 0.5 ? "физический" : "магический";
  const frac = Math.max(fracPhys, 1 - fracPhys);
  return { fracPhys, dominant, frac, imbalance: Math.max(0, frac - 0.62) };
}

function teamArchetype(knowledge, meta, ids) {
  let tf = 0, push = 0, pickoff = 0, lock = 0, lockPierce = 0, save = 0;
  for (const id of ids) {
    const k = heroKnow(knowledge, meta, id);
    tf += k.tf || 0; push += k.push || 0; pickoff += k.pickoff || 0;
    lock += k.lock || 0; if ((k.lock || 0) >= 3) lockPierce++;
    save += k.save || 0;
  }
  const labelPick = [["тимфайт", tf], ["пуш", push], ["пикофф", pickoff]].sort((a, b) => b[1] - a[1])[0][0];
  return { tf, push, pickoff, lock, lockPierce, save, label: labelPick };
}

// ---------- player-pool lock (optional) ----------
// assignA/assignB: map heroId(number) -> roster player object (with signature[]) or absent.
function poolFindings(meta, assign, myIds, oppIds) {
  const oppSet = new Set(oppIds);
  const findings = [];
  const comfort = []; // players on a signature hero
  let penalty = 0; // reduces this team's edge
  if (!assign) return { penalty, findings, comfort };
  for (const id of myIds) {
    const pl = assign[id];
    if (!pl || !pl.signature || !pl.signature.length) continue;
    const sig = pl.signature.find((s) => s.id === id);
    const topSig = pl.signature[0];
    const heroNm = meta.heroes[id] ? meta.heroes[id].name : `Hero ${id}`;
    if (sig) {
      // On comfort: playing one of their signature heroes.
      comfort.push({ player: pl.name, hero: heroNm, weight: sig.weight, wr: sig.wr });
    } else {
      // Forced off their comfort pool.
      const sev = 0.05 * (0.6 + (pl.predictability || 0));
      penalty += sev;
      // Did the opponent pre-empt/counter their signature heroes?
      const counteredSig = pl.signature
        .filter((s) => (s.topCounters || []).some((c) => oppSet.has(c.id)))
        .slice(0, 2)
        .map((s) => s.name);
      findings.push({
        type: "offpool",
        player: pl.name,
        hero: heroNm,
        signature: topSig ? topSig.name : null,
        signatureTop: pl.signature.slice(0, 3).map((s) => s.name), // whole comfort pool is considered, not just #1
        poolSize: pl.signature.length,
        predictability: pl.predictability || 0,
        counteredSig,
        severity: sev,
      });
    }
  }
  return { penalty, findings, comfort };
}

// ---------- per-player human factor (optional) ----------
// assign: heroId -> roster player (has account_id). players = docs/data/players.json.
// Individual current form the TEAM base can't see: recent win rate, "prime" trend, and REAL
// win rate on the exact hero locked THIS game (not just signature membership). Returns a small
// A-perspective set of aggregates + per-player findings for the explanation.
function playerFormSide(assign, players, heroIds) {
  if (!assign || !players || !players.players) return null;
  const comfort = [], form = [], prime = [];
  const findings = [];
  for (const id of heroIds) {
    const pl = assign[id];
    if (!pl || !pl.account_id) continue;
    const pd = players.players[pl.account_id];
    if (!pd) continue;
    if (pd.recentN >= 5) { form.push(pd.recentWR - 0.5); prime.push(pd.trend || 0); }
    const h = pd.heroes && pd.heroes[id];
    let onHeroWR = null, games = 0;
    if (h) { games = h[0]; onHeroWR = shrunkWR(h[0], h[1]); comfort.push(onHeroWR - 0.5); }
    else { comfort.push(-0.04); } // no recorded games on this hero → mild discomfort
    findings.push({
      player: pl.name, heroId: id, games,
      onHeroWR, recentWR: pd.recentN >= 5 ? pd.recentWR : null,
      recentN: pd.recentN || 0, trend: pd.trend || 0, games30: pd.games30 || 0,
    });
  }
  if (!findings.length) return null;
  return { comfort: avg(comfort), form: avg(form), prime: avg(prime), findings };
}

// ---------- core scoring ----------
// radiant/dire: arrays of hero ids (team A / team B). ctx = { meta, knowledge, assignA, assignB }.
export function scoreDraft(radiant, dire, ctx) {
  const { meta, knowledge, assignA = null, assignB = null, stratz = null, matchups = null, players = null } = ctx;
  const A = radiant.filter(Boolean);
  const B = dire.filter(Boolean);

  const eMeta = teamMeta(meta, A, stratz) - teamMeta(meta, B, stratz);
  const eSyn = teamSynergy(meta, A) - teamSynergy(meta, B);
  const cAB = teamCounter(meta, matchups, A, B);
  const cBA = teamCounter(meta, matchups, B, A);
  const eCounter = cAB.edge - cBA.edge;

  const curvesA = teamCurves(meta, A);
  const curvesB = teamCurves(meta, B);
  const eEarly = curvesA.early - curvesB.early;
  const eLate = curvesA.late - curvesB.late;
  // Timing edge: whoever is stronger in more windows, lightly.
  const eTiming = (eEarly + (curvesA.mid - curvesB.mid) + eLate) / 3;

  const nwA = teamNW10(meta, A);
  const nwB = teamNW10(meta, B);
  const eLane = nwA != null && nwB != null ? clamp((nwA - nwB) / 6000, -0.4, 0.4) : 0;

  const dmgA = teamDamage(knowledge, meta, A);
  const dmgB = teamDamage(knowledge, meta, B);
  const eDmg = dmgB.imbalance - dmgA.imbalance; // A benefits if B is one-dimensional

  const archA = teamArchetype(knowledge, meta, A);
  const archB = teamArchetype(knowledge, meta, B);
  const eLock = clamp((archA.lock - archB.lock) / 12, -0.35, 0.35);

  const poolA = poolFindings(meta, assignA, A, B);
  const poolB = poolFindings(meta, assignB, B, A);
  const ePool = poolB.penalty - poolA.penalty;

  // Individual human factor (only when we have a player→hero assignment + players.json).
  const pfA = playerFormSide(assignA, players, A);
  const pfB = playerFormSide(assignB, players, B);
  const ePlayer = pfA && pfB
    ? clamp(0.7 * (pfA.comfort - pfB.comfort) + 0.4 * (pfA.form - pfB.form) + 0.7 * (pfA.prime - pfB.prime), -0.3, 0.3)
    : 0;

  // Current-patch standouts (STRATZ role-aware): flag drafted heroes that are notably
  // strong/weak THIS patch, so the read reflects live meta, not a year-old pro average.
  const patchPick = (ids) =>
    ids
      .map((id) => ({ id, s: stratzHeroWR(stratz, id) }))
      .filter((x) => x.s && x.s.games >= 300)
      .map((x) => ({ id: x.id, wr: x.s.wr, pos: x.s.pos, edge: x.s.wr - 0.5 }))
      .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
      .slice(0, 2)
      .filter((x) => Math.abs(x.edge) >= 0.03);
  const patchMeta = stratz ? { a: patchPick(A), b: patchPick(B) } : null;

  const rawEdge =
    W.meta * eMeta +
    W.synergy * eSyn +
    W.counter * eCounter +
    W.lane * eLane +
    W.timing * eTiming +
    W.dmg * eDmg +
    W.lock * eLock +
    W.pool * ePool +
    W.player * ePlayer;

  const extreme = cAB.hardCounters.length + cBA.hardCounters.length >= 3 || poolA.findings.length + poolB.findings.length >= 2;
  const cap = extreme ? EDGE_CAP_EXTREME : EDGE_CAP;
  const edge = clamp(rawEdge, -cap, cap);
  const probA = sigmoid(K_PROB * edge);

  // Data reliability: how much signal backed the score.
  const nHeroesKnown = [...A, ...B].filter((id) => meta.heroes[id] && meta.heroes[id].games >= 6).length;
  const reliability = clamp(nHeroesKnown / 10, 0.2, 1);

  return {
    probA,
    edge,
    rawEdge,
    reliability,
    components: {
      meta: W.meta * eMeta, synergy: W.synergy * eSyn, counter: W.counter * eCounter,
      lane: W.lane * eLane, timing: W.timing * eTiming, dmg: W.dmg * eDmg,
      lock: W.lock * eLock, pool: W.pool * ePool, player: W.player * ePlayer,
    },
    raw: { eMeta, eSyn, eCounter, eEarly, eLate, eLane, eDmg, eLock, ePool, ePlayer },
    playerForm: { a: pfA, b: pfB },
    curves: { a: curvesA, b: curvesB },
    nw: { a: nwA, b: nwB },
    dmg: { a: dmgA, b: dmgB },
    arch: { a: archA, b: archB },
    counters: { aVsB: cAB.hardCounters, bVsA: cBA.hardCounters },
    pool: { a: poolA, b: poolB },
    patchMeta,
  };
}

// Blend draft probability with an Elo/ML base rate (both A-perspective, per-game).
// Lesson from PVISION vs Yandex map 3 (EWC 2026): draftAlone correctly favored PVISION (~60%)
// but form base (~26%) drowned it to ~28% in the logit blend. When draft and base pick
// OPPOSITE sides and the draft edge is meaningful, give draft a real voice via a linear
// mix — otherwise keep the conservative logit blend (draft alone is weak out-of-sample).
export function blend(eloProbA, draftProbA) {
  const disagree = (eloProbA - 0.5) * (draftProbA - 0.5) < 0;
  const draftEdge = Math.abs(draftProbA - 0.5);
  if (disagree && draftEdge >= 0.08) {
    // Base still matters, but draft can flip the call when it's clearly opposite.
    const wDraft = clamp(0.55 + (draftEdge - 0.08) * 1.5, 0.55, 0.75);
    return clamp((1 - wDraft) * eloProbA + wDraft * draftProbA, 0.02, 0.98);
  }
  const finalLogit = logit(eloProbA) + BLEND * logit(draftProbA);
  return clamp(sigmoid(finalLogit), 0.02, 0.98);
}

// Stage 2 — early game (~10 min). Economy dominates: net worth / XP leads, towers,
// first blood. Shifts the pre-game prior toward the observed reality. Research shows
// accuracy climbs sharply once ~10-min economy is known.
//
// Lesson from PVISION vs Yandex (EWC 2026 map 1): an extreme pre-game prior (~80%) was
// still calling the favorite at +2.1k gold / 20′. When the live economy is clear, we
// therefore (1) shrink the prior toward 0.5 and (2) weight gold a bit harder so live
// state can actually overturn a form favorite — that's the whole point of the live layer.
export function applyEarlyGame(priorProbA, eg) {
  const nwK = (Number(eg.nwDiff) || 0) / 1000; // A minus B, gold
  const xpK = (Number(eg.xpDiff) || 0) / 1000; // A minus B, xp
  const tower = (Number(eg.towersA) || 0) - (Number(eg.towersB) || 0);
  const fb = eg.firstBlood === "a" ? 1 : eg.firstBlood === "b" ? -1 : 0;
  // Shrink stubborn pre-game priors as the gold gap grows (≈ gone by ~15k lead).
  const priorW = clamp(1 - Math.abs(nwK) / 15, 0.2, 1);
  const shrunkPrior = 0.5 + priorW * (priorProbA - 0.5);
  const econLogit = 0.48 * nwK + 0.22 * xpK + 0.35 * tower + 0.12 * fb;
  const probA = clamp(sigmoid(logit(shrunkPrior) + econLogit), 0.02, 0.98);
  return { probA, econLogit, magnitude: Math.abs(econLogit), priorW, shrunkPrior };
}

// Confidence 0..1 + label. Draft-stage is intentionally capped; early-game lifts the cap.
export function confidence(finalProbA, reliability, hasEarly = false, earlyMag = 0) {
  const decisiveness = Math.abs(finalProbA - 0.5) * 2; // 0..1
  const raw = clamp(0.35 * reliability + 0.65 * decisiveness, 0, 1);
  const cap = hasEarly ? Math.min(0.92, 0.68 + 0.12 * earlyMag) : 0.72;
  const capped = Math.min(raw, cap);
  const label = capped < 0.34 ? "низкая" : capped < 0.55 ? "средняя" : "высокая";
  return { value: capped, label };
}

// ---------- commentator-style explanation ----------
export function explain(score, nameA, nameB, heroName) {
  const b = [];
  const pct = (x) => (x * 100).toFixed(0) + "%";
  const favA = score.probA >= 0.5;
  const strongSide = favA ? nameA : nameB;
  const hn = heroName || ((id) => `Hero ${id}`);

  // 1) Timing / power curve — the headline the user cares about.
  const ca = score.curves.a, cb = score.curves.b;
  const aLate = ca.late, bLate = cb.late, aEarly = ca.early, bEarly = cb.early;
  if (Math.abs(aLate - bLate) >= 0.04 || Math.abs(aEarly - bEarly) >= 0.04) {
    const lateTeam = aLate >= bLate ? nameA : nameB;
    const earlyTeam = aEarly >= bEarly ? nameA : nameB;
    if (lateTeam !== earlyTeam) {
      b.push({
        icon: "⏱",
        text: `Гонка по таймингам: <b>${earlyTeam}</b> сильнее рано (${pct(Math.max(aEarly, bEarly))} в коротких), <b>${lateTeam}</b> — в лейте (${pct(Math.max(aLate, bLate))} в долгих). ${earlyTeam} обязаны ломать темп и закрывать, иначе лейт уплывает.`,
      });
    } else {
      b.push({ icon: "⏱", text: `<b>${lateTeam}</b> сильнее и рано, и в лейте по кривым винрейта — контроль темпа за ними.` });
    }
  }

  // 2) Hard counters. In teamCounter(mine, theirs) a hardCounter is {a: mine-hero, b: theirs-hero,
  //    wr: a's winrate vs b (LOW)} → a is countered BY b, so the beneficiary owns `b` (= the "theirs"
  //    side). For aVsB that's team B; for bVsA that's team A. (Fixes an earlier inverted attribution.)
  const hc = [
    ...score.counters.aVsB.map((c) => ({ ...c, by: nameB })),
    ...score.counters.bVsA.map((c) => ({ ...c, by: nameA })),
  ]
    .sort((x, y) => x.wr - y.wr)
    .slice(0, 3);
  for (const c of hc) {
    b.push({ icon: "🎯", text: `Контра: <b>${hn(c.b)}</b> контрит <b>${hn(c.a)}</b> (${hn(c.a)} берёт лишь ${pct(c.wr)} в матчапе, ${c.g} игр) — плюс для ${c.by}.` });
  }

  // (Pool-lock / signature-based human factor is rendered as its own dedicated block in the UI.)

  // 3b) Individual player form (real data): who's hot/cold right now and who's on a non-comfort hero.
  if (score.playerForm && score.playerForm.a && score.playerForm.b) {
    const notes = [];
    const scan = (pf, team) => {
      for (const f of pf.findings) {
        if (f.recentWR != null && f.recentWR >= 0.6 && f.trend >= 0.1)
          notes.push({ key: 100 * f.recentWR, icon: "🔥", text: `<b>${f.player}</b> (${team}) в форме: ${pct(f.recentWR)} за ${f.recentN} игр, тренд вверх.` });
        else if (f.recentWR != null && f.recentWR <= 0.4)
          notes.push({ key: -100 * (1 - f.recentWR), icon: "❄️", text: `<b>${f.player}</b> (${team}) холодный: ${pct(f.recentWR)} за ${f.recentN} игр.` });
        if (f.onHeroWR != null && f.games >= 20 && f.onHeroWR <= 0.45)
          notes.push({ key: -80, icon: "🎭", text: `<b>${f.player}</b> (${team}) на <b>${hn(f.heroId)}</b> слаб: ${pct(f.onHeroWR)} за ${f.games} игр.` });
        else if (f.games > 0 && f.games < 12)
          notes.push({ key: -60, icon: "🎭", text: `<b>${f.player}</b> (${team}) на <b>${hn(f.heroId)}</b> — редкий герой (${f.games} игр), вне зоны комфорта.` });
        else if (f.onHeroWR != null && f.games >= 30 && f.onHeroWR >= 0.58)
          notes.push({ key: 80 * f.onHeroWR, icon: "⭐", text: `<b>${f.player}</b> (${team}) на <b>${hn(f.heroId)}</b> силён: ${pct(f.onHeroWR)} за ${f.games} игр.` });
      }
    };
    scan(score.playerForm.a, nameA);
    scan(score.playerForm.b, nameB);
    notes.sort((x, y) => Math.abs(y.key) - Math.abs(x.key));
    for (const n of notes.slice(0, 4)) b.push({ icon: n.icon, text: n.text });
  }

  // 4) Damage balance.
  for (const side of [{ d: score.dmg.a, team: nameA }, { d: score.dmg.b, team: nameB }]) {
    if (side.d.imbalance > 0.05) {
      b.push({ icon: "💥", text: `У <b>${side.team}</b> ${pct(side.d.frac)} урона — ${side.d.dominant}. Одномерный дамаг легко резать одним типом защиты (BKB/броня/сопротивление).` });
    }
  }

  // 4b) Current-patch meta read (STRATZ high-MMR, role-aware, last ~2 months).
  if (score.patchMeta) {
    const posTxt = (p) => (p ? ` (поз. ${p})` : "");
    const fmtSide = (arr, team) =>
      arr
        .map((x) => `<b>${hn(x.id)}</b>${posTxt(x.pos)} ${x.edge >= 0 ? "силён" : "слаб"} в патче (${pct(x.wr)})`)
        .join(", ");
    const parts = [];
    if (score.patchMeta.a.length) parts.push(`${nameA}: ${fmtSide(score.patchMeta.a, nameA)}`);
    if (score.patchMeta.b.length) parts.push(`${nameB}: ${fmtSide(score.patchMeta.b, nameB)}`);
    if (parts.length) b.push({ icon: "📈", text: `Мета патча (Stratz, high-MMR по ролям): ${parts.join("; ")}.` });
  }

  // 5) Synergy / composition.
  const archA = score.arch.a, archB = score.arch.b;
  if (score.raw.eSyn >= 0.02 || score.raw.eSyn <= -0.02) {
    const synTeam = score.raw.eSyn > 0 ? nameA : nameB;
    b.push({ icon: "🧩", text: `Связки лучше собраны у <b>${synTeam}</b> (по винрейту пар в одной команде).` });
  }
  b.push({ icon: "⚔️", text: `Стиль: <b>${nameA}</b> — ${archA.label} (лок ${archA.lock}), <b>${nameB}</b> — ${archB.label} (лок ${archB.lock}).` });

  // 6) Lane economy.
  if (score.nw.a != null && score.nw.b != null && Math.abs(score.nw.a - score.nw.b) > 1500) {
    const laneTeam = score.nw.a > score.nw.b ? nameA : nameB;
    b.push({ icon: "🌱", text: `Ранняя экономика (сумма нетворса героев к 10-й мин) выше у <b>${laneTeam}</b> — им проще выиграть темп на линиях. Но линия ≠ игра: если состав соперника сильнее в файтах/лейте, преимущество надо конвертировать быстро.` });
  }

  return { bullets: b, strongSide, favA };
}

// Full analysis entrypoint used by the UI. teamsElo optional { a:{rating,games}, b:{...} }.
export function analyzeDraft(radiant, dire, ctx) {
  const score = scoreDraft(radiant, dire, ctx);
  let probA = score.probA;
  let eloProbA = null;
  if (ctx.baseProbA != null) {
    // Trained ML model supplied the pre-draft probability.
    eloProbA = ctx.baseProbA;
    probA = blend(eloProbA, score.probA);
  } else if (ctx.teamsElo && ctx.teamsElo.a && ctx.teamsElo.b) {
    eloProbA = eloExpected(ctx.teamsElo.a.rating, ctx.teamsElo.b.rating);
    probA = blend(eloProbA, score.probA);
  }
  const format = ctx.format || "bo1";

  const priorProbA = probA; // after Elo blend, before early game

  // Stage 2: fold in early-game state if provided.
  // Treat numeric 0 as a real signal (nwDiff=0 is a valid live reading); only skip empties.
  let early = null;
  const eg = ctx.earlyGame;
  const filled = (v) => v !== "" && v != null && v !== false;
  const hasEarly = !!(eg && (filled(eg.nwDiff) || filled(eg.xpDiff) || filled(eg.towersA) || filled(eg.towersB) || eg.firstBlood));
  if (hasEarly) {
    early = applyEarlyGame(probA, eg);
    probA = early.probA;
  }

  const conf = confidence(probA, score.reliability, !!hasEarly, early ? early.magnitude : 0);
  const exp = explain(score, ctx.nameA || "Команда A", ctx.nameB || "Команда B", ctx.heroName);
  return {
    score,
    eloProbA,
    draftProbA: score.probA,
    priorProbA,
    early,
    perGameA: probA,
    seriesA: seriesWinProb(probA, format),
    confidence: conf,
    explanation: exp,
  };
}
