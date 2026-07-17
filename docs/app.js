// DOTA MONEY v1 — fully client-side (static, works on GitHub Pages & as Telegram Mini App).

import { predict } from "./model.mjs";

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }

const pct = (x) => (x * 100).toFixed(1) + "%";
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

// ---- State ----
let dataset = null;      // { teams, recentMatches, ... }
let upcoming = null;     // { matches }
let byId = new Map();
let byName = new Map();

async function loadData() {
  const [ds, up] = await Promise.all([
    fetch("data/dataset.json").then((r) => r.json()),
    fetch("data/upcoming.json").then((r) => r.json()).catch(() => ({ matches: [] })),
  ]);
  dataset = ds;
  upcoming = up;
  byId = new Map();
  byName = new Map();
  for (const t of dataset.teams) {
    byId.set(String(t.id), t);
    byName.set(t.name.toLowerCase(), t);
    if (t.tag) byName.set(String(t.tag).toLowerCase(), t);
  }
}

function resolveTeam(key) {
  if (key == null) return null;
  const s = String(key).trim();
  return byId.get(s) || byName.get(s.toLowerCase()) || null;
}

// ---- Tabs ----
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---- Rendering helpers ----
function valueBadge(prediction) {
  if (!prediction.value) {
    return `<div class="badge novalue">Кэфы не заданы — value не рассчитан</div>`;
  }
  const rec = prediction.value.recommendation;
  if (rec.bet) {
    return `<div class="badge value">✅ VALUE на ${rec.team} · EV +${(rec.ev * 100).toFixed(1)}% · Kelly ${(rec.kelly * 100).toFixed(1)}%</div>`;
  }
  if (rec.side) {
    return `<div class="badge small">Небольшой перевес на ${rec.team} (EV +${(rec.ev * 100).toFixed(1)}%), ниже порога 5%</div>`;
  }
  return `<div class="badge novalue">Нет value — кэф справедлив или занижен</div>`;
}

function probBar(pa) {
  const a = Math.round(pa * 100);
  const b = 100 - a;
  return `<div class="probbar">
    <div class="a" style="width:${a}%">${a}%</div>
    <div class="b" style="width:${b}%">${b}%</div>
  </div>`;
}

function teamCell(team, right) {
  const logo = team.logo ? `<img src="${team.logo}" alt="" onerror="this.style.display='none'"/>` : "";
  const inner = `<div><div class="team-name">${team.name}</div><div class="team-rating">Elo ${team.rating} · ${team.games} игр</div></div>`;
  return `<div class="team ${right ? "right" : ""}">${right ? inner + logo : logo + inner}</div>`;
}

// ---- Meta ----
function renderMeta() {
  const when = new Date(dataset.generatedAt).toLocaleString("ru-RU");
  document.getElementById("meta").textContent =
    `${dataset.teams.length} команд · ${dataset.matchesUsed} Tier-1 матчей в модели · обновлено ${when}`;
  document.getElementById("foot-meta").textContent = `${dataset.matchesUsed} матчей`;
}

// ---- Matches ----
function renderMatches() {
  const el = document.getElementById("matches-list");
  const list = (upcoming.matches || []);
  if (!list.length) { el.innerHTML = `<div class="loading">Нет запланированных матчей. Добавь их в data/upcoming.json</div>`; return; }

  el.innerHTML = list.map((m) => {
    const a = resolveTeam(m.teamA);
    const b = resolveTeam(m.teamB);
    if (!a || !b) {
      return `<div class="card"><div class="card-top"><span class="card-event">${m.event || ""}</span><span class="card-date">${fmtDate(m.date)}</span></div>
        <div class="loading">Команды не найдены в данных: ${m.teamA} vs ${m.teamB}</div></div>`;
    }
    const p = predict(a, b, { format: m.format || "bo3", oddsA: m.oddsA, oddsB: m.oddsB });
    const market = p.market
      ? `<div class="oddsrow"><span>Кэф: <b>${m.oddsA}</b> / <b>${m.oddsB}</b></span><span>Букмекер: <b>${pct(p.market.impliedA)}</b> / <b>${pct(p.market.impliedB)}</b></span></div>`
      : "";
    return `<div class="card">
      <div class="card-top"><span class="card-event">${m.event || ""} · ${(m.format || "bo3").toUpperCase()}</span><span class="card-date">${fmtDate(m.date)}</span></div>
      <div class="match-teams">
        ${teamCell(a, false)}
        <span class="vs-mid">VS</span>
        ${teamCell(b, true)}
      </div>
      <div class="oddsrow"><span>Модель (серия)</span><span></span></div>
      ${probBar(p.series.a)}
      ${market}
      ${valueBadge(p)}
    </div>`;
  }).join("");
}

// ---- Ratings ----
function renderRatings() {
  const el = document.getElementById("ratings-list");
  const teams = dataset.teams.filter((t) => t.games >= 3).slice(0, 40);
  el.innerHTML = teams.map((t, i) => `
    <div class="rating-row">
      <div class="rating-rank">${i + 1}</div>
      <div class="rating-name">${t.name}</div>
      <div class="rating-val">${t.rating}</div>
      <div class="rating-games">${t.games} игр</div>
    </div>`).join("");
}

// ---- Calculator ----
function fillCalcTeams() {
  const teams = dataset.teams.filter((t) => t.games >= 3);
  const opts = teams.map((t) => `<option value="${t.id}">${t.name} (${t.rating})</option>`).join("");
  const a = document.getElementById("teamA");
  const b = document.getElementById("teamB");
  a.innerHTML = opts;
  b.innerHTML = opts;
  if (teams.length > 1) b.selectedIndex = 1;
}

function runCalc() {
  const aTeam = resolveTeam(document.getElementById("teamA").value);
  const bTeam = resolveTeam(document.getElementById("teamB").value);
  const format = document.getElementById("format").value;
  const oddsA = parseFloat(document.getElementById("oddsA").value) || null;
  const oddsB = parseFloat(document.getElementById("oddsB").value) || null;
  const out = document.getElementById("calc-result");
  if (!aTeam || !bTeam || aTeam.id === bTeam.id) {
    out.innerHTML = `<div class="loading">Выбери две разные команды.</div>`;
    return;
  }
  const p = predict(aTeam, bTeam, { format, oddsA, oddsB });
  const market = p.market
    ? `<div class="kv"><span>Букмекер (без маржи)</span><span>${pct(p.market.impliedA)} / ${pct(p.market.impliedB)}</span></div>`
    : "";
  out.innerHTML = `
    <div class="result-block">
      <div class="match-teams">
        ${teamCell(aTeam, false)}
        <span class="vs-mid">VS</span>
        ${teamCell(bTeam, true)}
      </div>
      ${probBar(p.series.a)}
      <div class="kv"><span>За игру (BO1)</span><span>${pct(p.perGame.a)} / ${pct(p.perGame.b)}</span></div>
      <div class="kv"><span>Серия (${p.format.toUpperCase()})</span><span>${pct(p.series.a)} / ${pct(p.series.b)}</span></div>
      ${market}
      <div class="kv"><span>Надёжность оценки</span><span>${pct(p.reliability)}</span></div>
      <div style="margin-top:12px">${valueBadge(p)}</div>
    </div>`;
}

// ---- Init ----
async function init() {
  try {
    await loadData();
    renderMeta();
    renderMatches();
    renderRatings();
    fillCalcTeams();
    document.getElementById("calcBtn").addEventListener("click", runCalc);
  } catch (e) {
    document.getElementById("meta").textContent = "Ошибка загрузки данных. Запусти npm run build-data.";
    document.getElementById("matches-list").innerHTML = `<div class="loading">Нет данных: ${e.message}</div>`;
  }
}
init();
