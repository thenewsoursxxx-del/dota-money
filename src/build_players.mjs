// Per-player "human factor" data → docs/data/players.json.
// For every rostered player (from draft.json) we pull from OpenDota:
//   /players/{id}/heroes        → career per-hero {games, win}  (on-hero comfort for ANY hero)
//   /players/{id}/recentMatches → last ~20 games               → recent form, prime trend, activity
//
// The model already knows TEAM form; this adds the INDIVIDUAL layer the user asked for:
//   - recentWR : is this player hot or cold right now
//   - trend    : "in prime / declining" (recent half vs older half of the window)
//   - games30  : activity (roster continuity / match practice)
//   - heroes   : real win rate on the exact hero they locked THIS game (not just signature pool)
//
// Run: npm run build-players   (env PLAYERS_MAX=N to cap for a quick local test, DELAY_MS=1100)

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlayerHeroes, getPlayerRecentMatches } from "./opendota.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");
const DELAY_MS = Number(process.env.DELAY_MS || 1100);
const MAX = Number(process.env.PLAYERS_MAX || 0);
// Optional: only rebuild players from these team ids (comma-separated), e.g. after a series.
const TEAM_IDS = (process.env.PLAYERS_TEAM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const K = 6; // winrate shrink toward 0.5
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shrunk = (g, w) => (g > 0 ? (w + K * 0.5) / (g + K) : 0.5);

async function loadJSON(p, fb) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fb; } }

function isWin(m) {
  const radiant = m.player_slot < 128;
  return radiant === m.radiant_win;
}

// Recent form + prime trend + activity from the recent-matches window.
function summarizeRecent(matches) {
  const ms = (matches || []).filter((m) => m && m.start_time).sort((a, b) => b.start_time - a.start_time);
  const n = ms.length;
  if (!n) return { recentWR: 0.5, recentN: 0, trend: 0, games30: 0, lastPlayed: null };
  const wins = ms.filter(isWin).length;
  const recentWR = shrunk(n, wins);
  // Prime trend: newer half vs older half win rate (positive = trending up / in form).
  const half = Math.floor(n / 2);
  const newer = ms.slice(0, half || 1);
  const older = ms.slice(half || 1);
  const wr = (arr) => (arr.length ? arr.filter(isWin).length / arr.length : 0.5);
  const trend = half ? Number((wr(newer) - wr(older)).toFixed(3)) : 0;
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  const games30 = ms.filter((m) => m.start_time >= cutoff).length;
  return { recentWR: Number(recentWR.toFixed(3)), recentN: n, trend, games30, lastPlayed: ms[0].start_time };
}

async function main() {
  const draft = await loadJSON(join(DATA_DIR, "draft.json"), { teams: {} });
  const teams = draft.teams || {};
  // Unique players across all rosters (a player can appear once).
  const seen = new Map(); // account_id -> { name, teams:Set }
  for (const [tid, t] of Object.entries(teams)) {
    if (TEAM_IDS.length && !TEAM_IDS.includes(String(tid)) && !TEAM_IDS.includes(String(t.id))) continue;
    for (const p of t.roster || []) {
      if (!p.account_id) continue;
      const cur = seen.get(p.account_id) || { name: p.name, teams: [] };
      if (!cur.teams.includes(t.name)) cur.teams.push(t.name);
      seen.set(p.account_id, cur);
    }
  }
  let list = [...seen.entries()];
  if (MAX > 0) list = list.slice(0, MAX);
  console.log(`Игроков в ростерах: ${seen.size}${MAX ? ` (беру ${list.length})` : ""}. Пейсинг ${DELAY_MS}ms.`);

  // Merge into existing file when refreshing a team subset, so we don't wipe other rosters.
  const prev = TEAM_IDS.length ? await loadJSON(join(DATA_DIR, "players.json"), { players: {} }) : { players: {} };
  const players = { ...(prev.players || {}) };
  let done = 0, errors = 0;
  for (const [accountId, info] of list) {
    done++;
    try {
      const [heroesRaw, recent] = await Promise.all([
        getPlayerHeroes(accountId),
        getPlayerRecentMatches(accountId),
      ]);
      const heroes = {};
      for (const h of heroesRaw || []) {
        if (!h || !h.hero_id || !h.games) continue;
        heroes[h.hero_id] = [h.games, h.win || 0];
      }
      const rec = summarizeRecent(recent);
      players[accountId] = {
        name: info.name,
        recentWR: rec.recentWR,
        recentN: rec.recentN,
        trend: rec.trend,
        games30: rec.games30,
        lastPlayed: rec.lastPlayed,
        heroes,
      };
    } catch (e) {
      errors++;
      console.warn(`  ${info.name} (${accountId}): ${e.message.slice(0, 80)}`);
    }
    if (done % 20 === 0 || done === list.length) console.log(`  ${done}/${list.length} (ошибок ${errors})`);
    await sleep(DELAY_MS);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "opendota /players/{id}/heroes + /recentMatches",
    count: Object.keys(players).length,
    players,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "players.json"), JSON.stringify(out), "utf8");
  console.log(`\nГотово. Игроков с данными: ${out.count}. Сохранено: docs/data/players.json`);
}

main().catch((e) => { console.error("Ошибка build-players:", e.message); process.exit(1); });
