// DOTA MONEY v1 — fully client-side (static, works on GitHub Pages & as Telegram Mini App).

import { predict } from "./model.mjs";
import { analyzeMatchup, applyDraftAdjustment } from "./draft.mjs";

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
let draftData = null;    // { heroes, teams: { [id]: {...} } }
let byId = new Map();
let byName = new Map();

async function loadData() {
  const [ds, up, dr] = await Promise.all([
    fetch("data/dataset.json").then((r) => r.json()),
    fetch("data/upcoming.json").then((r) => r.json()).catch(() => ({ matches: [] })),
    fetch("data/draft.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  dataset = ds;
  upcoming = up;
  draftData = dr;
  byId = new Map();
  byName = new Map();
  for (const t of dataset.teams) {
    byId.set(String(t.id), t);
    byName.set(t.name.toLowerCase(), t);
    if (t.tag) byName.set(String(t.tag).toLowerCase(), t);
  }
}

function draftTeam(id) {
  if (!draftData || !draftData.teams) return null;
  return draftData.teams[String(id)] || null;
}

// Elo prediction, adjusted by draft/hero-pool analysis when data is available for both teams.
function predictFull(aTeam, bTeam, opts) {
  const base = predict(aTeam, bTeam, opts);
  const dA = draftTeam(aTeam.id);
  const dB = draftTeam(bTeam.id);
  if (dA && dB && dA.roster && dA.roster.length && dB.roster && dB.roster.length) {
    const analysis = analyzeMatchup(dA, dB);
    return applyDraftAdjustment(base, analysis, (opts && opts.format) || "bo3");
  }
  return base;
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

function draftNote(prediction, nameA, nameB) {
  const d = prediction.draft;
  if (!d || !d.applied) return "";
  const delta = d.deltaPerGameA;
  if (Math.abs(delta) < 0.005) {
    return `<div class="draft-note neutral">🎲 Драфт: пулы примерно равны, корректировки нет</div>`;
  }
  const favored = delta > 0 ? nameA : nameB;
  const exposed = delta > 0 ? nameB : nameA;
  const shift = Math.abs(delta * 100).toFixed(1);
  return `<div class="draft-note">🎲 Драфт в пользу <b>${favored}</b>: пул ${exposed} читается/контрится (${shift}% к шансу за игру). Детали — во вкладке «Драфт».</div>`;
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
    const p = predictFull(a, b, { format: m.format || "bo3", oddsA: m.oddsA, oddsB: m.oddsB });
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
      <div class="oddsrow"><span>Модель (серия)${p.draft ? " · с учётом драфта" : ""}</span><span></span></div>
      ${probBar(p.series.a)}
      ${market}
      ${draftNote(p, a.name, b.name)}
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
  const p = predictFull(aTeam, bTeam, { format, oddsA, oddsB });
  const market = p.market
    ? `<div class="kv"><span>Букмекер (без маржи)</span><span>${pct(p.market.impliedA)} / ${pct(p.market.impliedB)}</span></div>`
    : "";
  const draftRow = p.draft
    ? `<div class="kv"><span>За игру: Elo → с драфтом</span><span>${pct(p.draft.basePerGame.a)} → ${pct(p.perGame.a)}</span></div>`
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
      ${draftRow}
      ${market}
      <div class="kv"><span>Надёжность оценки</span><span>${pct(p.reliability)}</span></div>
      ${draftNote(p, aTeam.name, bTeam.name) ? `<div style="margin-top:10px">${draftNote(p, aTeam.name, bTeam.name)}</div>` : ""}
      <div style="margin-top:12px">${valueBadge(p)}</div>
    </div>`;
}

// ---- Draft tab ----
function fillDraftTeams() {
  const sel = document.getElementById("draftA");
  const selB = document.getElementById("draftB");
  if (!draftData || !draftData.teams) {
    document.getElementById("draft-result").innerHTML =
      `<div class="loading">Драфт-данные не собраны. Запусти: npm run build-draft</div>`;
    return;
  }
  const ids = Object.keys(draftData.teams);
  const teams = ids
    .map((id) => ({ id, name: draftData.teams[id].name, rating: (byId.get(id) || {}).rating || 0 }))
    .filter((t) => draftData.teams[t.id].roster && draftData.teams[t.id].roster.length)
    .sort((a, b) => b.rating - a.rating);
  const opts = teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  sel.innerHTML = opts;
  selB.innerHTML = opts;
  if (teams.length > 1) selB.selectedIndex = 1;
}

function exposureBar(exposureA, exposureB, nameA, nameB) {
  const total = exposureA + exposureB || 1;
  const a = Math.round((exposureA / total) * 100);
  return `<div class="oddsrow"><span>Уязвимость по драфту (больше = хуже)</span></div>
    <div class="probbar">
      <div class="a" style="width:${a}%">${(exposureA * 100).toFixed(0)}</div>
      <div class="b" style="width:${100 - a}%">${(exposureB * 100).toFixed(0)}</div>
    </div>`;
}

function threatBlock(title, threats, oppName) {
  if (!threats || !threats.length) {
    return `<div class="threat-group"><div class="threat-head">${title}</div><div class="threat-empty">Явных уязвимостей не найдено.</div></div>`;
  }
  const rows = threats.map((t) => {
    const heroes = t.threats.map((h) => {
      const counters = h.counters
        .filter((c) => c.wr <= 0.49)
        .slice(0, 3)
        .map((c) => `<span class="counter ${c.byOpp ? "byopp" : ""}">${c.name} ${(c.wr * 100).toFixed(0)}%${c.byOpp ? " ✓играет" : ""}</span>`)
        .join(" ");
      return `<div class="threat-hero"><b>${h.heroName}</b> <span class="muted">(вес ${(h.weight * 100).toFixed(0)}%, wr ${(h.wr * 100).toFixed(0)}%)</span><div class="counters">контрят: ${counters || "—"}</div></div>`;
    }).join("");
    return `<div class="threat-player"><div class="tp-name">${t.player}</div>${heroes}</div>`;
  }).join("");
  return `<div class="threat-group"><div class="threat-head">${title}</div><div class="threat-sub">✓играет = ${oppName} комфортно на этой контре</div>${rows}</div>`;
}

function runDraftAnalysis() {
  const out = document.getElementById("draft-result");
  const dA = draftTeam(document.getElementById("draftA").value);
  const dB = draftTeam(document.getElementById("draftB").value);
  if (!dA || !dB || dA.id === dB.id) {
    out.innerHTML = `<div class="loading">Выбери две разные команды.</div>`;
    return;
  }
  const an = analyzeMatchup(dA, dB);
  const favored = an.deltaPerGameA > 0 ? dA.name : dB.name;
  const shift = Math.abs(an.deltaPerGameA * 100).toFixed(1);
  const verdict = Math.abs(an.deltaPerGameA) < 0.005
    ? `<div class="badge novalue">Пулы примерно равны — драфт не даёт перевеса</div>`
    : `<div class="badge value">🎲 Драфт в пользу ${favored}: +${shift}% к шансу за игру</div>`;

  out.innerHTML = `
    <div class="result-block">
      <div class="match-teams">
        <div class="team"><div><div class="team-name">${dA.name}</div><div class="team-rating">уязвимость ${(dA.vulnerability * 100).toFixed(0)}</div></div></div>
        <span class="vs-mid">VS</span>
        <div class="team right"><div><div class="team-name">${dB.name}</div><div class="team-rating">уязвимость ${(dB.vulnerability * 100).toFixed(0)}</div></div></div>
      </div>
      ${exposureBar(an.exposureA, an.exposureB, dA.name, dB.name)}
      <div style="margin:10px 0">${verdict}</div>
      ${threatBlock(`Кого может наказать ${dB.name}`, an.threatsA, dB.name)}
      ${threatBlock(`Кого может наказать ${dA.name}`, an.threatsB, dA.name)}
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
    fillDraftTeams();
    document.getElementById("calcBtn").addEventListener("click", runCalc);
    document.getElementById("draftBtn").addEventListener("click", runDraftAnalysis);
  } catch (e) {
    document.getElementById("meta").textContent = "Ошибка загрузки данных. Запусти npm run build-data.";
    document.getElementById("matches-list").innerHTML = `<div class="loading">Нет данных: ${e.message}</div>`;
  }
}
init();
