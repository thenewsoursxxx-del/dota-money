// Data pipeline: pull Tier-1 (premium) pro matches from OpenDota,
// build Elo ratings, and write everything to data/dataset.json.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLeagues, getTeams, getProMatches } from "./opendota.mjs";
import { buildElo } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "docs", "data");

const PAGES = Number(process.env.PAGES || 40); // 40 * 100 = up to 4000 recent pro matches

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

  console.log("4/4 Считаю Elo-рейтинги...");
  const eloMap = buildElo(tier1);

  const teamsOut = [...eloMap.values()]
    .map((t) => {
      const meta = teamMeta.get(t.id) || {};
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
  console.log(`\nГотово. Команд: ${teamsOut.length}, матчей в основе рейтинга: ${tier1.length}`);
  console.log("Топ-10 Tier-1 команд по Elo:");
  teamsOut.slice(0, 10).forEach((t, i) => console.log(`  ${i + 1}. ${t.name} — ${t.rating} (${t.games} игр)`));
}

main().catch((e) => {
  console.error("Ошибка сборки данных:", e);
  process.exit(1);
});
