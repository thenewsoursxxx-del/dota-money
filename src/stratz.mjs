// Minimal STRATZ GraphQL client (https://api.stratz.com/graphql).
// Needs a free Bearer token: https://stratz.com/api  → export STRATZ_TOKEN=...
// STRATZ requires the token AND a User-Agent of "STRATZ_API" for API-scoped tokens.
// Rate limit ~7 req/s, 132 req/min — callers should pace with the exported sleep.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://api.stratz.com/graphql";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token from env, or a local gitignored `.stratz_token` file (so the secret never
// lands in shell history, commits, or CI logs).
export function stratzToken() {
  const env = (process.env.STRATZ_TOKEN || process.env.STRATZ_API_TOKEN || "").trim();
  if (env) return env;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    return readFileSync(join(root, ".stratz_token"), "utf8").trim();
  } catch { return ""; }
}

export async function stratzQuery(query, variables = {}, { retries = 3 } = {}) {
  const token = stratzToken();
  if (!token) throw new Error("STRATZ_TOKEN не задан. Получи бесплатный токен на https://stratz.com/api и запусти: $env:STRATZ_TOKEN=\"...\"");
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "STRATZ_API",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        throw new Error(`Stratz auth ${res.status}: токен неверный/без нужного scope. ${body.slice(0, 200)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Stratz HTTP ${res.status}: ${body.slice(0, 400)}`);
      }
      const json = await res.json();
      if (json.errors && json.errors.length) {
        throw new Error("Stratz GraphQL: " + json.errors.map((e) => e.message).join("; "));
      }
      return json.data;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}
