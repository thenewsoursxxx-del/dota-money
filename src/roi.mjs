// Offline ROI reconciliation for the local bet journal.
// Export bets from the app (📒 Журнал → Экспорт JSON), drop the file here, then:
//   npm run roi            (uses ./dota-money-bets.json)
//   npm run roi -- path.json
// For each bet that carries a match_id we pull the real result from OpenDota,
// mark win/loss, and compute hit-rate + ROI using the odds recorded at bet time.
// The file is rewritten with results filled in, so re-runs only fetch new games.

import { readFile, writeFile } from "node:fs/promises";
import { getMatch } from "./opendota.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const path = process.argv[2] || "./dota-money-bets.json";

async function main() {
  let bets;
  try { bets = JSON.parse(await readFile(path, "utf8")); }
  catch (e) { console.error(`Не читается ${path}: ${e.message}\nЭкспортируй журнал из приложения и положи файл сюда.`); process.exit(1); }
  if (!Array.isArray(bets)) { console.error("Ожидался массив ставок."); process.exit(1); }

  let resolvedNow = 0, skipped = 0;
  for (const b of bets) {
    if (b.result === "win" || b.result === "loss") continue;
    if (!b.matchId) { skipped++; continue; } // calc bets w/o match id → set result manually
    try {
      const m = await getMatch(b.matchId);
      await sleep(300);
      if (typeof m.radiant_win !== "boolean") { skipped++; continue; } // not ingested yet
      // Determine which side our pick was on via team ids; fall back to A=radiant.
      const pickId = b.pick === "A" ? b.teamAId : b.teamBId;
      let pickWon;
      if (pickId && (pickId === m.radiant_team_id || pickId === m.dire_team_id)) {
        pickWon = pickId === m.radiant_team_id ? m.radiant_win : !m.radiant_win;
      } else {
        pickWon = b.pick === "A" ? m.radiant_win : !m.radiant_win;
      }
      b.result = pickWon ? "win" : "loss";
      resolvedNow++;
    } catch (e) { skipped++; }
  }

  await writeFile(path, JSON.stringify(bets, null, 2), "utf8");

  const settled = bets.filter((b) => b.result === "win" || b.result === "loss");
  const wins = settled.filter((b) => b.result === "win").length;
  const profit = settled.reduce((a, b) => a + (b.result === "win" ? b.oddsPick - 1 : -1), 0);
  const staked = settled.length; // 1 unit flat per bet
  const avgOdds = settled.length ? settled.reduce((a, b) => a + b.oddsPick, 0) / settled.length : 0;
  const avgProb = settled.length ? settled.reduce((a, b) => a + (b.pick === "A" ? b.probSeriesA : 1 - b.probSeriesA), 0) / settled.length : 0;

  console.log("\n================ ROI ЖУРНАЛА ================");
  console.log(`Всего записей:        ${bets.length}`);
  console.log(`Новых сверено:        ${resolvedNow}   Пропущено (нет id/не готово): ${skipped}`);
  console.log(`Рассчитано ставок:    ${settled.length}`);
  if (settled.length) {
    console.log(`Winrate:              ${((wins / settled.length) * 100).toFixed(1)}%  (${wins}/${settled.length})`);
    console.log(`Средняя оценка модели:${(avgProb * 100).toFixed(1)}%   Средний кэф: ${avgOdds.toFixed(2)}`);
    console.log(`Профит (флэт 1 ед.):  ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} ед.`);
    console.log(`ROI:                  ${((profit / staked) * 100).toFixed(1)}%   (>0 = бьём рынок)`);
  } else {
    console.log("Пока нечего считать — сделай ставки с кэфами (лучше из Live: там есть match_id) и запусти снова после игр.");
  }
  console.log("=============================================");
  console.log(`Файл обновлён: ${path}`);
}

main().catch((e) => { console.error("Ошибка ROI:", e); process.exit(1); });
