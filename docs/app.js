// DOTA MONEY v1 — fully client-side (static, works on GitHub Pages & as Telegram Mini App).

import { predict } from "./model.mjs";
import { analyzeMatchup, applyDraftAdjustment } from "./draft.mjs";
import { analyzeDraft } from "./live_draft.mjs";

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
let metaData = null;     // { heroes, synergy, counter }
let knowledge = null;    // { heroes: { [name]: {...} } }
let heroList = [];       // [{ id, name }] sorted, for the picker
let byId = new Map();
let byName = new Map();

async function loadData() {
  const [ds, up, dr, mt, kn] = await Promise.all([
    fetch("data/dataset.json").then((r) => r.json()),
    fetch("data/upcoming.json").then((r) => r.json()).catch(() => ({ matches: [] })),
    fetch("data/draft.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/meta.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/hero_knowledge.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  dataset = ds;
  upcoming = up;
  draftData = dr;
  metaData = mt;
  knowledge = kn;
  byId = new Map();
  byName = new Map();
  for (const t of dataset.teams) {
    byId.set(String(t.id), t);
    byName.set(t.name.toLowerCase(), t);
    if (t.tag) byName.set(String(t.tag).toLowerCase(), t);
  }
  heroList = metaData
    ? Object.entries(metaData.heroes)
        .map(([id, h]) => ({ id: Number(id), name: h.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
}

const heroName = (id) => (metaData && metaData.heroes[id] ? metaData.heroes[id].name : `Hero ${id}`);

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

function timingTag(t) {
  if (!t) return null;
  const avg = t.avgMin;
  let tag;
  if (avg <= 37) tag = "темповые";
  else if (avg >= 43) tag = "лейтовые";
  else tag = "универсалы";
  return { avg, tag, closesFast: t.closesFast, lateWr: t.long && t.long.wr, earlyWr: t.short && t.short.wr };
}

function styleLine(a, b) {
  const ta = timingTag(a.timing);
  const tb = timingTag(b.timing);
  if (!ta || !tb) return "";
  return `<div class="style-line">⏱ <b>${a.name}</b> ~${ta.avg}м · ${ta.tag} &nbsp;·&nbsp; <b>${b.name}</b> ~${tb.avg}м · ${tb.tag}</div>`;
}

function timingDetail(team) {
  const t = team.timing;
  if (!t) return "";
  const p = (x) => (x == null ? "—" : (x * 100).toFixed(0) + "%");
  const tag = timingTag(t);
  return `<div class="timing-detail">
    <div class="td-name">${team.name} · ~${t.avgMin} мин · <span class="hl">${tag.tag}</span>${t.closesFast === true ? " · закрывают быстро" : t.closesFast === false ? " · тянут в лейт" : ""}</div>
    <div class="td-buckets">
      <span>ранняя &lt;30м: <b>${p(t.short.wr)}</b> (${t.short.g})</span>
      <span>средняя 30-40м: <b>${p(t.mid.wr)}</b> (${t.mid.g})</span>
      <span>лейт &gt;40м: <b>${p(t.long.wr)}</b> (${t.long.g})</span>
    </div>
  </div>`;
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
      ${styleLine(a, b)}
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
      ${(aTeam.timing || bTeam.timing) ? `<div class="timing-block"><div class="tb-title">⏱ Стиль и темп</div>${timingDetail(aTeam)}${timingDetail(bTeam)}</div>` : ""}
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

// ---- Live draft tab ----
const live = { a: [], b: [], assignA: {}, assignB: {} };

function fillLiveTeams() {
  const opts = `<option value="">— без команды —</option>` +
    dataset.teams
      .filter((t) => t.games >= 3)
      .sort((a, b) => b.rating - a.rating)
      .map((t) => `<option value="${t.id}">${t.name} (${t.rating})</option>`)
      .join("");
  const a = document.getElementById("liveTeamA");
  const b = document.getElementById("liveTeamB");
  a.innerHTML = opts;
  b.innerHTML = opts;
}

function liveRosterFor(side) {
  const sel = document.getElementById(side === "a" ? "liveTeamA" : "liveTeamB");
  const dt = sel && sel.value ? draftTeam(sel.value) : null;
  return dt && dt.roster ? dt.roster : null;
}

function renderLivePicks(side) {
  const wrap = document.getElementById(side === "a" ? "livePicksA" : "livePicksB");
  const ids = live[side];
  const roster = liveRosterFor(side);
  const assign = side === "a" ? live.assignA : live.assignB;
  wrap.innerHTML = ids
    .map((id) => {
      let playerSel = "";
      if (roster && roster.length) {
        const opts = `<option value="">игрок…</option>` +
          roster.map((p, i) => `<option value="${i}"${assign[id] && assign[id].account_id === p.account_id ? " selected" : ""}>${p.name}</option>`).join("");
        playerSel = `<select class="pick-player" data-side="${side}" data-hero="${id}">${opts}</select>`;
      }
      return `<div class="pick-chip"><span class="pc-name">${heroName(id)}</span>${playerSel}<button class="pc-x" data-side="${side}" data-hero="${id}">×</button></div>`;
    })
    .join("") || `<div class="picks-empty">Пусто (0/5)</div>`;

  wrap.querySelectorAll(".pc-x").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.hero);
      live[side] = live[side].filter((x) => x !== id);
      delete (side === "a" ? live.assignA : live.assignB)[id];
      renderLivePicks(side);
    })
  );
  wrap.querySelectorAll(".pick-player").forEach((sel) =>
    sel.addEventListener("change", () => {
      const id = Number(sel.dataset.hero);
      const a = side === "a" ? live.assignA : live.assignB;
      if (sel.value === "") delete a[id];
      else a[id] = roster[Number(sel.value)];
    })
  );
}

function renderHeroDrop(side, query) {
  const drop = document.getElementById(side === "a" ? "liveDropA" : "liveDropB");
  const q = query.trim().toLowerCase();
  if (!q) { drop.innerHTML = ""; return; }
  const chosen = new Set([...live.a, ...live.b]);
  const matches = heroList.filter((h) => h.name.toLowerCase().includes(q) && !chosen.has(h.id)).slice(0, 10);
  drop.innerHTML = matches.map((h) => `<button class="hero-opt" data-side="${side}" data-hero="${h.id}">${h.name}</button>`).join("");
  drop.querySelectorAll(".hero-opt").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.hero);
      if (live[side].length >= 5 || live[side].includes(id)) return;
      live[side].push(id);
      const input = document.getElementById(side === "a" ? "liveSearchA" : "liveSearchB");
      input.value = "";
      drop.innerHTML = "";
      renderLivePicks(side);
    })
  );
}

function wireLiveTab() {
  if (!metaData) {
    document.getElementById("live-result").innerHTML =
      `<div class="loading">Мета-данные не собраны. Запусти: npm run build-meta</div>`;
  }
  fillLiveTeams();
  renderLivePicks("a");
  renderLivePicks("b");

  for (const side of ["a", "b"]) {
    const input = document.getElementById(side === "a" ? "liveSearchA" : "liveSearchB");
    input.addEventListener("input", () => renderHeroDrop(side, input.value));
    const teamSel = document.getElementById(side === "a" ? "liveTeamA" : "liveTeamB");
    teamSel.addEventListener("change", () => {
      const dt = teamSel.value ? draftTeam(teamSel.value) : null;
      const t = teamSel.value ? byId.get(teamSel.value) : null;
      const title = document.getElementById(side === "a" ? "liveTitleA" : "liveTitleB");
      title.textContent = (t ? t.name : side === "a" ? "Команда A" : "Команда B") + (side === "a" ? " · Radiant" : " · Dire");
      if (side === "a") live.assignA = {}; else live.assignB = {};
      renderLivePicks(side);
      if (teamSel.value && !dt) {
        // Team has no draft roster data — player assignment unavailable.
      }
    });
  }
  document.getElementById("liveBtn").addEventListener("click", runLiveAnalysis);
  document.getElementById("liveClear").addEventListener("click", () => {
    live.a = []; live.b = []; live.assignA = {}; live.assignB = {};
    renderLivePicks("a"); renderLivePicks("b");
    document.getElementById("live-result").innerHTML = "";
  });
}

function curveBars(curves, label) {
  const row = (name, v) => `<div class="cv-row"><span class="cv-lbl">${name}</span><div class="cv-track"><div class="cv-fill" style="width:${Math.round(v * 100)}%"></div></div><span class="cv-val">${(v * 100).toFixed(0)}%</span></div>`;
  return `<div class="curve-block"><div class="cv-title">${label}</div>${row("ранняя", curves.early)}${row("средняя", curves.mid)}${row("лейт", curves.late)}</div>`;
}

function confBadge(conf) {
  const cls = conf.label === "высокая" ? "value" : conf.label === "средняя" ? "small" : "novalue";
  return `<div class="badge ${cls}">Уверенность: ${conf.label} (${(conf.value * 100).toFixed(0)}%)</div>`;
}

function runLiveAnalysis() {
  const out = document.getElementById("live-result");
  if (!metaData) { out.innerHTML = `<div class="loading">Нет мета-данных (build-meta).</div>`; return; }
  if (live.a.length < 2 || live.b.length < 2) {
    out.innerHTML = `<div class="loading">Добавь хотя бы по 2 героя в каждую команду (лучше по 5).</div>`;
    return;
  }
  const teamAId = document.getElementById("liveTeamA").value;
  const teamBId = document.getElementById("liveTeamB").value;
  const tA = teamAId ? byId.get(teamAId) : null;
  const tB = teamBId ? byId.get(teamBId) : null;
  const nameA = tA ? tA.name : "Команда A";
  const nameB = tB ? tB.name : "Команда B";
  const format = document.getElementById("liveFormat").value;

  const ctx = {
    meta: metaData,
    knowledge: knowledge || { heroes: {} },
    assignA: Object.keys(live.assignA).length ? live.assignA : null,
    assignB: Object.keys(live.assignB).length ? live.assignB : null,
    teamsElo: tA && tB ? { a: { rating: tA.rating, games: tA.games }, b: { rating: tB.rating, games: tB.games } } : null,
    nameA, nameB, heroName, format,
  };
  const res = analyzeDraft(live.a, live.b, ctx);
  const p = res.perGameA;

  const bullets = res.explanation.bullets
    .map((x) => `<div class="rz-bullet"><span class="rz-icon">${x.icon}</span><span>${x.text}</span></div>`)
    .join("");

  const eloLine = res.eloProbA != null
    ? `<div class="kv"><span>База по Elo → с драфтом</span><span>${pct(res.eloProbA)} → ${pct(p)}</span></div>`
    : `<div class="kv"><span>Прогноз по драфту (без Elo)</span><span>${pct(p)}</span></div>`;

  out.innerHTML = `
    <div class="result-block">
      <div class="match-teams">
        <div class="team"><div><div class="team-name">${nameA}</div><div class="team-rating">${live.a.length} героев</div></div></div>
        <span class="vs-mid">VS</span>
        <div class="team right"><div><div class="team-name">${nameB}</div><div class="team-rating">${live.b.length} героев</div></div></div>
      </div>
      ${probBar(p)}
      ${eloLine}
      <div class="kv"><span>Серия (${format.toUpperCase()})</span><span>${pct(res.seriesA)} / ${pct(1 - res.seriesA)}</span></div>
      <div style="margin:10px 0">${confBadge(res.confidence)}</div>
      <div class="curves-wrap">
        ${curveBars(res.score.curves.a, nameA + " — кривая силы")}
        ${curveBars(res.score.curves.b, nameB + " — кривая силы")}
      </div>
      <div class="rz-title">Разбор</div>
      <div class="reasoning">${bullets || '<div class="threat-empty">Явных перекосов не найдено — матчап близкий.</div>'}</div>
      <div class="disclaimer">Прогноз по драфту (потолок ~65%). Точность 80–90%+ будет на след. этапе — по экономике первых 10 минут.</div>
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
    wireLiveTab();
    document.getElementById("calcBtn").addEventListener("click", runCalc);
    document.getElementById("draftBtn").addEventListener("click", runDraftAnalysis);
  } catch (e) {
    document.getElementById("meta").textContent = "Ошибка загрузки данных. Запусти npm run build-data.";
    document.getElementById("matches-list").innerHTML = `<div class="loading">Нет данных: ${e.message}</div>`;
  }
}
init();
