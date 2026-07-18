// Honest ROI backtest against the market. Answers the ONLY question that matters for betting:
//   does our pre-match model beat Pinnacle's CLOSING line, and would value-betting it profit?
//
// Leakage-free by construction: we walk matches in chronological order and, for each one,
// predict with a self-contained Elo built ONLY from earlier matches, then update Elo AFTER.
// The market prob is the devigged Pinnacle close; the actual winner is Pinnacle's settlement.
//
// Model here = simple series-level Elo (a fair pre-match proxy). The live app is stronger,
// but its edge lives in the first-10-min economy, which by definition can't be graded
// against a *pre-match* closing line. This measures the pre-game edge honestly.
//
// Run:  npm run backtest-odds
//   env EV_THRESHOLD=0.05  MIN_GAMES=5  KELLY_FRACTION=0.25  ELO_K=24

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fairImplied, valueForSide } from "../docs/model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "docs", "data");

const EV_THRESHOLD = Number(process.env.EV_THRESHOLD || 0.05);
const MIN_GAMES = Number(process.env.MIN_GAMES || 5);
const KELLY_FRACTION = Number(process.env.KELLY_FRACTION || 0.25);
const K = Number(process.env.ELO_K || 24);
const START = 1500;

const expected = (rA, rB) => 1 / (1 + Math.pow(10, (rB - rA) / 400));

async function main() {
  let odds;
  try {
    odds = JSON.parse(await readFile(join(DATA_DIR, "odds_history.json"), "utf8"));
  } catch {
    console.error("Нет docs/data/odds_history.json. Сначала собери кэфы: npm run build-odds");
    process.exit(1);
  }
  const all = (odds.matches || []).filter((m) => m.winner === "a" || m.winner === "b");
  all.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const skipped = (odds.matches || []).length - all.length;
  console.log(`Матчей с кэфами и известным исходом: ${all.length} (пропущено без исхода: ${skipped})\n`);
  if (all.length < 30) {
    console.warn("Мало данных для надёжного вывода — набери больше матчей (>~50).\n");
  }

  const rating = new Map();
  const played = new Map();
  const get = (id) => (rating.has(id) ? rating.get(id) : START);
  const gp = (id) => played.get(id) || 0;

  // Accumulators
  let n = 0;
  let mdlHit = 0, mktHit = 0;
  let mdlBrier = 0, mktBrier = 0, mdlLL = 0, mktLL = 0;
  const bet = { count: 0, win: 0, staked: 0, profit: 0, kStaked: 0, kProfit: 0 };
  const favBet = { count: 0, win: 0, staked: 0, profit: 0 }; // sanity: blindly bet market favorite
  const clamp = (p) => Math.min(0.999, Math.max(0.001, p));

  for (const m of all) {
    const idA = String(m.idA), idB = String(m.idB);
    const pModel = expected(get(idA), get(idB)); // P(A wins) — pre-match, no leakage
    const fair = fairImplied(m.oddsA, m.oddsB);
    const won = m.winner === "a" ? 1 : 0;
    const eligible = gp(idA) >= MIN_GAMES && gp(idB) >= MIN_GAMES && fair;

    if (eligible) {
      n++;
      const pMkt = fair.a;
      if ((pModel >= 0.5 ? 1 : 0) === won) mdlHit++;
      if ((pMkt >= 0.5 ? 1 : 0) === won) mktHit++;
      mdlBrier += (pModel - won) ** 2;
      mktBrier += (pMkt - won) ** 2;
      mdlLL += -(won * Math.log(clamp(pModel)) + (1 - won) * Math.log(clamp(1 - pModel)));
      mktLL += -(won * Math.log(clamp(pMkt)) + (1 - won) * Math.log(clamp(1 - pMkt)));

      // Value bet: pick the side with the best EV using MODEL prob vs the offered price.
      const vA = valueForSide(pModel, m.oddsA);
      const vB = valueForSide(1 - pModel, m.oddsB);
      const pick = (vA && vA.ev >= (vB ? vB.ev : -1)) ? { side: "a", v: vA, odds: m.oddsA }
                 : (vB ? { side: "b", v: vB, odds: m.oddsB } : null);
      if (pick && pick.v.ev >= EV_THRESHOLD) {
        const win = (pick.side === "a" ? won === 1 : won === 0);
        bet.count++; bet.staked += 1; if (win) { bet.win++; bet.profit += pick.odds - 1; } else bet.profit -= 1;
        const kFrac = Math.max(0, Math.min(1, pick.v.kelly)) * KELLY_FRACTION;
        bet.kStaked += kFrac; bet.kProfit += win ? kFrac * (pick.odds - 1) : -kFrac;
      }

      // Sanity baseline: always back the market favorite (should be ≈ break-even minus vig).
      const favSide = m.oddsA <= m.oddsB ? "a" : "b";
      const favOdds = favSide === "a" ? m.oddsA : m.oddsB;
      const favWin = favSide === "a" ? won === 1 : won === 0;
      favBet.count++; favBet.staked += 1; if (favWin) { favBet.win++; favBet.profit += favOdds - 1; } else favBet.profit -= 1;
    }

    // Update Elo with the series result (after predicting).
    const rA = get(idA), rB = get(idB), eA = expected(rA, rB);
    rating.set(idA, rA + K * (won - eA));
    rating.set(idB, rB + K * ((1 - won) - (1 - eA)));
    played.set(idA, gp(idA) + 1); played.set(idB, gp(idB) + 1);
  }

  if (!n) { console.log("После прогрева не осталось матчей для оценки. Уменьши MIN_GAMES или собери больше данных."); return; }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`Оценено матчей (после прогрева ≥${MIN_GAMES} серий у обеих команд): ${n}\n`);
  console.log("Точность и калибровка (кто угадывает исход лучше):");
  console.log(`  Accuracy:  модель ${pct(mdlHit / n)}   |   рынок ${pct(mktHit / n)}`);
  console.log(`  Brier:     модель ${(mdlBrier / n).toFixed(4)} |   рынок ${(mktBrier / n).toFixed(4)}  (меньше — лучше)`);
  console.log(`  LogLoss:   модель ${(mdlLL / n).toFixed(4)} |   рынок ${(mktLL / n).toFixed(4)}\n`);

  console.log(`Value-стратегия (ставим сторону с EV ≥ ${pct(EV_THRESHOLD)} по модели, кэф = Pinnacle close):`);
  if (bet.count) {
    console.log(`  Ставок: ${bet.count}  |  winrate ${pct(bet.win / bet.count)}`);
    console.log(`  Флэт 1ед:   прибыль ${bet.profit.toFixed(2)}ед   ROI ${pct(bet.profit / bet.staked)}`);
    console.log(`  Kelly×${KELLY_FRACTION}:   прибыль ${bet.kProfit.toFixed(2)}ед   ROI ${bet.kStaked ? pct(bet.kProfit / bet.kStaked) : "—"}`);
  } else {
    console.log("  Модель не нашла ни одной value-ставки против закрывающей линии Pinnacle.");
    console.log("  Это НОРМАЛЬНО: обыграть closing line очень трудно — она почти эффективна.");
  }
  console.log(`\nБейзлайн «всегда на фаворита рынка» (проверка на вменяемость):`);
  console.log(`  Ставок ${favBet.count}  winrate ${pct(favBet.win / favBet.count)}  ROI ${pct(favBet.profit / favBet.staked)}  (ожидаемо ≈ −vig)`);

  console.log(`\nВывод: если ROI value-стратегии стабильно > 0 на достаточной выборке (>100 ставок) —`);
  console.log(`у модели есть реальный перевес над рынком ДО игры. Если около нуля/минус —`);
  console.log(`перевес нужно искать в live (экономика первых 10 минут), а не в предматче.`);
}

main().catch((e) => { console.error("Ошибка:", e.message); process.exit(1); });
