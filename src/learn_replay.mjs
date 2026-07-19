// Learn from MATCH RECORDINGS (Stratz parse — fights, tip, lanes, objectives),
// not only from aggregate Elo/form stats.
//
// Correctness contract:
//   1) Parse is post-match only → never used as a feature for THAT match's pre-game row.
//   2) Elo/train.json updates stay in learn_match.mjs (one place, no double-count).
//   3) hero_evidence.json accumulates fight/stomp credits across many matches;
//      optional soft tf nudge only with LEARN_REPLAY_APPLY=1 and n≥MIN_EVIDENCE.
//   4) replay_corpus.json is chronological ground truth for future calibration models.
//
// Run:
//   node src/learn_replay.mjs 8904322271 8904419709
//   npm run learn-replay -- 8904322271
//   LEARN_REPLAY_APPLY=1 npm run learn-replay -- ...   # also nudge hero_knowledge tf
//
// Prefer: npm run learn-match -- <ids>   (calls replay enrich automatically)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./stratz.mjs";
import { fetchReplayMatch, analyzeReplay } from "./replay_parse.mjs";
import { scoreDraft, analyzeDraft } from "../docs/live_draft.mjs";
import { predictML } from "../docs/model_ml.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "docs", "data");
const CORPUS = join(DATA, "replay_corpus.json");
const EVIDENCE = join(DATA, "hero_evidence.json");
const KNOWLEDGE = join(DATA, "hero_knowledge.json");
const LESSONS = join(DATA, "lessons.json");

const APPLY = process.env.LEARN_REPLAY_APPLY === "1" || process.env.LEARN_REPLAY_APPLY === "true";
const MIN_EVIDENCE = Number(process.env.MIN_EVIDENCE || 8);

const ids = process.argv.slice(2).map(Number).filter(Boolean);
const asModule = process.argv[1] && process.argv[1].includes("learn_replay");

const J = async (p, fb) => {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { return fb; }
};

function emptyEvidence() {
  return { generatedAt: null, heroes: {}, note: "Accumulated from replay parses. fightWins = participated in a won fight cluster on the eventual winning team." };
}

/** Update per-hero evidence from one analyzed replay (winner-side credits only). */
export function accumulateEvidence(evDoc, replay, meta) {
  const hn = (id) => meta?.heroes?.[id]?.name || `Hero ${id}`;
  const heroes = evDoc.heroes || (evDoc.heroes = {});
  const winnerBoard = replay.winnerSide === "radiant" ? replay.board.radiant : replay.board.dire;
  const loserBoard = replay.winnerSide === "radiant" ? replay.board.dire : replay.board.radiant;
  const credit = replay.fightCredit || {};

  for (const p of winnerBoard) {
    const key = String(p.heroId);
    const h = heroes[key] || (heroes[key] = {
      name: hn(p.heroId),
      games: 0, wins: 0,
      fightWins: 0, fightAppearances: 0,
      stompWins: 0, topNwWins: 0,
      damageSum: 0, nwSum: 0,
    });
    h.name = hn(p.heroId);
    h.games++;
    h.wins++;
    h.damageSum += p.hd || 0;
    h.nwSum += p.nw || 0;
    if (credit[p.heroId]) {
      h.fightWins += credit[p.heroId];
      h.fightAppearances += credit[p.heroId];
    }
    if (replay.mismatches?.some((m) => m.code === "early_stomp")) h.stompWins++;
    if (replay.board.topWinner?.heroId === p.heroId) h.topNwWins++;
  }
  for (const p of loserBoard) {
    const key = String(p.heroId);
    const h = heroes[key] || (heroes[key] = {
      name: hn(p.heroId),
      games: 0, wins: 0,
      fightWins: 0, fightAppearances: 0,
      stompWins: 0, topNwWins: 0,
      damageSum: 0, nwSum: 0,
    });
    h.name = hn(p.heroId);
    h.games++;
    h.damageSum += p.hd || 0;
    h.nwSum += p.nw || 0;
  }
  evDoc.generatedAt = new Date().toISOString();
  return evDoc;
}

/**
 * Soft-apply evidence → hero_knowledge tf nudges.
 * Only heroes with enough games AND fight win participation rate clearly high/low.
 * Caps: ±1 tf per apply run, never outside 0..3.
 */
export function applyEvidenceToKnowledge(knowledge, evDoc) {
  const changes = [];
  const heroes = knowledge.heroes || {};
  for (const [id, e] of Object.entries(evDoc.heroes || {})) {
    if ((e.games || 0) < MIN_EVIDENCE) continue;
    const name = e.name;
    if (!name || !heroes[name]) continue;
    const k = heroes[name];
    const fightRate = e.fightAppearances ? e.fightWins / Math.max(1, e.games) : 0;
    // High fight participation on winning teams but low curated tf → bump
    if (fightRate >= 0.9 && (e.fightWins || 0) >= 6 && (k.tf ?? 0) <= 1) {
      const next = Math.min(3, (k.tf ?? 0) + 1);
      if (next !== k.tf) {
        changes.push({ hero: name, field: "tf", from: k.tf, to: next, reason: `fightWins ${e.fightWins}/${e.games}` });
        k.tf = next;
      }
    }
    // Often top NW on wins with mid/late scale → ensure scale mid at least
    if ((e.topNwWins || 0) >= 5 && e.wins >= MIN_EVIDENCE && k.scale === "early") {
      changes.push({ hero: name, field: "scale", from: k.scale, to: "mid", reason: `topNwWins ${e.topNwWins}` });
      k.scale = "mid";
    }
  }
  return changes;
}

export async function learnReplayOne(matchId, ctx = {}) {
  const meta = ctx.meta || await J(join(DATA, "meta.json"), { heroes: {} });
  const stratz = ctx.stratz ?? await J(join(DATA, "stratz.json"), null);
  const matchups = ctx.matchups ?? await J(join(DATA, "matchups.json"), null);
  const knowledge = ctx.knowledge || await J(KNOWLEDGE, { heroes: {} });
  const players = ctx.players ?? await J(join(DATA, "players.json"), null);
  const model = ctx.model ?? await J(join(DATA, "model.json"), null);
  const dataset = ctx.dataset || await J(join(DATA, "dataset.json"), { teams: [] });
  const byId = new Map((dataset.teams || []).map((t) => [String(t.id), t]));

  const m = await fetchReplayMatch(matchId);
  if (!m) return { ok: false, matchId, error: "match_not_found" };

  const A = (m.players || []).filter((p) => p.isRadiant).map((p) => p.heroId).filter(Boolean);
  const B = (m.players || []).filter((p) => !p.isRadiant).map((p) => p.heroId).filter(Boolean);
  const tA = byId.get(String(m.radiantTeamId));
  const tB = byId.get(String(m.direTeamId));
  const base = model && tA?.ml && tB?.ml ? predictML(model, tA.ml, tB.ml) : null;
  const score = scoreDraft(A, B, { meta, stratz, matchups, knowledge, players });
  const pre = analyzeDraft(A, B, {
    meta, stratz, matchups, knowledge, players, baseProbA: base,
    nameA: m.radiantTeam?.name || "Radiant",
    nameB: m.direTeam?.name || "Dire",
    format: "bo1",
  });

  const replay = analyzeReplay(m, meta, {
    components: score.components,
    draftProbA: score.probA,
    arch: score.arch,
  });

  return {
    ok: true,
    matchId,
    radiant: m.radiantTeam?.name,
    dire: m.direTeam?.name,
    winnerSide: replay.winnerSide,
    pre: {
      baseProbA: base,
      draftProbA: pre.draftProbA,
      priorProbA: pre.priorProbA,
      components: score.components,
      arch: score.arch,
    },
    replay,
  };
}

/** Enrich an existing learn_match lesson object with replay block + merged failure modes. */
export function attachReplayToLesson(lesson, learned) {
  if (!lesson || !learned?.ok) return lesson;
  lesson.replay = {
    tip: learned.replay.tip,
    fights: {
      n: learned.replay.fights.n,
      radiantWins: learned.replay.fights.radiantWins,
      direWins: learned.replay.fights.direWins,
      fightWinnerSide: learned.replay.fights.fightWinnerSide,
    },
    lanes: learned.replay.lanes,
    objectives: {
      byMinute: learned.replay.objectives.byMinute,
      winnerObjectivesAt20: learned.replay.objectives.winnerObjectivesAt20,
    },
    topWinner: learned.replay.board.topWinner
      ? { hero: learned.replay.board.topWinner.hero, nw: learned.replay.board.topWinner.nw, kda: `${learned.replay.board.topWinner.k}/${learned.replay.board.topWinner.d}/${learned.replay.board.topWinner.a}` }
      : null,
    mismatches: learned.replay.mismatches,
  };
  const have = new Set((lesson.failureModes || []).map((f) => f.code));
  for (const m of learned.replay.mismatches || []) {
    if (!have.has(m.code)) {
      lesson.failureModes = lesson.failureModes || [];
      lesson.failureModes.push(m);
      have.add(m.code);
    }
  }
  lesson.replayLearnedAt = new Date().toISOString();
  return lesson;
}

async function persistCorpus(entry) {
  const doc = await J(CORPUS, { generatedAt: null, matches: [] });
  const idx = doc.matches.findIndex((x) => x.matchId === entry.matchId);
  const row = {
    matchId: entry.matchId,
    learnedAt: new Date().toISOString(),
    radiant: entry.radiant,
    dire: entry.dire,
    winnerSide: entry.winnerSide,
    pre: entry.pre && {
      baseProbA: entry.pre.baseProbA,
      draftProbA: entry.pre.draftProbA,
      priorProbA: entry.pre.priorProbA,
      components: entry.pre.components,
    },
    replay: {
      tip: entry.replay.tip,
      fights: entry.replay.fights,
      lanes: entry.replay.lanes,
      objectives: entry.replay.objectives,
      mismatches: entry.replay.mismatches,
      topWinner: entry.replay.board.topWinner,
      fightCredit: entry.replay.fightCredit,
    },
  };
  if (idx >= 0) doc.matches[idx] = row;
  else doc.matches.push(row);
  doc.matches.sort((a, b) => (a.matchId || 0) - (b.matchId || 0));
  doc.generatedAt = new Date().toISOString();
  doc.count = doc.matches.length;
  await mkdir(DATA, { recursive: true });
  await writeFile(CORPUS, JSON.stringify(doc, null, 2), "utf8");
}

async function mainCli() {
  if (!ids.length) {
    console.error("Usage: node src/learn_replay.mjs <matchId> [matchId...]");
    process.exit(1);
  }
  const meta = await J(join(DATA, "meta.json"), { heroes: {} });
  let evDoc = await J(EVIDENCE, emptyEvidence());
  const lessonsDoc = await J(LESSONS, { lessons: [] });
  let knowledge = await J(KNOWLEDGE, { heroes: {} });

  for (const mid of ids) {
    console.log(`\n——— Replay-learn ${mid} ———`);
    const learned = await learnReplayOne(mid, { meta, knowledge });
    if (!learned.ok) {
      console.warn("  fail:", learned.error);
      continue;
    }
    const r = learned.replay;
    console.log(`  ${learned.radiant} vs ${learned.dire} → ${r.winnerSide}`);
    console.log(`  tip: ${r.tip ? `@${r.tip.minute}′ nw ${r.tip.nwDiff}` : "none"}`);
    console.log(`  fights: ${r.fights.radiantWins}:${r.fights.direWins} (n=${r.fights.n}) → ${r.fights.fightWinnerSide}`);
    console.log(`  lanes: T/M/B ${r.lanes.top}/${r.lanes.mid}/${r.lanes.bot}`);
    if (r.board.topWinner) {
      console.log(`  top NW winner: ${r.board.topWinner.hero} ${r.board.topWinner.nw} (${r.board.topWinner.k}/${r.board.topWinner.d}/${r.board.topWinner.a})`);
    }
    for (const m of r.mismatches) console.log(`  ✗ ${m.code}: ${m.detail}`);

    accumulateEvidence(evDoc, r, meta);
    await persistCorpus(learned);

    const li = lessonsDoc.lessons.findIndex((l) => l.matchId === mid);
    if (li >= 0) {
      attachReplayToLesson(lessonsDoc.lessons[li], learned);
      console.log("  → lesson enriched with replay");
    } else {
      console.log("  → нет lessons.json записи (сначала npm run learn-match); corpus/evidence всё равно сохранены");
    }
    await sleep(350);
  }

  await writeFile(EVIDENCE, JSON.stringify(evDoc, null, 2), "utf8");
  lessonsDoc.generatedAt = new Date().toISOString();
  await writeFile(LESSONS, JSON.stringify(lessonsDoc, null, 2), "utf8");

  if (APPLY) {
    const changes = applyEvidenceToKnowledge(knowledge, evDoc);
    if (changes.length) {
      knowledge.generatedAt = new Date().toISOString();
      await writeFile(KNOWLEDGE, JSON.stringify(knowledge, null, 2), "utf8");
      console.log("\nApplied knowledge nudges (LEARN_REPLAY_APPLY=1):");
      for (const c of changes) console.log(`  ${c.hero}.${c.field}: ${c.from} → ${c.to} (${c.reason})`);
    } else {
      console.log("\nLEARN_REPLAY_APPLY=1, но недостаточно evidence для nudges (нужно n≥" + MIN_EVIDENCE + ").");
    }
  } else {
    console.log("\nEvidence накоплен. Авто-nudges knowledge выключены (LEARN_REPLAY_APPLY=1 чтобы включить).");
  }
  console.log(`Corpus: ${CORPUS}`);
  console.log(`Evidence: ${EVIDENCE}`);
}

// Export for learn_match integration
export { DATA, EVIDENCE, CORPUS };

if (asModule && ids.length) {
  mainCli().catch((e) => { console.error(e); process.exit(1); });
}
