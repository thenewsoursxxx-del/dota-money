// Thin OpenDota API client (free, no key required).
// Docs: https://docs.opendota.com/

const BASE = "https://api.opendota.com/api";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path, { retries = 3 } = {}) {
  const url = `${BASE}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "dota-money/0.1" } });
      if (res.status === 429) {
        // Rate limited: back off and retry.
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

export async function getLeagues() {
  return getJSON("/leagues");
}

export async function getHeroes() {
  return getJSON("/heroes");
}

// Hero-vs-hero matchups (pro-level). Returns [{ hero_id, games_played, wins }],
// where `wins` are wins of `heroId` against `hero_id`.
export async function getHeroMatchups(heroId) {
  return getJSON(`/heroes/${heroId}/matchups`);
}

// Team roster: [{ account_id, name, games_played, wins, is_current_team_member }]
export async function getTeamPlayers(teamId) {
  return getJSON(`/teams/${teamId}/players`);
}

// Team hero tendencies: [{ hero_id, localized_name, games_played, wins }]
export async function getTeamHeroes(teamId) {
  return getJSON(`/teams/${teamId}/heroes`);
}

// Player hero pool: [{ hero_id, last_played, games, win, ... }]
export async function getPlayerHeroes(accountId) {
  return getJSON(`/players/${accountId}/heroes`);
}

export async function getTeams() {
  // Returns up to ~1000 teams ordered by their internal rating.
  return getJSON("/teams");
}

// Paginate backwards through the pro match feed.
// Each page returns 100 matches; we walk via less_than_match_id.
export async function getProMatches({ pages = 30, delayMs = 350 } = {}) {
  const all = [];
  let lessThan = null;
  for (let i = 0; i < pages; i++) {
    const path = lessThan ? `/proMatches?less_than_match_id=${lessThan}` : "/proMatches";
    const batch = await getJSON(path);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    lessThan = batch[batch.length - 1].match_id;
    process.stdout.write(`\r  fetched pro matches: ${all.length}`);
    await sleep(delayMs);
  }
  process.stdout.write("\n");
  return all;
}
