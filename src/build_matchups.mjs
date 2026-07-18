// Pull robust hero-vs-hero matchup win rates from STRATZ (high-MMR) into
//   docs/data/matchups.json — the counter signal our pro-only matrix was too thin for.
//
// Our meta.json counter matrix is built from Tier-1 pro co-occurrence, so most hero pairs
// have 0-6 games → pure noise (e.g. "Tiny vs TA" read off 4 games). STRATZ aggregates
// hundreds of Divine/Immortal games per matchup, so the counter term finally reflects reality
// (e.g. TA is genuinely weak into Ember/Hoodwink).
//
// Schema (verified): heroStats.matchUp(heroId, take, bracketBasicIds) { vs { heroId2 winCount matchCount } }
//   `vs[i]` = THIS hero's record when playing AGAINST heroId2. winCount/matchCount = its win rate.
//
// Run: npm run build-matchups   (env STRATZ_BRACKET_BASIC=DIVINE_IMMORTAL, STRATZ_MIN_GAMES=30)

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stratzQuery, sleep } from "./stratz.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

const BRACKET = process.env.STRATZ_BRACKET_BASIC || "DIVINE_IMMORTAL";
const MIN_GAMES = Number(process.env.STRATZ_MIN_GAMES || 30); // drop tiny matchup samples
const BATCH = Number(process.env.STRATZ_BATCH || 8);          // heroes per aliased request

async function loadJSON(p, fb) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fb; } }

const one = (alias, id) =>
  `${alias}: matchUp(heroId: ${id}, take: 300, bracketBasicIds: ${BRACKET}) { vs { heroId2 winCount matchCount } }`;

async function main() {
  const meta = await loadJSON(join(DATA_DIR, "meta.json"), { heroes: {} });
  const ids = Object.keys(meta.heroes).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!ids.length) throw new Error("Нет героев в meta.json — сначала npm run build-meta.");
  console.log(`Тяну матчапы из Stratz (bracket=${BRACKET}, героев=${ids.length}, батч=${BATCH})...`);

  const heroes = {}; // id -> { vs: { [heroId2]: [games, wins] } }
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const q = `{ heroStats { ${chunk.map((id, k) => one("h" + k, id)).join(" ")} } }`;
    let data;
    try { data = await stratzQuery(q); }
    catch (e) { console.warn(`  батч ${i}-${i + chunk.length}: ${e.message.slice(0, 120)}`); await sleep(800); continue; }
    const hs = (data && data.heroStats) || {};
    chunk.forEach((id, k) => {
      const raw = hs["h" + k];
      const rec = Array.isArray(raw) ? raw[0] : raw; // matchUp returns a list; alias keeps that shape
      const vs = rec && rec.vs;
      if (!Array.isArray(vs)) return;
      const out = {};
      for (const r of vs) {
        if (!r || r.matchCount < MIN_GAMES) continue;
        out[r.heroId2] = [r.matchCount, r.winCount];
      }
      if (Object.keys(out).length) heroes[id] = { vs: out };
    });
    done += chunk.length;
    if (done % 32 === 0 || done >= ids.length) console.log(`  прогресс ${Math.min(done, ids.length)}/${ids.length}`);
    await sleep(350);
  }

  const nHeroes = Object.keys(heroes).length;
  const nPairs = Object.values(heroes).reduce((s, h) => s + Object.keys(h.vs).length, 0);
  if (!nHeroes) throw new Error("Пусто — проверь токен/схему Stratz.");

  const out = {
    generatedAt: new Date().toISOString(),
    source: "stratz.heroStats.matchUp (vs winrate)",
    bracket: BRACKET,
    minGames: MIN_GAMES,
    heroes,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "matchups.json"), JSON.stringify(out), "utf8");
  console.log(`\nГотово. Героев с матчапами: ${nHeroes}, пар: ${nPairs}. Сохранено: docs/data/matchups.json`);
}

main().catch((e) => { console.error("Ошибка build-matchups:", e.message); process.exit(1); });
