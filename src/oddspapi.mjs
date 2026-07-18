// Minimal OddsPapi REST client (https://api.oddspapi.io, docs: https://oddspapi.io/en/docs).
// Free self-serve key: https://oddspapi.io → account settings. Auth is an `apiKey` query param.
// We use it to pull Pinnacle (sharp) CLOSING lines for Tier-1 Dota 2, so we can finally
// measure ROI/CLV against the market — the one thing our backtests were missing.
//
// Endpoints we rely on (all return JSON):
//   GET /v4/participants?sportId=16                     -> { participantId: name }
//   GET /v4/fixtures?sportId=16&from=YYYY-MM-DD&to=...  -> [ {fixtureId, participant1Id, participant2Id, startTime, ...} ]  (to-from < 10d)
//   GET /v4/historical-odds?fixtureId=..&bookmakers=pinnacle -> full price history (we take the last active pre-match price = close)
//   GET /v4/settlements?fixtureId=..                    -> WIN/LOSE per outcome (authoritative winner)
//
// Per-endpoint cooldowns (from docs) are respected so we never trip the rate limiter.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "https://api.oddspapi.io";
export const DOTA_SPORT_ID = Number(process.env.ODDSPAPI_SPORT_ID || 16);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token from env or a gitignored `.oddspapi_token` file (secret never hits shell history/commits).
export function oddsToken() {
  const env = (process.env.ODDSPAPI_KEY || process.env.ODDSPAPI_TOKEN || "").trim();
  if (env) return env;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    return readFileSync(join(root, ".oddspapi_token"), "utf8").trim();
  } catch { return ""; }
}

// Documented cooldowns (ms). We keep a per-endpoint "next allowed" timestamp and wait it out.
const COOLDOWN = {
  "/v4/participants": 1000,
  "/v4/fixtures": 1000,
  "/v4/fixture": 1000,
  "/v4/historical-odds": 5000, // slowest — the real bottleneck
  "/v4/settlements": 2000,
  "/v4/tournaments": 1000,
  _default: 1200,
};
const nextAllowed = new Map();

async function paced(path) {
  const cd = COOLDOWN[path] ?? COOLDOWN._default;
  const now = Date.now();
  const wait = (nextAllowed.get(path) || 0) - now;
  if (wait > 0) await sleep(wait);
  nextAllowed.set(path, Date.now() + cd);
}

export async function api(path, params = {}, { retries = 4, headers = {} } = {}) {
  const token = oddsToken();
  if (!token) {
    throw new Error(
      "ODDSPAPI_KEY не задан. Получи бесплатный ключ на https://oddspapi.io (account settings), " +
      'положи в файл .oddspapi_token или задай $env:ODDSPAPI_KEY="..."'
    );
  }
  const url = new URL(HOST + path);
  url.searchParams.set("apiKey", token);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    await paced(path);
    try {
      const res = await fetch(url, { headers });
      if (res.status === 304) return { _notModified: true, _etag: res.headers.get("etag") };
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 401 || res.status === 403) {
        const body = await res.text().catch(() => "");
        throw new Error(`OddsPapi auth ${res.status}: ключ неверный/без доступа. ${body.slice(0, 200)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OddsPapi HTTP ${res.status} на ${path}: ${body.slice(0, 300)}`);
      }
      const json = await res.json();
      return { data: json, _etag: res.headers.get("etag") };
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

export const participants = (sportId = DOTA_SPORT_ID) =>
  api("/v4/participants", { sportId }).then((r) => r.data || {});

export const fixtures = ({ sportId = DOTA_SPORT_ID, from, to, tournamentId } = {}) =>
  api("/v4/fixtures", { sportId, from, to, tournamentId }).then((r) => r.data || []);

export const historicalOdds = (fixtureId, bookmakers = "pinnacle") =>
  api("/v4/historical-odds", { fixtureId, bookmakers }).then((r) => r.data || null);

export const settlements = (fixtureId) =>
  api("/v4/settlements", { fixtureId }).then((r) => r.data || null);
