// Auto-fetch upcoming Tier-1 matches from Liquipedia and write docs/data/upcoming.json.
// Free source (MediaWiki parse API). Respect Liquipedia: descriptive User-Agent + low rate.
// Tier-1 filter = both teams resolve to a team in our dataset (which is built from Tier-1 games).
// Manually-set bookmaker odds are preserved across runs (matched by team pair + date).

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

// Tier-1 gate (Elo). Both teams must be established; at least one clearly top-tier.
// Elo starts at 1500 — Tier-2 teams sit ~1450-1510, Tier-1 ~1600-1760.
const TIER1_TOP = Number(process.env.TIER1_TOP || 1560);
const TIER1_MIN = Number(process.env.TIER1_MIN || 1515);

const UA = "DotaMoney/0.3 (https://github.com/thenewsoursxxx-del/dota-money; educational fan project)";
const LIQ_URL =
  "https://liquipedia.net/dota2/api.php?action=parse&page=Liquipedia:Matches&format=json&prop=text&disablelimitreport=1";

// Known Liquipedia -> our dataset team_id overrides (names that don't match directly).
const ALIASES = {
  "bb team": 8255888,
  "betboom team": 8255888,
  betboom: 8255888,
  boomboys: 8255888,
  parivision: 9824702,
  pvision: 9824702,
  "nigma galaxy": 10136357,
};

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\(page does not exist\)/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();

function buildResolver(dataset) {
  const byNorm = new Map();
  const byNormNoTeam = new Map();
  for (const t of dataset.teams) {
    byNorm.set(norm(t.name), t);
    if (t.tag) byNorm.set(norm(t.tag), t);
    byNormNoTeam.set(norm(String(t.name).replace(/^team\s+/i, "")), t);
  }
  return (liqName) => {
    const a = ALIASES[String(liqName).toLowerCase().trim()];
    if (a) return dataset.teams.find((t) => t.id === a) || null;
    const n = norm(liqName);
    if (!n) return null;
    return byNorm.get(n) || byNormNoTeam.get(n) || byNormNoTeam.get(norm(liqName.replace(/^team\s+/i, ""))) || null;
  };
}

function cleanTournament(raw) {
  if (!raw) return null;
  return raw
    .split("#")[0]
    .replace(/\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract match records from the parse HTML.
function parseMatches(html) {
  const blocks = html.split('class="match-info"').slice(1);
  const out = [];
  for (const b of blocks) {
    const tsm = b.match(/data-timestamp="(\d+)"/);
    if (!tsm) continue;
    const timestamp = Number(tsm[1]);

    // Teams: /dota2/ links in the header (before the tournament section).
    const headerPart = b.split("match-info-tournament")[0];
    const teamMatches = [...headerPart.matchAll(/href="\/dota2\/[^"]*"[^>]*title="([^"]+)"/g)].map((m) => m[1]);
    const uniqTeams = [];
    for (const t of teamMatches) if (!uniqTeams.includes(t)) uniqTeams.push(t);
    if (uniqTeams.length < 2) continue;

    const tourPart = b.split("match-info-tournament")[1] || "";
    const tourm = tourPart.match(/title="([^"]+)"/);
    const bom = b.match(/\(Bo(\d+)\)/i);

    out.push({
      timestamp,
      teamA: uniqTeams[0],
      teamB: uniqTeams[1],
      tournament: cleanTournament(tourm && tourm[1]),
      bo: bom ? Number(bom[1]) : 3,
    });
  }
  return out;
}

async function main() {
  const dataset = JSON.parse(await readFile(join(DATA_DIR, "dataset.json"), "utf8"));
  const resolve = buildResolver(dataset);

  // Preserve manually-set odds across runs (key = sorted team ids + date, odds stored per team id).
  let prevOdds = {};
  try {
    const prev = JSON.parse(await readFile(join(DATA_DIR, "upcoming.json"), "utf8"));
    for (const m of prev.matches || []) {
      const ids = [String(m.teamA), String(m.teamB)].sort().join("-");
      const key = `${ids}|${(m.date || "").slice(0, 10)}`;
      prevOdds[key] = { [String(m.teamA)]: m.oddsA || null, [String(m.teamB)]: m.oddsB || null };
    }
  } catch {}

  console.log("Загружаю предстоящие матчи с Liquipedia...");
  const res = await fetch(LIQ_URL, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`Liquipedia HTTP ${res.status}`);
  const j = await res.json();
  const html = j?.parse?.text?.["*"] || "";
  const raw = parseMatches(html);
  console.log(`  всего предстоящих матчей на Liquipedia: ${raw.length}`);

  const now = Date.now() / 1000;
  const matches = [];
  let idx = 0;
  for (const m of raw) {
    if (m.timestamp < now - 3600) continue; // skip already-started
    const a = resolve(m.teamA);
    const b = resolve(m.teamB);
    if (!a || !b || a.id === b.id) continue; // both teams must be known to us
    // Tier-1 filter by Elo strength (drops Tier-2/qualifier matchups).
    if (Math.max(a.rating, b.rating) < TIER1_TOP) continue;
    if (Math.min(a.rating, b.rating) < TIER1_MIN) continue;

    const date = new Date(m.timestamp * 1000).toISOString();
    const ids = [String(a.id), String(b.id)].sort().join("-");
    const key = `${ids}|${date.slice(0, 10)}`;
    const carried = prevOdds[key] || {};

    matches.push({
      id: `liq-${m.timestamp}-${idx++}`,
      date,
      event: m.tournament,
      format: `bo${m.bo}`,
      teamA: String(a.id),
      teamB: String(b.id),
      oddsA: carried[String(a.id)] || null,
      oddsB: carried[String(b.id)] || null,
    });
  }

  matches.sort((x, y) => new Date(x.date) - new Date(y.date));

  const out = {
    _comment:
      "Автогенерируется src/fetch_upcoming.mjs из Liquipedia. teamA/teamB — team_id. oddsA/oddsB (кэфы) можно вписать вручную — они сохраняются при следующем автообновлении (матчинг по парам команд и дате).",
    _source: "Liquipedia (Dota2) · upcoming matches · Tier-1 = обе команды есть в датасете",
    generatedAt: new Date().toISOString(),
    matches,
  };
  await writeFile(join(DATA_DIR, "upcoming.json"), JSON.stringify(out, null, 2), "utf8");

  console.log(`\nГотово. Tier-1 матчей записано: ${matches.length}`);
  for (const m of matches.slice(0, 15)) {
    const an = dataset.teams.find((t) => String(t.id) === m.teamA).name;
    const bn = dataset.teams.find((t) => String(t.id) === m.teamB).name;
    console.log(`  ${m.date.slice(5, 16)} | ${an} vs ${bn} | ${m.format} | ${m.event}${m.oddsA ? ` | кэф ${m.oddsA}/${m.oddsB}` : ""}`);
  }
}

main().catch((e) => {
  console.error("Ошибка fetch_upcoming:", e);
  process.exit(1);
});
