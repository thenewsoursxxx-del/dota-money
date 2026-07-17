// Data pipeline: pull Tier-1 (premium) pro matches from OpenDota,
// build Elo ratings, and write everything to data/dataset.json.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLeagues, getTeams, getProMatches } from "./opendota.mjs";
import { buildElo, eloExpected } from "../docs/model.mjs";

// ---- ML features: time-decayed Elo + recent form, to fight stale/roster-change bias ----
const DECAY_TAU_DAYS = 120; // rating regresses to mean with this time-constant on inactivity
const ML_K = 32;
const WARMUP = 5;           // min prior games per team before a match becomes a training row
const DAY = 86400;

// Regress a rating toward 1500 based on days idle (recent meta/roster matters more).
function regressElo(rating, lastPlayed, atTime) {
  if (!lastPlayed) return rating;
  const gapDays = Math.max(0, (atTime - lastPlayed) / DAY);
  return 1500 + (rating - 1500) * Math.exp(-gapDays / DECAY_TAU_DAYS);
}

// Shrunk win rate + recent-window stats from a team's prior games (all games are < atTime).
function formWindows(games, lastPlayed, atTime) {
  const last10 = games.slice(-10);
  const w10 = last10.reduce((a, g) => a + (g.won ? 1 : 0), 0);
  const form10 = (w10 + 2.5) / (last10.length + 5); // shrink toward 0.5

  const cutoff = atTime - 45 * DAY;
  const recent = games.filter((g) => g.t >= cutoff);
  const w45 = recent.reduce((a, g) => a + (g.won ? 1 : 0), 0);
  const form45 = (w45 + 2.5) / (recent.length + 5);

  const rust = lastPlayed ? Math.min((atTime - lastPlayed) / DAY, 60) : 21;
  return { form10, form45, act: recent.length, rust };
}

// Chronological walk: emit training rows (snapshot pre-match state + outcome) and a
// final "as of now" snapshot per team for client-side serving.
function computeMLData(tier1, nowSec) {
  const st = new Map(); // id -> { elo, lastPlayed, games:[{t,won}] }
  const ensure = (id) => {
    if (!st.has(id)) st.set(id, { elo: 1500, lastPlayed: 0, games: [] });
    return st.get(id);
  };
  const snap = (s, atTime) => ({
    elo: regressElo(s.elo, s.lastPlayed, atTime),
    ...formWindows(s.games, s.lastPlayed, atTime),
  });

  const rows = [];
  const sorted = [...tier1].sort((a, b) => a.start_time - b.start_time);
  for (const m of sorted) {
    const A = ensure(m.radiant_team_id);
    const B = ensure(m.dire_team_id);
    const t = m.start_time;
    const sa = snap(A, t), sb = snap(B, t);
    const y = m.radiant_win ? 1 : 0;
    if (A.games.length >= WARMUP && B.games.length >= WARMUP) {
      rows.push({ t, a: sa, b: sb, y });
    }
    // Commit decay, then Elo update.
    const eA = regressElo(A.elo, A.lastPlayed, t);
    const eB = regressElo(B.elo, B.lastPlayed, t);
    const exp = eloExpected(eA, eB);
    A.elo = eA + ML_K * (y - exp);
    B.elo = eB + ML_K * ((1 - y) - (1 - exp));
    A.lastPlayed = B.lastPlayed = t;
    A.games.push({ t, won: y === 1 });
    B.games.push({ t, won: y === 0 });
  }

  const snapById = new Map();
  for (const [id, s] of st) snapById.set(id, snap(s, nowSec));
  return { rows, snapById };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "docs", "data");

const PAGES = Number(process.env.PAGES || 40); // 40 * 100 = up to 4000 recent pro matches

// Per-team timing profile from Tier-1 game durations: early / mid / late strength + tempo.
function computeTiming(tier1) {
  const acc = new Map(); // id -> { games, durSum, winDurSum, winDurN, lossDurSum, lossDurN, buckets }
  const ensure = (id) => {
    if (!acc.has(id)) {
      acc.set(id, {
        games: 0, durSum: 0, winDurSum: 0, winDurN: 0, lossDurSum: 0, lossDurN: 0,
        short: { g: 0, w: 0 }, mid: { g: 0, w: 0 }, long: { g: 0, w: 0 },
      });
    }
    return acc.get(id);
  };
  const add = (id, dur, won) => {
    if (!dur || dur < 600) return; // ignore broken/very short entries
    const t = ensure(id);
    t.games++; t.durSum += dur;
    if (won) { t.winDurSum += dur; t.winDurN++; } else { t.lossDurSum += dur; t.lossDurN++; }
    const bucket = dur < 1800 ? t.short : dur <= 2400 ? t.mid : t.long;
    bucket.g++; if (won) bucket.w++;
  };
  for (const m of tier1) {
    add(m.radiant_team_id, m.duration, m.radiant_win === true);
    add(m.dire_team_id, m.duration, m.radiant_win === false);
  }
  const wr = (b) => (b.g >= 3 ? b.w / b.g : null);
  const out = new Map();
  for (const [id, t] of acc) {
    if (t.games < 5) continue;
    const avgWin = t.winDurN ? t.winDurSum / t.winDurN : null;
    const avgLoss = t.lossDurN ? t.lossDurSum / t.lossDurN : null;
    out.set(id, {
      games: t.games,
      avgMin: Math.round(t.durSum / t.games / 60),
      avgWinMin: avgWin ? Math.round(avgWin / 60) : null,
      avgLossMin: avgLoss ? Math.round(avgLoss / 60) : null,
      short: { g: t.short.g, wr: wr(t.short) },
      mid: { g: t.mid.g, wr: wr(t.mid) },
      long: { g: t.long.g, wr: wr(t.long) },
      // Closes games fast when their wins are shorter than their losses.
      closesFast: avgWin != null && avgLoss != null ? avgWin < avgLoss : null,
    });
  }
  return out;
}

async function main() {
  console.log("1/4 Загружаю лиги (ищу Tier-1: premium + professional)...");
  const leagues = await getLeagues();
  // OpenDota tags most flagship events (TI, majors, EWC) as "professional";
  // "premium" is a smaller legacy set. Tier-1 scene = premium + professional.
  const TIER1_TIERS = new Set(["premium", "professional"]);
  const premiumIds = new Set(
    leagues.filter((l) => TIER1_TIERS.has(l.tier)).map((l) => l.leagueid)
  );
  const leagueName = new Map(leagues.map((l) => [l.leagueid, (l.name || "").trim()]));
  console.log(`   Tier-1 лиг: ${premiumIds.size}`);

  console.log(`2/4 Загружаю историю про-матчей (${PAGES} страниц)...`);
  const raw = await getProMatches({ pages: PAGES });
  console.log(`   Всего про-матчей получено: ${raw.length}`);

  // Keep only Tier-1 games with both teams identified.
  const tier1 = raw.filter(
    (m) =>
      premiumIds.has(m.leagueid) &&
      m.radiant_team_id &&
      m.dire_team_id &&
      m.radiant_name &&
      m.dire_name &&
      typeof m.radiant_win === "boolean"
  );
  console.log(`   Из них Tier-1 матчей: ${tier1.length}`);

  console.log("3/4 Загружаю мета-инфо команд (лого/тег)...");
  let teamMeta = new Map();
  try {
    const teams = await getTeams();
    teamMeta = new Map(
      teams.map((t) => [t.team_id, { name: t.name, tag: t.tag, logo: t.logo_url, odRating: t.rating }])
    );
  } catch (e) {
    console.log("   (не удалось получить /teams, продолжаю без лого)");
  }

  console.log("4/4 Считаю Elo-рейтинги, тайминг и ML-фичи (decay + форма)...");
  const eloMap = buildElo(tier1);
  const timingMap = computeTiming(tier1);
  const nowSec = Math.floor(Date.now() / 1000);
  const { rows, snapById } = computeMLData(tier1, nowSec);

  const round3 = (x) => Number(x.toFixed(3));
  const teamsOut = [...eloMap.values()]
    .map((t) => {
      const meta = teamMeta.get(t.id) || {};
      const s = snapById.get(t.id);
      return {
        id: t.id,
        name: (meta.name || t.name || "").trim(),
        tag: meta.tag || null,
        logo: meta.logo || null,
        rating: Math.round(t.rating),
        games: t.games,
        wins: t.wins,
        losses: t.losses,
        lastPlayed: t.lastPlayed,
        timing: timingMap.get(t.id) || null,
        // ML serving snapshot ("as of now"): decayed Elo + recent form.
        ml: s
          ? { elo: Math.round(s.elo), form10: round3(s.form10), form45: round3(s.form45), act: s.act, rust: Math.round(s.rust) }
          : null,
      };
    })
    .sort((a, b) => b.rating - a.rating);

  // Recent Tier-1 results for the "history" feed.
  const recent = tier1
    .slice()
    .sort((a, b) => b.start_time - a.start_time)
    .slice(0, 60)
    .map((m) => ({
      match_id: m.match_id,
      start_time: m.start_time,
      league: leagueName.get(m.leagueid) || m.league_name,
      radiant: { id: m.radiant_team_id, name: m.radiant_name },
      dire: { id: m.dire_team_id, name: m.dire_name },
      radiant_win: m.radiant_win,
    }));

  const dataset = {
    generatedAt: new Date().toISOString(),
    tier1LeagueCount: premiumIds.size,
    matchesUsed: tier1.length,
    teams: teamsOut,
    recentMatches: recent,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "dataset.json"), JSON.stringify(dataset, null, 2), "utf8");

  // Training rows (not served to the client) → consumed by src/train_model.mjs.
  const train = { generatedAt: dataset.generatedAt, nowSec, count: rows.length, rows };
  await writeFile(join(ROOT, "train.json"), JSON.stringify(train), "utf8");
  console.log(`\nГотово. Команд: ${teamsOut.length}, матчей в основе рейтинга: ${tier1.length}`);
  console.log(`Обучающих строк (train.json): ${rows.length}`);
  console.log("Топ-10 Tier-1 команд по Elo:");
  teamsOut.slice(0, 10).forEach((t, i) => console.log(`  ${i + 1}. ${t.name} — ${t.rating} (${t.games} игр)`));
}

main().catch((e) => {
  console.error("Ошибка сборки данных:", e);
  process.exit(1);
});
