// Enrich hero meta with STRATZ per-position win rates (recent months, high-MMR).
// Writes docs/data/stratz.json:
//   { generatedAt, months, bracket, source, heroes: { [heroId]: { overall:{wr,games}, pos:{ "1":{wr,games}, ... } } } }
// Position win rates make the draft engine role-aware (a hero can be strong core, weak support).
//
// STRATZ schema notes (verified via introspection against DotaQuery):
//   heroStats.winMonth(positionIds: MatchPlayerPositionType, bracketIds: RankBracket, take: Int)
//     -> [{ heroId, month, matchCount, winCount }]  (month = epoch seconds of month start)
//   There is no "position" field in the row and no groupByPosition arg: filter per position
//   with positionIds and issue one query per role. We aggregate the last RECENT_MONTHS buckets
//   to capture the CURRENT meta while smoothing single-month noise.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stratzQuery, sleep } from "./stratz.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

const BRACKET = process.env.STRATZ_BRACKET || "IMMORTAL"; // closest public proxy for pro-level meta
const RECENT_MONTHS = Number(process.env.STRATZ_MONTHS || 2);
const POSITIONS = [1, 2, 3, 4, 5];

const query = (posEnum) => `{
  heroStats {
    winMonth(positionIds: ${posEnum}, bracketIds: ${BRACKET}, take: 4000) {
      heroId
      month
      matchCount
      winCount
    }
  }
}`;

// Keep only the most recent RECENT_MONTHS distinct months, summed per hero.
function aggregateRecent(rows) {
  const months = [...new Set(rows.map((r) => r.month))].sort((a, b) => b - a);
  const keep = new Set(months.slice(0, RECENT_MONTHS));
  const perHero = new Map();
  for (const r of rows) {
    if (!keep.has(r.month)) continue;
    const cur = perHero.get(r.heroId) || { w: 0, g: 0 };
    cur.w += r.winCount || 0;
    cur.g += r.matchCount || 0;
    perHero.set(r.heroId, cur);
  }
  return { perHero, months: months.slice(0, RECENT_MONTHS) };
}

async function main() {
  console.log(`Запрашиваю мету по позициям из Stratz (bracket=${BRACKET}, месяцев=${RECENT_MONTHS})...`);

  const heroes = {}; // id -> { overall:{w,g}, pos:{ [1..5]:{w,g} } }
  let monthsUsed = [];

  for (const pos of POSITIONS) {
    const posEnum = `POSITION_${pos}`;
    const data = await stratzQuery(query(posEnum));
    const rows = (data && data.heroStats && data.heroStats.winMonth) || [];
    if (!rows.length) { console.warn(`  ${posEnum}: пусто`); continue; }
    const { perHero, months } = aggregateRecent(rows);
    if (months.length && !monthsUsed.length) monthsUsed = months;
    let heroesWithData = 0;
    for (const [id, { w, g }] of perHero) {
      if (!g) continue;
      heroesWithData++;
      if (!heroes[id]) heroes[id] = { overall: { w: 0, g: 0 }, pos: {} };
      heroes[id].pos[pos] = { wr: Number((w / g).toFixed(4)), games: g };
      heroes[id].overall.w += w;
      heroes[id].overall.g += g;
    }
    console.log(`  ${posEnum}: героев ${heroesWithData}`);
    await sleep(300);
  }

  if (!Object.keys(heroes).length) {
    throw new Error("Пустой результат по всем позициям — проверь токен/схему.");
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "stratz.heroStats.winMonth",
    bracket: BRACKET,
    months: monthsUsed.map((m) => new Date(m * 1000).toISOString().slice(0, 7)),
    heroes: {},
  };
  for (const [id, h] of Object.entries(heroes)) {
    out.heroes[id] = {
      overall: { wr: h.overall.g ? Number((h.overall.w / h.overall.g).toFixed(4)) : null, games: h.overall.g },
      pos: h.pos,
    };
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "stratz.json"), JSON.stringify(out), "utf8");

  const n = Object.keys(out.heroes).length;
  console.log(`\nГотово. Героев: ${n}. Месяцы: ${out.months.join(", ")}. Сохранено: docs/data/stratz.json`);
  const top = Object.entries(out.heroes)
    .map(([id, h]) => ({ id, wr: (h.pos[1] && h.pos[1].wr) || h.overall.wr, g: h.overall.games }))
    .filter((x) => x.wr != null && x.g > 500)
    .sort((a, b) => b.wr - a.wr)
    .slice(0, 8);
  console.log("Топ по винрейту (pos1/overall):", top.map((x) => `${x.id}:${(x.wr * 100).toFixed(1)}%`).join("  "));
}

main().catch((e) => { console.error("Ошибка Stratz:", e.message); process.exit(1); });
