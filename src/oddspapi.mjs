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

// The rate limit is effectively GLOBAL per account (interleaving different endpoints still
// 429s), so we pace ALL requests through a single shared window. Docs say 5s on the heavy
// endpoint; 6.5s in practice avoids 429s entirely and keeps throughput predictable.
const GLOBAL_GAP = Number(process.env.ODDSPAPI_GAP_MS || 6500);
const COOLDOWN = { _default: GLOBAL_GAP };
let globalNext = 0;

async function paced(_path) {
  const wait = globalNext - Date.now();
  if (wait > 0) await sleep(wait);
  globalNext = Date.now() + GLOBAL_GAP;
}

export async function api(path, params = {}, { retries = 6, headers = {} } = {}) {
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
      if (res.status === 429) {
        // Rate limited: push the global window out so the retry actually clears it.
        globalNext = Date.now() + GLOBAL_GAP + 1500 * (attempt + 1);
        continue;
      }
      // 4xx (except 429) are deterministic — do NOT waste retries (and cooldowns) on them.
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "");
        const err = new Error(`OddsPapi HTTP ${res.status} на ${path}: ${body.slice(0, 300)}`);
        err.status = res.status;
        err.noRetry = true;
        throw err;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OddsPapi HTTP ${res.status} на ${path}: ${body.slice(0, 300)}`);
      }
      const json = await res.json();
      return { data: json, _etag: res.headers.get("etag") };
    } catch (err) {
      if (err && err.noRetry) throw err;
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  const rl = new Error(`OddsPapi: не удалось получить ответ (${path}) — вероятно, исчерпана квота / rate limit.`);
  rl.rateLimited = true;
  throw rl;
}

// Market dictionary → set of marketIds that are the full-match winner (moneyline, whole series).
let _mlIds = null;
export async function matchWinnerMarketIds(sportId = DOTA_SPORT_ID) {
  if (_mlIds) return _mlIds;
  const list = await api("/v4/markets", { sportId }).then((r) => r.data || []);
  _mlIds = new Set(
    list
      .filter((m) => m.marketType === "moneyline" && m.period === "result" && (m.marketLength === 2 || (m.outcomes || []).length === 2))
      .map((m) => String(m.marketId))
  );
  return _mlIds;
}

export const participants = (sportId = DOTA_SPORT_ID) =>
  api("/v4/participants", { sportId }).then((r) => r.data || {});

export const fixtures = ({ sportId = DOTA_SPORT_ID, from, to, tournamentId } = {}) =>
  api("/v4/fixtures", { sportId, from, to, tournamentId }).then((r) => r.data || []);

export const historicalOdds = (fixtureId, bookmakers = "pinnacle") =>
  api("/v4/historical-odds", { fixtureId, bookmakers })
    .then((r) => r.data || null)
    .catch((e) => { if (e && e.status === 404) return null; throw e; }); // 404 = no odds priced

export const settlements = (fixtureId) =>
  api("/v4/settlements", { fixtureId })
    .then((r) => r.data || null)
    .catch((e) => { if (e && e.status === 404) return null; throw e; });
