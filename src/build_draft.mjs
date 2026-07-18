// v2 data pipeline: hero counters + team rosters + player hero pools → docs/data/draft.json
// Heavy per-hero/per-player computation happens here; the browser only runs light analysis.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getHeroes,
  getHeroMatchups,
  getTeamPlayers,
  getTeamHeroes,
  getPlayerHeroes,
} from "./opendota.mjs";
import { computeHeroCounters, computePlayerPool, computeTeamVulnerability } from "../docs/draft.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

const N_TEAMS = Number(process.env.TEAMS || 24);
const N_PLAYERS = Number(process.env.PLAYERS || 5);
const DELAY = Number(process.env.DELAY || 900); // pacing to stay under OpenDota free rate limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The International 2026 line-up (16 teams). These get rosters regardless of Elo rank so the
// draft/pool tools always work for the tournament that matters. IDs are the canonical
// OpenDota team_ids in our dataset (the entry with the most games when an org has several).
//   Aurora, BoomBoys/BetBoom, Falcons, Team Liquid, Tundra(1win roster), Xtreme, Yandex,
//   Team Spirit, TEAM VISION(PARIVISION), Nigma Galaxy, HULIGANI, Team Resilience, Vici, OG,
//   GamerLegion, LGD Gaming.
const TI2026_TEAM_IDS = [
  9467224, 8255888, 9247354, 2163, 8291895, 8261500, 9823272, 7119388,
  9572001, 10136357, 10149530, 5017210, 726228, 2586976, 9964962, 10150538,
];

async function main() {
  const dataset = JSON.parse(await readFile(join(DATA_DIR, "dataset.json"), "utf8"));

  console.log("1/4 Загружаю список героев...");
  const heroes = await getHeroes();
  const heroesById = {};
  for (const h of heroes) heroesById[h.id] = { name: h.localized_name, roles: h.roles || [] };
  const heroName = (id) => (heroesById[id] ? heroesById[id].name : `Hero ${id}`);

  console.log(`2/4 Считаю контр-матчапы (${heroes.length} героев)...`);
  const heroMeta = {};
  let done = 0;
  for (const h of heroes) {
    try {
      const mu = await getHeroMatchups(h.id);
      heroMeta[h.id] = computeHeroCounters(mu, h.localized_name);
    } catch (e) {
      heroMeta[h.id] = { counterability: 0, topCounters: [], name: h.localized_name };
    }
    done++;
    process.stdout.write(`\r  героев обработано: ${done}/${heroes.length}`);
    await sleep(DELAY);
  }
  process.stdout.write("\n");

  // Target set = top Tier-1 teams by Elo  ∪  the TI 2026 line-up (always included).
  const byId = new Map(dataset.teams.map((t) => [t.id, t]));
  const topTeams = dataset.teams.filter((t) => t.games >= 5).slice(0, N_TEAMS);
  const targetMap = new Map(topTeams.map((t) => [t.id, t]));
  for (const id of TI2026_TEAM_IDS) {
    const t = byId.get(id);
    if (t) targetMap.set(id, t);
    else console.log(`   ⚠ TI-команда id=${id} не найдена в датасете — пропускаю`);
  }
  const targetTeams = [...targetMap.values()];
  const tiCount = TI2026_TEAM_IDS.filter((id) => targetMap.has(id)).length;
  console.log(`3/4 Собираю ростеры и пулы игроков для ${targetTeams.length} команд (из них TI-2026: ${tiCount})...`);

  const teamsOut = {};
  for (const t of targetTeams) {
    try {
      const [players, teamHeroesRaw] = await Promise.all([getTeamPlayers(t.id), getTeamHeroes(t.id)]);
      await sleep(DELAY);

      // OpenDota's is_current_team_member flag is unreliable (often false for whole rosters,
      // e.g. PARIVISION). Trust it only when it marks a plausible roster (>=3); otherwise fall
      // back to the most-active players on this team_id.
      const withAcc = players.filter((p) => p.account_id);
      const flagged = withAcc.filter((p) => p.is_current_team_member);
      const base = flagged.length >= 3 ? flagged : withAcc;
      const current = base
        .sort((a, b) => (b.games_played || 0) - (a.games_played || 0))
        .slice(0, N_PLAYERS);

      const roster = [];
      for (const p of current) {
        try {
          const ph = await getPlayerHeroes(p.account_id);
          const pool = computePlayerPool(ph, heroMeta, heroName);
          roster.push({
            account_id: p.account_id,
            name: p.name || `Player ${p.account_id}`,
            poolWidth: Number(pool.poolWidth.toFixed(2)),
            predictability: Number(pool.predictability.toFixed(3)),
            signature: pool.signature.map((s) => ({
              id: s.id,
              name: s.name,
              weight: Number(s.weight.toFixed(3)),
              games: s.games,
              wr: Number(s.wr.toFixed(3)),
              counterability: Number(s.counterability.toFixed(3)),
              topCounters: s.topCounters.map((c) => ({ id: c.id, name: c.name, wr: Number(c.wr.toFixed(3)) })),
            })),
          });
        } catch (e) {
          /* skip player on error */
        }
        await sleep(DELAY);
      }

      const teamHeroes = (teamHeroesRaw || [])
        .sort((a, b) => (b.games_played || 0) - (a.games_played || 0))
        .slice(0, 25)
        .map((h) => ({ id: h.hero_id, name: h.localized_name || heroName(h.hero_id), games: h.games_played, wins: h.wins }));

      teamsOut[t.id] = {
        id: t.id,
        name: t.name,
        vulnerability: Number(computeTeamVulnerability(roster).toFixed(3)),
        teamHeroes,
        roster,
      };
      console.log(`   ✓ ${t.name}: ${roster.length} игроков, уязвимость ${teamsOut[t.id].vulnerability}`);
    } catch (e) {
      console.log(`   ✗ ${t.name}: ошибка (${e.message})`);
    }
  }

  console.log("4/4 Сохраняю draft.json...");
  const out = {
    generatedAt: new Date().toISOString(),
    heroes: heroesById,
    teams: teamsOut,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "draft.json"), JSON.stringify(out), "utf8");

  const teamCount = Object.keys(teamsOut).length;
  console.log(`\nГотово. Команд с драфт-данными: ${teamCount}`);
  const ranked = Object.values(teamsOut).sort((a, b) => b.vulnerability - a.vulnerability);
  console.log("Самые «читаемые» по драфту (высокая уязвимость):");
  ranked.slice(0, 5).forEach((t) => console.log(`  ${t.name}: ${t.vulnerability}`));
}

main().catch((e) => {
  console.error("Ошибка сборки драфта:", e);
  process.exit(1);
});
