// Post-match learning from CURRENT games (not only historical bulk rebuilds).
// For each match id: reconstruct what the model said, compare to the real winner,
// write a structured lesson (why we were wrong), update Elo/form + train.json.
//
// Run:
//   node src/learn_match.mjs 8902338515 8902431810 8902610619
//   npm run learn-match -- 8902610619
// Then: npm run train
//
// This is deliberate continuous learning: find failure modes, update team state,
// and (via lessons.json) drive small engine fixes — without one-match weight thrashing.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stratzQuery, sleep } from "./stratz.mjs";
import { analyzeDraft, scoreDraft } from "../docs/live_draft.mjs";
import { predictML } from "../docs/model_ml.mjs";
import { eloExpected, ELO_K } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "docs", "data");
const LESSONS = join(DATA, "lessons.json");

const ids = process.argv.slice(2).map(Number).filter(Boolean);
if (!ids.length) {
  console.error("Usage: node src/learn_match.mjs <matchId> [matchId...]");
  process.exit(1);
}

const J = async (p, fb) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fb; } };
const hn = (meta, id) => meta.heroes[id]?.name || `Hero ${id}`;

function failureModes(lesson) {
  const modes = [];
  const { pre, winnerSide, economy } = lesson;
  const favPre = pre.priorProbA >= 0.5 ? "radiant" : "dire";
  if (favPre !== winnerSide) {
    modes.push({
      code: "pregame_upset",
      detail: `Pre-game favored ${favPre} (${(Math.max(pre.priorProbA, 1 - pre.priorProbA) * 100).toFixed(0)}%), won ${winnerSide}.`,
    });
  }
  // Draft agreed with winner but base drowned it
  const draftFav = pre.draftProbA >= 0.5 ? "radiant" : "dire";
  const baseFav = pre.baseProbA >= 0.5 ? "radiant" : "dire";
  if (draftFav === winnerSide && baseFav !== winnerSide && Math.abs(pre.draftProbA - 0.5) >= 0.08) {
    modes.push({
      code: "draft_drowned_by_form",
      detail: `Draft alone ${(pre.draftProbA * 100).toFixed(0)}% radiant (correct side) but form base ${(pre.baseProbA * 100).toFixed(0)}% drowned blend to ${(pre.priorProbA * 100).toFixed(0)}%.`,
    });
  }
  if (baseFav !== winnerSide && draftFav !== winnerSide) {
    modes.push({
      code: "both_base_and_draft_wrong",
      detail: "Neither form nor draft picked the winner pre-game.",
    });
  }
  const at5 = economy["5"], at10 = economy["10"];
  if (at5 && ((at5.pA >= 0.5 ? "radiant" : "dire") !== winnerSide)) {
    modes.push({
      code: "early_lag_5min",
      detail: `@5′ still wrong side (nw ${at5.nwDiff >= 0 ? "+" : ""}${at5.nwDiff}, P(rad)=${(at5.pA * 100).toFixed(0)}%).`,
    });
  }
  if (at10 && ((at10.pA >= 0.5 ? "radiant" : "dire") === winnerSide) && favPre !== winnerSide) {
    modes.push({
      code: "live_economy_caught_upset",
      detail: `@10′ live economy correctly flipped to winner (nw ${at10.nwDiff >= 0 ? "+" : ""}${at10.nwDiff}).`,
    });
  }
  // Dominant wrong component among draft terms (sign vs outcome)
  const wonRad = winnerSide === "radiant" ? 1 : 0;
  const comps = Object.entries(pre.components || {});
  const wrong = comps
    .filter(([, v]) => (v > 0.02 && wonRad === 0) || (v < -0.02 && wonRad === 1))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (wrong.length) {
    modes.push({
      code: "misleading_draft_components",
      detail: `Draft terms that pointed the wrong way: ${wrong.slice(0, 3).map(([k, v]) => `${k}:${v >= 0 ? "+" : ""}${v.toFixed(2)}`).join(", ")}.`,
    });
  }
  return modes;
}

async function fetchMatch(mid) {
  const d = await stratzQuery(`{ match(id: ${mid}) {
    id didRadiantWin durationSeconds startDateTime
    radiantTeamId direTeamId
    radiantTeam { name } direTeam { name }
    players { heroId isRadiant steamAccountId steamAccount { name } }
    radiantNetworthLeads radiantExperienceLeads
  }}`);
  return d?.match || null;
}

async function main() {
  const meta = await J(join(DATA, "meta.json"), { heroes: {} });
  const stratzMeta = await J(join(DATA, "stratz.json"), null);
  const matchups = await J(join(DATA, "matchups.json"), null);
  const knowledge = await J(join(DATA, "hero_knowledge.json"), { heroes: {} });
  const players = await J(join(DATA, "players.json"), null);
  const model = await J(join(DATA, "model.json"), null);
  const dataset = await J(join(DATA, "dataset.json"), { teams: [], recentMatches: [] });
  const train = await J(join(ROOT, "train.json"), { rows: [], count: 0 });
  const lessonsDoc = await J(LESSONS, { generatedAt: null, lessons: [] });
  const byId = new Map(dataset.teams.map((t) => [String(t.id), t]));
  const haveRecent = new Set((dataset.recentMatches || []).map((m) => m.match_id));
  const haveLesson = new Set((lessonsDoc.lessons || []).map((l) => l.matchId));

  const newLessons = [];
  for (const mid of ids) {
    console.log(`\n——— Learning from match ${mid} ———`);
    const m = await fetchMatch(mid);
    if (!m) { console.warn("  Stratz: нет матча"); continue; }
    const nameR = m.radiantTeam?.name || byId.get(String(m.radiantTeamId))?.name || "Radiant";
    const nameD = m.direTeam?.name || byId.get(String(m.direTeamId))?.name || "Dire";
    const A = (m.players || []).filter((p) => p.isRadiant).map((p) => p.heroId).filter(Boolean);
    const B = (m.players || []).filter((p) => !p.isRadiant).map((p) => p.heroId).filter(Boolean);
    const tA = byId.get(String(m.radiantTeamId));
    const tB = byId.get(String(m.direTeamId));
    if (!tA || !tB || !tA.ml || !tB.ml || !model) {
      console.warn("  Нет ML-снимков команд — урок запишу, Elo/train пропущу.");
    }
    const base = (model && tA?.ml && tB?.ml) ? predictML(model, tA.ml, tB.ml) : null;
    const score = scoreDraft(A, B, { meta, stratz: stratzMeta, matchups, knowledge, players });
    const pre = analyzeDraft(A, B, {
      meta, stratz: stratzMeta, matchups, knowledge, players, baseProbA: base,
      teamsElo: tA && tB ? { a: { rating: tA.rating, games: tA.games }, b: { rating: tB.rating, games: tB.games } } : null,
      nameA: nameR, nameB: nameD, format: "bo1", heroName: (id) => hn(meta, id),
    });
    const leads = m.radiantNetworthLeads || [];
    const xp = m.radiantExperienceLeads || [];
    const economy = {};
    for (const min of [5, 10, 15, 20, 25]) {
      if (leads[min] == null) continue;
      const live = analyzeDraft(A, B, {
        meta, stratz: stratzMeta, matchups, knowledge, players, baseProbA: base,
        teamsElo: tA && tB ? { a: { rating: tA.rating, games: tA.games }, b: { rating: tB.rating, games: tB.games } } : null,
        earlyGame: { nwDiff: leads[min], xpDiff: xp[min] ?? "", towersA: "", towersB: "", firstBlood: "" },
        nameA: nameR, nameB: nameD, format: "bo1",
      });
      economy[String(min)] = { nwDiff: leads[min], xpDiff: xp[min] ?? null, pA: Number(live.perGameA.toFixed(4)) };
    }
    const winnerSide = m.didRadiantWin ? "radiant" : "dire";
    const winnerName = m.didRadiantWin ? nameR : nameD;
    const lesson = {
      matchId: mid,
      learnedAt: new Date().toISOString(),
      seriesHint: null,
      radiant: nameR, dire: nameD,
      radiantTeamId: m.radiantTeamId, direTeamId: m.direTeamId,
      winnerSide, winnerName,
      durationMin: Number((m.durationSeconds / 60).toFixed(1)),
      heroes: { radiant: A.map((id) => hn(meta, id)), dire: B.map((id) => hn(meta, id)) },
      pre: {
        baseProbA: Number((base ?? pre.eloProbA ?? 0.5).toFixed(4)),
        draftProbA: Number(pre.draftProbA.toFixed(4)),
        priorProbA: Number(pre.priorProbA.toFixed(4)),
        components: Object.fromEntries(Object.entries(score.components).map(([k, v]) => [k, Number(v.toFixed(4))])),
      },
      economy,
      failureModes: [],
    };
    lesson.failureModes = failureModes(lesson);
    console.log(`  ${nameR} vs ${nameD} → won ${winnerName} (${lesson.durationMin}′)`);
    console.log(`  pre: base ${(lesson.pre.baseProbA * 100).toFixed(0)}% → +draft ${(lesson.pre.priorProbA * 100).toFixed(0)}% ${nameR} (draftAlone ${(lesson.pre.draftProbA * 100).toFixed(0)}%)`);
    for (const fm of lesson.failureModes) console.log(`  ✗ ${fm.code}: ${fm.detail}`);
    if (!lesson.failureModes.length) console.log("  ✓ pre-game side correct (or no clear failure mode)");

    // Elo / train update (skip if already in recentMatches)
    if (tA && tB && tA.ml && tB.ml && !haveRecent.has(mid)) {
      const snapA = { ...tA.ml };
      const snapB = { ...tB.ml };
      train.rows.push({ t: m.startDateTime || Math.floor(Date.now() / 1000), a: snapA, b: snapB, y: m.didRadiantWin ? 1 : 0 });
      const exp = eloExpected(snapA.elo, snapB.elo);
      const y = m.didRadiantWin ? 1 : 0;
      tA.ml.elo = Math.round(snapA.elo + ELO_K * (y - exp));
      tB.ml.elo = Math.round(snapB.elo + ELO_K * ((1 - y) - (1 - exp)));
      const a = 0.1;
      tA.ml.form10 = Number((snapA.form10 * (1 - a) + y * a).toFixed(3));
      tB.ml.form10 = Number((snapB.form10 * (1 - a) + (1 - y) * a).toFixed(3));
      tA.ml.form45 = Number((snapA.form45 * (1 - a) + y * a).toFixed(3));
      tB.ml.form45 = Number((snapB.form45 * (1 - a) + (1 - y) * a).toFixed(3));
      tA.ml.act = (snapA.act || 0) + 1;
      tB.ml.act = (snapB.act || 0) + 1;
      tA.rating = tA.ml.elo;
      tB.rating = tB.ml.elo;
      tA.games = (tA.games || 0) + 1;
      tB.games = (tB.games || 0) + 1;
      tA.lastPlayed = tB.lastPlayed = m.startDateTime || Math.floor(Date.now() / 1000);
      dataset.recentMatches = dataset.recentMatches || [];
      dataset.recentMatches.unshift({
        match_id: mid,
        start_time: m.startDateTime || tA.lastPlayed,
        league: "learned",
        radiant: { id: m.radiantTeamId, name: nameR },
        dire: { id: m.direTeamId, name: nameD },
        radiant_win: !!m.didRadiantWin,
      });
      if (dataset.recentMatches.length > 60) dataset.recentMatches.length = 60;
      haveRecent.add(mid);
      console.log(`  → Elo/form updated: ${nameR} ${tA.rating} / ${nameD} ${tB.rating}`);
    } else if (haveRecent.has(mid)) {
      console.log("  → Elo уже обновлялся ранее, не дублирую");
    }

    if (!haveLesson.has(mid)) {
      newLessons.push(lesson);
      haveLesson.add(mid);
    } else {
      // refresh lesson text in place
      const i = lessonsDoc.lessons.findIndex((l) => l.matchId === mid);
      if (i >= 0) lessonsDoc.lessons[i] = lesson;
      else newLessons.push(lesson);
      console.log("  → урок обновлён");
    }
    await sleep(350);
  }

  lessonsDoc.lessons = [...newLessons, ...(lessonsDoc.lessons || []).filter((l) => !newLessons.some((n) => n.matchId === l.matchId))];
  lessonsDoc.generatedAt = new Date().toISOString();
  lessonsDoc.count = lessonsDoc.lessons.length;

  // Aggregate takeaways across new lessons
  const codes = {};
  for (const l of newLessons) for (const fm of l.failureModes) codes[fm.code] = (codes[fm.code] || 0) + 1;
  lessonsDoc.lastRun = { at: lessonsDoc.generatedAt, matchIds: ids, failureCounts: codes };

  dataset.teams.sort((a, b) => b.rating - a.rating);
  dataset.generatedAt = new Date().toISOString();
  train.count = train.rows.length;
  train.generatedAt = dataset.generatedAt;

  await mkdir(DATA, { recursive: true });
  await writeFile(LESSONS, JSON.stringify(lessonsDoc, null, 2), "utf8");
  await writeFile(join(DATA, "dataset.json"), JSON.stringify(dataset, null, 2), "utf8");
  await writeFile(join(ROOT, "train.json"), JSON.stringify(train), "utf8");

  console.log(`\nГотово. Уроков всего: ${lessonsDoc.count}. Новых в этом забеге: ${newLessons.length}.`);
  console.log("failure modes:", JSON.stringify(codes));
  console.log("Дальше: npm run train  (+ при необходимости npm run build-players с PLAYERS_TEAM_IDS)");
  if (codes.draft_drowned_by_form) {
    console.log("Сигнал движку: draft_drowned_by_form — blend() уже усиливает драфт при жёстком споре с формой.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
