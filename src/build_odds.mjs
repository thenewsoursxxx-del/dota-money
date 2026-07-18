// Collect Pinnacle CLOSING lines for Tier-1 Dota 2 matches from OddsPapi and write
//   docs/data/odds_history.json — the historical-odds dataset our ROI backtest needs.
// Also auto-fills docs/data/upcoming.json oddsA/oddsB from the live Pinnacle line (only
// when missing), so the app shows real market odds without manual entry.
//
// Run:  npm run build-odds
//   env ODDS_FROM=2026-01-01  (start date; OddsPapi history begins Jan 2026)
//       ODDS_TO=2026-07-18    (end date; default = today)
//       ODDSPAPI_ML_MARKET    (force a moneyline marketId; default = auto-detect by max limit)
//
// The historical-odds endpoint has a 5s cooldown, so we FIRST filter fixtures down to games
// where BOTH teams exist in our Tier-1 dataset — no wasted calls on irrelevant matches.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOTA_SPORT_ID, participants, fixtures, historicalOdds, settlements } from "./oddspapi.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

const FROM = process.env.ODDS_FROM || "2026-01-01";
const TO = process.env.ODDS_TO || new Date().toISOString().slice(0, 10);
const FORCED_MARKET = process.env.ODDSPAPI_ML_MARKET || null;

// Normalize an org name so "Team Spirit", "SPIRIT", "team spirit " all collapse to one key.
function norm(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(team|esports|esport|gaming|club|the|galaxy)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// Split [from,to] into ≤10-day windows (OddsPapi /fixtures requires to-from < 10 days).
function dateWindows(from, to) {
  const out = [];
  let cur = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cur <= end) {
    const wEnd = new Date(cur);
    wEnd.setUTCDate(wEnd.getUTCDate() + 9);
    out.push([cur.toISOString().slice(0, 10), (wEnd < end ? wEnd : end).toISOString().slice(0, 10)]);
    cur = new Date(wEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Pick the match-winner moneyline market out of a historical-odds `markets` object.
// Heuristic: the main line carries the HIGHEST stake limit and has exactly 2 outcomes.
function pickMoneyline(markets) {
  if (FORCED_MARKET && markets[FORCED_MARKET]) return FORCED_MARKET;
  let best = null, bestLimit = -1;
  for (const [mid, m] of Object.entries(markets || {})) {
    const outs = Object.keys(m.outcomes || {});
    if (outs.length !== 2) continue;
    let maxLimit = 0;
    for (const oid of outs) {
      const snaps = ((m.outcomes[oid].players || {})["0"]) || [];
      for (const s of snaps) if ((s.limit || 0) > maxLimit) maxLimit = s.limit || 0;
    }
    if (maxLimit > bestLimit) { bestLimit = maxLimit; best = mid; }
  }
  return best;
}

// Closing price = last snapshot at/just before kickoff (fallback: earliest we have).
function closingPrice(snaps, startMs) {
  if (!Array.isArray(snaps) || !snaps.length) return null;
  const sorted = [...snaps].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let close = null;
  for (const s of sorted) {
    if (new Date(s.createdAt).getTime() <= startMs + 60_000) close = s; // allow 1 min slack
  }
  return (close || sorted[0]).price || null;
}

async function loadJSON(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

async function main() {
  const dataset = await loadJSON(join(DATA_DIR, "dataset.json"), { teams: [] });
  const known = new Map(); // normName -> { id, name }
  for (const t of dataset.teams || []) {
    const k = norm(t.name);
    if (!k) continue;
    const cur = known.get(k);
    if (!cur || (t.lastPlayed || 0) > (cur.lastPlayed || 0)) known.set(k, { id: t.id, name: t.name, lastPlayed: t.lastPlayed });
  }
  console.log(`Известных Tier-1 команд в датасете: ${known.size}`);

  console.log(`Тяну участников OddsPapi (sportId=${DOTA_SPORT_ID})...`);
  const partMap = await participants(); // { id: name }
  const partName = (id) => partMap[String(id)] || null;

  // 1) Collect Dota fixtures across the date range, keep only both-teams-known games.
  const windows = dateWindows(FROM, TO);
  console.log(`Окон дат: ${windows.length} (${FROM} → ${TO})`);
  const relevant = [];
  for (const [from, to] of windows) {
    let fx = [];
    try { fx = await fixtures({ from, to }); } catch (e) { console.warn(`  окно ${from}..${to}: ${e.message}`); continue; }
    for (const f of fx) {
      const nA = partName(f.participant1Id) || f.participant1Name;
      const nB = partName(f.participant2Id) || f.participant2Name;
      const kA = norm(nA), kB = norm(nB);
      if (known.has(kA) && known.has(kB)) {
        relevant.push({
          fixtureId: f.fixtureId,
          startTime: f.startTime,
          startMs: new Date(f.startTime).getTime(),
          teamA: nA, teamB: nB,
          idA: known.get(kA).id, idB: known.get(kB).id,
          event: f.tournamentName || null,
        });
      }
    }
    console.log(`  ${from}..${to}: fixtures=${fx.length}, релевантных всего=${relevant.length}`);
  }

  // 2) Closing Pinnacle line + settled winner per fixture.
  console.log(`\nТяну закрывающие линии Pinnacle для ${relevant.length} матчей (cooldown 5с/запрос)...`);
  const records = [];
  let done = 0;
  for (const r of relevant) {
    done++;
    let hist = null, sett = null;
    try { hist = await historicalOdds(r.fixtureId, "pinnacle"); } catch (e) { console.warn(`  ${r.teamA} vs ${r.teamB}: odds ${e.message}`); continue; }
    const markets = hist && hist.bookmakers && hist.bookmakers.pinnacle && hist.bookmakers.pinnacle.markets;
    if (!markets) continue;
    const mid = pickMoneyline(markets);
    if (!mid) continue;
    const outs = Object.keys(markets[mid].outcomes).sort((a, b) => Number(a) - Number(b)); // asc: [A, B]
    const priceA = closingPrice((markets[mid].outcomes[outs[0]].players || {})["0"], r.startMs);
    const priceB = closingPrice((markets[mid].outcomes[outs[1]].players || {})["0"], r.startMs);
    if (!priceA || !priceB) continue;

    let winner = null;
    try {
      sett = await settlements(r.fixtureId);
      const sm = sett && sett.markets && sett.markets[mid];
      if (sm) {
        const rA = ((sm.outcomes[outs[0]] || {}).players || {})["0"];
        const rB = ((sm.outcomes[outs[1]] || {}).players || {})["0"];
        if (rA && rA.result === "WIN") winner = "a";
        else if (rB && rB.result === "WIN") winner = "b";
      }
    } catch { /* winner stays null → backtest will try to fill from our results */ }

    records.push({
      fixtureId: r.fixtureId,
      startTime: r.startTime,
      event: r.event,
      teamA: r.teamA, teamB: r.teamB,
      idA: r.idA, idB: r.idB,
      oddsA: priceA, oddsB: priceB,
      marketId: mid,
      winner, // "a" | "b" | null
    });
    if (done % 10 === 0 || done === relevant.length) {
      console.log(`  [${done}/${relevant.length}] собрано записей: ${records.length}`);
    }
  }

  records.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const out = {
    generatedAt: new Date().toISOString(),
    source: "oddspapi.historical-odds (pinnacle closing line)",
    range: { from: FROM, to: TO },
    count: records.length,
    matches: records,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "odds_history.json"), JSON.stringify(out), "utf8");
  console.log(`\nГотово. Матчей с кэфами: ${records.length}. Сохранено: docs/data/odds_history.json`);

  // 3) Auto-fill upcoming odds (only where missing) from the same Pinnacle records by team+date.
  await fillUpcoming(records);
}

async function fillUpcoming(records) {
  const upPath = join(DATA_DIR, "upcoming.json");
  const up = await loadJSON(upPath, null);
  if (!up || !Array.isArray(up.matches) || !up.matches.length) return;
  const byPair = new Map();
  for (const r of records) byPair.set(`${norm(r.teamA)}|${norm(r.teamB)}`, r);
  let filled = 0;
  for (const m of up.matches) {
    if (m.oddsA && m.oddsB) continue; // respect manual/existing odds
    const idA = String(m.teamA), idB = String(m.teamB);
    const rec = records.find((r) => String(r.idA) === idA && String(r.idB) === idB) ||
                records.find((r) => String(r.idA) === idB && String(r.idB) === idA);
    if (!rec) continue;
    const flip = String(rec.idA) !== idA;
    m.oddsA = flip ? rec.oddsB : rec.oddsA;
    m.oddsB = flip ? rec.oddsA : rec.oddsB;
    filled++;
  }
  if (filled) {
    await writeFile(upPath, JSON.stringify(up, null, 2), "utf8");
    console.log(`Автозаполнено кэфов в upcoming.json: ${filled}`);
  }
}

main().catch((e) => { console.error("Ошибка OddsPapi:", e.message); process.exit(1); });
