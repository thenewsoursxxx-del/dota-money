// Learn from the just-finished PVISION vs Yandex series without a full OpenDota rebuild.
// Updates Elo + form snapshots in dataset.json, appends 2 training rows to train.json,
// updates recentMatches. Then run: npm run train
//
// Usage: node src/patch_series.mjs

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eloExpected, ELO_K } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "docs", "data");

const PV = 9824702, YX = 9823272;
const MAPS = [
  { match_id: 8902338515, start_time: 1784382596, duration: 1869, radiant_win: true },  // PVISION won
  { match_id: 8902431810, start_time: 1784386380, duration: 3947, radiant_win: false }, // Yandex won
];

async function main() {
  const ds = JSON.parse(await readFile(join(DATA, "dataset.json"), "utf8"));
  const train = JSON.parse(await readFile(join(ROOT, "train.json"), "utf8"));
  const byId = new Map(ds.teams.map((t) => [Number(t.id), t]));
  const pv = byId.get(PV), yx = byId.get(YX);
  if (!pv || !yx) throw new Error("PVISION / Yandex not in dataset.teams");

  console.log("До серии:");
  console.log(`  PVISION Elo ${pv.rating} form10 ${pv.ml?.form10}`);
  console.log(`  Yandex  Elo ${yx.rating} form10 ${yx.ml?.form10}`);

  const haveRecent = new Set((ds.recentMatches || []).map((m) => m.match_id));
  if (MAPS.every((m) => haveRecent.has(m.match_id))) {
    console.log("Серия уже в recentMatches — пропускаю повторный патч Elo (чтобы не задвоить).");
    console.log("Можно просто: npm run train");
    return;
  }

  // Working Elo / form state (mutate copies of ml snapshots)
  let eloPv = pv.ml?.elo ?? pv.rating;
  let eloYx = yx.ml?.elo ?? yx.rating;
  // Approximate form update: treat each map as +1 game in last-10 window
  let formPv = pv.ml?.form10 ?? 0.5;
  let formYx = yx.ml?.form10 ?? 0.5;
  let form45Pv = pv.ml?.form45 ?? 0.5;
  let form45Yx = yx.ml?.form45 ?? 0.5;
  let actPv = pv.ml?.act ?? 0;
  let actYx = yx.ml?.act ?? 0;

  let addedRows = 0;
  for (const m of MAPS) {
    // Snapshot BEFORE the map (for training)
    const snapA = { elo: eloPv, form10: formPv, form45: form45Pv, act: actPv, rust: 0 };
    const snapB = { elo: eloYx, form10: formYx, form45: form45Yx, act: actYx, rust: 0 };
    const y = m.radiant_win ? 1 : 0; // radiant = PVISION

    train.rows.push({ t: m.start_time, a: snapA, b: snapB, y });
    addedRows++;

    // Elo update (radiant=PVISION, dire=Yandex)
    const exp = eloExpected(eloPv, eloYx);
    eloPv = eloPv + ELO_K * (y - exp);
    eloYx = eloYx + ELO_K * ((1 - y) - (1 - exp));

    // Soft form update toward outcome (≈ 1/10 weight into last-10)
    const alpha = 0.1;
    formPv = formPv * (1 - alpha) + y * alpha;
    formYx = formYx * (1 - alpha) + (1 - y) * alpha;
    form45Pv = form45Pv * (1 - alpha) + y * alpha;
    form45Yx = form45Yx * (1 - alpha) + (1 - y) * alpha;
    actPv++; actYx++;

    if (!haveRecent.has(m.match_id)) {
      ds.recentMatches = ds.recentMatches || [];
      ds.recentMatches.unshift({
        match_id: m.match_id,
        start_time: m.start_time,
        league: "Esports World Cup 2026",
        radiant: { id: PV, name: "PVISION" },
        dire: { id: YX, name: "Team Yandex" },
        radiant_win: m.radiant_win,
      });
      if (ds.recentMatches.length > 60) ds.recentMatches.length = 60;
    }
    console.log(`  map #${m.match_id}: ${m.radiant_win ? "PVISION" : "Yandex"} won → Elo PV ${Math.round(eloPv)} / YX ${Math.round(eloYx)}`);
  }

  const round3 = (x) => Number(Number(x).toFixed(3));
  pv.rating = Math.round(eloPv);
  yx.rating = Math.round(eloYx);
  pv.games = (pv.games || 0) + MAPS.length;
  yx.games = (yx.games || 0) + MAPS.length;
  pv.wins = (pv.wins || 0) + MAPS.filter((m) => m.radiant_win).length;
  yx.wins = (yx.wins || 0) + MAPS.filter((m) => !m.radiant_win).length;
  pv.losses = (pv.losses || 0) + MAPS.filter((m) => !m.radiant_win).length;
  yx.losses = (yx.losses || 0) + MAPS.filter((m) => m.radiant_win).length;
  pv.lastPlayed = yx.lastPlayed = MAPS[MAPS.length - 1].start_time;
  pv.ml = { elo: Math.round(eloPv), form10: round3(formPv), form45: round3(form45Pv), act: actPv, rust: 0 };
  yx.ml = { elo: Math.round(eloYx), form10: round3(formYx), form45: round3(form45Yx), act: actYx, rust: 0 };

  ds.teams.sort((a, b) => b.rating - a.rating);
  ds.generatedAt = new Date().toISOString();
  ds.matchesUsed = (ds.matchesUsed || 0) + MAPS.length;
  train.count = train.rows.length;
  train.generatedAt = ds.generatedAt;

  await writeFile(join(DATA, "dataset.json"), JSON.stringify(ds, null, 2), "utf8");
  await writeFile(join(ROOT, "train.json"), JSON.stringify(train), "utf8");

  console.log("\nПосле серии:");
  console.log(`  PVISION Elo ${pv.rating} form10 ${pv.ml.form10} (games ${pv.games})`);
  console.log(`  Yandex  Elo ${yx.rating} form10 ${yx.ml.form10} (games ${yx.games})`);
  console.log(`Добавлено training rows: ${addedRows}. train.json count=${train.count}`);
  console.log("Дальше: npm run train");
}

main().catch((e) => { console.error(e); process.exit(1); });
