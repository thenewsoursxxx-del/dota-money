// v3 meta pipeline: hero meta (/heroStats) + synergy/counter matrices, power curves,
// and lane economy from match details (/matches/{id}). → docs/data/meta.json
//
// Heavy: fetches detail for ~900 recent Tier-1 matches (paced). Runs weekly in CI.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLeagues, getProMatches, getHeroStats, getMatch } from "./opendota.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

const MATCHES = Number(process.env.MATCHES || 900); // how many recent Tier-1 matches to detail
const PAGES = Number(process.env.PAGES || 30); // proMatches pages to scan for Tier-1 ids
const DELAY = Number(process.env.DELAY || 900); // pacing for /matches (OpenDota free ~60/min)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pairKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
const dirKey = (a, b) => `${a},${b}`;

function bump(map, key) {
  let v = map.get(key);
  if (!v) { v = { g: 0, w: 0 }; map.set(key, v); }
  return v;
}

async function main() {
  console.log("1/4 Загружаю мету героев (/heroStats)...");
  const hs = await getHeroStats();
  const heroes = {};
  let maxContest = 1;
  for (const h of hs) {
    const contest = (h.pro_pick || 0) + (h.pro_ban || 0);
    if (contest > maxContest) maxContest = contest;
  }
  for (const h of hs) {
    const proPick = h.pro_pick || 0;
    const proBan = h.pro_ban || 0;
    const proWin = h.pro_win || 0;
    heroes[h.id] = {
      name: h.localized_name,
      roles: h.roles || [],
      primary: h.primary_attr,
      attack: h.attack_type,
      strGain: h.str_gain, agiGain: h.agi_gain, intGain: h.int_gain,
      moveSpeed: h.move_speed,
      proPick, proBan, proWin,
      winrate: proPick >= 5 ? proWin / proPick : null,
      contest: Number(((proPick + proBan) / maxContest).toFixed(3)),
      // empirical (filled from match details):
      games: 0, wins: 0,
      dur: { short: { g: 0, w: 0 }, mid: { g: 0, w: 0 }, long: { g: 0, w: 0 } },
      nw10Sum: 0, nw10N: 0,
    };
  }

  console.log(`2/4 Ищу Tier-1 матчи (${PAGES} страниц про-матчей)...`);
  const leagues = await getLeagues();
  const TIER1 = new Set(["premium", "professional"]);
  const premiumIds = new Set(leagues.filter((l) => TIER1.has(l.tier)).map((l) => l.leagueid));
  const pro = await getProMatches({ pages: PAGES, delayMs: 350 });
  const tier1Ids = pro
    .filter((m) => premiumIds.has(m.leagueid) && m.radiant_team_id && m.dire_team_id && typeof m.radiant_win === "boolean")
    .sort((a, b) => b.start_time - a.start_time)
    .slice(0, MATCHES)
    .map((m) => m.match_id);
  console.log(`   Tier-1 матчей к детализации: ${tier1Ids.length}`);

  console.log("3/4 Тяну детали матчей (picks_bans, тайминги, лейны)...");
  const synergy = new Map();
  const counter = new Map();
  let used = 0, parsed = 0, errors = 0;
  for (const id of tier1Ids) {
    try {
      const m = await getMatch(id);
      if (m && Array.isArray(m.picks_bans) && typeof m.radiant_win === "boolean") {
        used++;
        const radWin = m.radiant_win;
        const dur = m.duration || 0;
        const bucket = dur < 1800 ? "short" : dur <= 2400 ? "mid" : "long";

        const picks = m.picks_bans.filter((p) => p.is_pick && p.hero_id);
        const rad = picks.filter((p) => p.team === 0).map((p) => p.hero_id);
        const dire = picks.filter((p) => p.team === 1).map((p) => p.hero_id);

        const credit = (ids, won) => {
          for (const hid of ids) {
            const h = heroes[hid];
            if (!h) continue;
            h.games++; if (won) h.wins++;
            const b = h.dur[bucket]; b.g++; if (won) b.w++;
          }
        };
        credit(rad, radWin);
        credit(dire, !radWin);

        const addSyn = (ids, won) => {
          for (let i = 0; i < ids.length; i++)
            for (let j = i + 1; j < ids.length; j++) {
              const v = bump(synergy, pairKey(ids[i], ids[j]));
              v.g++; if (won) v.w++;
            }
        };
        addSyn(rad, radWin);
        addSyn(dire, !radWin);

        const addCnt = (mine, theirs, won) => {
          for (const a of mine)
            for (const b of theirs) {
              const v = bump(counter, dirKey(a, b));
              v.g++; if (won) v.w++;
            }
        };
        addCnt(rad, dire, radWin);
        addCnt(dire, rad, !radWin);

        // Lane economy proxy from parsed player timelines.
        if (Array.isArray(m.players)) {
          for (const p of m.players) {
            const h = heroes[p.hero_id];
            if (!h || !Array.isArray(p.gold_t) || p.gold_t.length <= 10) continue;
            h.nw10Sum += p.gold_t[10];
            h.nw10N++;
            if (p.gold_t.length > 20) parsed++;
          }
        }
      }
    } catch (e) {
      errors++;
    }
    if ((used + errors) % 25 === 0) process.stdout.write(`\r  обработано: ${used + errors}/${tier1Ids.length} (ошибок ${errors})`);
    await sleep(DELAY);
  }
  process.stdout.write("\n");

  // Finalize heroes: avg nw10.
  for (const id in heroes) {
    const h = heroes[id];
    h.nw10 = h.nw10N ? Math.round(h.nw10Sum / h.nw10N) : null;
    delete h.nw10Sum; delete h.nw10N;
  }

  // Serialize matrices, dropping ultra-thin pairs to keep file small.
  const MIN_PAIR = 3;
  const toObj = (map) => {
    const o = {};
    for (const [k, v] of map) if (v.g >= MIN_PAIR) o[k] = [v.g, v.w];
    return o;
  };

  const out = {
    generatedAt: new Date().toISOString(),
    matchesUsed: used,
    heroes,
    synergy: toObj(synergy),
    counter: toObj(counter),
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "meta.json"), JSON.stringify(out), "utf8");

  console.log(`4/4 Готово. Матчей учтено: ${used}, пар синергии: ${Object.keys(out.synergy).length}, контр: ${Object.keys(out.counter).length}`);
  // Quick sanity: top meta heroes by winrate (min pick).
  const top = Object.values(heroes)
    .filter((h) => h.games >= 8)
    .sort((a, b) => b.wins / b.games - a.wins / a.games)
    .slice(0, 8);
  console.log("Топ по эмпирическому винрейту (в выборке):");
  for (const h of top) console.log(`  ${h.name}: ${((h.wins / h.games) * 100).toFixed(0)}% (${h.games} игр), nw@10 ${h.nw10 ?? "—"}`);
}

main().catch((e) => {
  console.error("Ошибка build_meta:", e);
  process.exit(1);
});
