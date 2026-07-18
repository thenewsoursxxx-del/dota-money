// DOTA MONEY v1 — fully client-side (static, works on GitHub Pages & as Telegram Mini App).

import { predict, fairImplied, valueForSide } from "./model.mjs";
import { analyzeMatchup, applyDraftAdjustment } from "./draft.mjs";
import { analyzeDraft } from "./live_draft.mjs";
import { predictML } from "./model_ml.mjs";

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
let stratzData = null;   // { heroes: { [id]: { overall, pos } } } — current-patch role winrates
let knowledge = null;    // { heroes: { [name]: {...} } }
let mlModel = null;      // trained logistic model (docs/data/model.json)
let heroList = [];       // [{ id, name }] sorted, for the picker
let byId = new Map();
let byName = new Map();

async function loadData() {
  const [ds, up, dr, mt, kn, ml, st] = await Promise.all([
    fetch("data/dataset.json").then((r) => r.json()),
    fetch("data/upcoming.json").then((r) => r.json()).catch(() => ({ matches: [] })),
    fetch("data/draft.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/meta.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/hero_knowledge.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/model.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("data/stratz.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  dataset = ds;
  upcoming = up;
  draftData = dr;
  metaData = mt;
  knowledge = kn;
  mlModel = ml;
  stratzData = st;
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

// Trained ML per-game probability (A wins) from the teams' current-form snapshots.
// Returns null when the model or a snapshot is missing → callers fall back to raw Elo.
function mlBaseProb(aTeam, bTeam) {
  if (!mlModel || !aTeam || !bTeam || !aTeam.ml || !bTeam.ml) return null;
  return predictML(mlModel, aTeam.ml, bTeam.ml);
}

// Prediction (ML when available, else Elo), adjusted by draft/hero-pool analysis for both teams.
function predictFull(aTeam, bTeam, opts) {
  const base = predict(aTeam, bTeam, { ...opts, pGameOverride: mlBaseProb(aTeam, bTeam) });
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

// OpenDota sometimes has several team_ids for the same org (rebrands/new entries),
// which shows up as duplicate names in the pickers. Collapse by name, keeping the
// entry that played most RECENTLY — that's the live org with the current roster
// (e.g. Nigma's active id vs the stale Miracle-era one). Games breaks ties.
function dedupeTeams(teams) {
  const best = new Map();
  for (const t of teams) {
    const key = String(t.name || "").trim().toLowerCase();
    const cur = best.get(key);
    const better = !cur
      || (t.lastPlayed || 0) > (cur.lastPlayed || 0)
      || ((t.lastPlayed || 0) === (cur.lastPlayed || 0) && (t.games || 0) > (cur.games || 0));
    if (better) best.set(key, t);
  }
  return [...best.values()];
}

// ---- Calculator ----
function fillCalcTeams() {
  const teams = dedupeTeams(dataset.teams.filter((t) => t.games >= 3));
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
  lastCalcCtx = { source: "calc", matchId: null, teamA: aTeam.name, teamB: bTeam.name, teamAId: aTeam.id, teamBId: bTeam.id, format, probSeriesA: p.series.a };
  const logBtn = oddsA && oddsB ? `<button class="logbet primary sm" data-src="calc">📝 Записать ставку</button>` : "";
  const market = p.market
    ? `<div class="kv"><span>Букмекер (без маржи)</span><span>${pct(p.market.impliedA)} / ${pct(p.market.impliedB)}</span></div>`
    : "";
  const baseName = mlModel ? "ML" : "Elo";
  const draftRow = p.draft
    ? `<div class="kv"><span>За игру: ${baseName} → с драфтом</span><span>${pct(p.draft.basePerGame.a)} → ${pct(p.perGame.a)}</span></div>`
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
      ${logBtn ? `<div style="margin-top:10px">${logBtn}</div>` : ""}
    </div>`;
}

// ---- Live draft tab ----
const live = { a: [], b: [], assignA: {}, assignB: {}, nameA: null, nameB: null };

function fillLiveTeams() {
  const opts = `<option value="">— без команды —</option>` +
    dedupeTeams(dataset.teams.filter((t) => t.games >= 3))
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
      stopLive();
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
      stopLive();
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

// ---- Auto-live via OpenDota /live (no key, CORS-friendly) ----
let liveGames = [];
let liveLoadedId = null;
let liveTimer = null;

function popcount(n) { let c = 0; n = n >>> 0; while (n) { c += n & 1; n >>>= 1; } return c; }
// building_state bitmask: radiant towers = bits 0-10, dire towers = bits 16-26 (set bit = standing).
function towersDown(state) {
  const s = Number(state) >>> 0;
  return { radiant: 11 - popcount(s & 0x7ff), dire: 11 - popcount((s >>> 16) & 0x7ff) };
}
function liveSetStatus(msg, cls = "") {
  const el = document.getElementById("liveStatus");
  if (el) { el.textContent = msg; el.className = "live-status" + (cls ? " " + cls : ""); }
}
function stopLive() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  liveLoadedId = null;
}

async function loadLiveMatches() {
  const box = document.getElementById("liveMatches");
  liveSetStatus("Загружаю live-матчи…");
  let games;
  try {
    const r = await fetch("https://api.opendota.com/api/live");
    if (!r.ok) throw new Error("HTTP " + r.status);
    games = await r.json();
  } catch (e) {
    liveSetStatus("Не удалось загрузить (сеть/CORS): " + e.message, "err");
    return;
  }
  const withHeroes = (g) => Array.isArray(g.players) && g.players.filter((p) => p.hero_id).length >= 6;
  // Pro (league) games first; fall back to top public games so the feature is usable 24/7.
  let list = games.filter((g) => g.league_id && withHeroes(g)).sort((a, b) => (b.sort_score || 0) - (a.sort_score || 0));
  let mode = "pro";
  if (!list.length) {
    list = games.filter(withHeroes).sort((a, b) => (b.average_mmr || 0) - (a.average_mmr || 0)).slice(0, 8);
    mode = "pub";
  }
  liveGames = list;
  if (!list.length) { box.innerHTML = ""; liveSetStatus("Сейчас нет live-игр с драфтом. Попробуй во время матча.", "err"); return; }
  liveSetStatus(mode === "pro" ? `Про-матчей в эфире: ${list.length}` : `Про-матчей нет — топ-паблики (${list.length}) для теста`, mode === "pro" ? "ok" : "");
  box.innerHTML = list.map((g, i) => {
    const nameA = (g.team_name_radiant || "").trim() || (mode === "pub" ? `Radiant · ${g.average_mmr || "?"} MMR` : "Radiant");
    const nameB = (g.team_name_dire || "").trim() || "Dire";
    const min = Math.max(0, Math.floor((g.game_time || 0) / 60));
    const lead = g.radiant_lead || 0;
    const leadTxt = lead === 0 ? "нетворс ровно" : (lead > 0 ? nameA : nameB) + " +" + Math.abs(lead).toLocaleString("ru-RU");
    return `<button class="live-match-item" data-idx="${i}">
      <span class="lm-teams">${nameA} <b>vs</b> ${nameB}</span>
      <span class="lm-meta">${min}′ · ${g.radiant_score || 0}–${g.dire_score || 0} · ${leadTxt}</span>
    </button>`;
  }).join("");
  box.querySelectorAll(".live-match-item").forEach((btn) =>
    btn.addEventListener("click", () => applyLiveMatch(liveGames[Number(btn.dataset.idx)]))
  );
}

function autoAssign(teamId, sidePlayers) {
  const out = {};
  const dt = teamId && byId.has(teamId) ? draftTeam(teamId) : null;
  if (!dt || !dt.roster) return out;
  const byAcc = new Map(dt.roster.map((p) => [p.account_id, p]));
  for (const p of sidePlayers) {
    if (!p.hero_id) continue;
    const player = byAcc.get(p.account_id);
    if (player) out[p.hero_id] = player;
  }
  return out;
}

function applyLiveMatch(g, isRefresh = false) {
  if (!g) return;
  liveLoadedId = g.match_id;
  const idR = g.team_id_radiant ? String(g.team_id_radiant) : "";
  const idD = g.team_id_dire ? String(g.team_id_dire) : "";

  // Team selects (only if known in dataset → enables Elo + rosters). A = radiant, B = dire.
  document.getElementById("liveTeamA").value = byId.has(idR) ? idR : "";
  document.getElementById("liveTeamB").value = byId.has(idD) ? idD : "";

  live.nameA = (g.team_name_radiant || "").trim() || (byId.get(idR) || {}).name || "Radiant";
  live.nameB = (g.team_name_dire || "").trim() || (byId.get(idD) || {}).name || "Dire";
  document.getElementById("liveTitleA").textContent = live.nameA + " · Radiant";
  document.getElementById("liveTitleB").textContent = live.nameB + " · Dire";

  const rad = g.players.filter((p) => p.team === 0);
  const dire = g.players.filter((p) => p.team === 1);
  live.a = rad.filter((p) => p.hero_id).map((p) => p.hero_id).slice(0, 5);
  live.b = dire.filter((p) => p.hero_id).map((p) => p.hero_id).slice(0, 5);
  live.assignA = autoAssign(idR, rad);
  live.assignB = autoAssign(idD, dire);

  // Live economy → early-game inputs. radiant_lead = radiant − dire networth.
  const tw = towersDown(g.building_state);
  document.getElementById("egNw").value = g.radiant_lead || 0;
  document.getElementById("egXp").value = "";
  document.getElementById("egTowersA").value = tw.dire;     // A(radiant) destroyed = dire towers down
  document.getElementById("egTowersB").value = tw.radiant;
  document.getElementById("egFb").value = "";

  renderLivePicks("a");
  renderLivePicks("b");
  runLiveAnalysis();

  const min = Math.max(0, Math.floor((g.game_time || 0) / 60));
  liveSetStatus(`${live.nameA} vs ${live.nameB} · ${min}′ · нетворс ${(g.radiant_lead || 0) >= 0 ? "+" : ""}${(g.radiant_lead || 0).toLocaleString("ru-RU")} (Radiant) ${isRefresh ? "· обновлено" : "· загружен"}`, "ok");

  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (document.getElementById("liveAuto").checked) liveTimer = setInterval(refreshLive, 20000);
}

async function refreshLive() {
  if (!liveLoadedId) return;
  let games;
  try { games = await (await fetch("https://api.opendota.com/api/live")).json(); }
  catch { return; }
  const g = games.find((x) => x.match_id === liveLoadedId);
  if (!g) {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    liveSetStatus("Матч завершён или пропал из эфира — авто-обновление остановлено.", "");
    return;
  }
  applyLiveMatch(g, true);
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
      stopLive();
      const t = teamSel.value ? byId.get(teamSel.value) : null;
      const title = document.getElementById(side === "a" ? "liveTitleA" : "liveTitleB");
      title.textContent = (t ? t.name : side === "a" ? "Команда A" : "Команда B") + (side === "a" ? " · Radiant" : " · Dire");
      if (side === "a") { live.assignA = {}; live.nameA = null; } else { live.assignB = {}; live.nameB = null; }
      renderLivePicks(side);
    });
  }
  document.getElementById("liveLoadBtn").addEventListener("click", loadLiveMatches);
  document.getElementById("liveAuto").addEventListener("change", (e) => {
    if (!e.target.checked) { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
    else if (liveLoadedId) liveTimer = setInterval(refreshLive, 20000);
  });
  document.getElementById("liveBtn").addEventListener("click", runLiveAnalysis);
  document.getElementById("liveClear").addEventListener("click", () => {
    stopLive();
    live.a = []; live.b = []; live.assignA = {}; live.assignB = {}; live.nameA = null; live.nameB = null;
    renderLivePicks("a"); renderLivePicks("b");
    document.getElementById("live-result").innerHTML = "";
    document.getElementById("liveMatches").innerHTML = "";
    liveSetStatus("");
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

// Compare our series probability to bookmaker odds → value / EV / Kelly.
function valueBlock(pA, nameA, nameB, oddsA, oddsB) {
  const oA = Number(oddsA), oB = Number(oddsB);
  if (!(oA > 1) || !(oB > 1)) return "";
  const fair = fairImplied(oA, oB);
  const vA = valueForSide(pA, oA);
  const vB = valueForSide(1 - pA, oB);
  const cand = [];
  if (vA && vA.ev > 0) cand.push({ side: nameA, ...vA });
  if (vB && vB.ev > 0) cand.push({ side: nameB, ...vB });
  cand.sort((x, y) => y.ev - x.ev);
  const best = cand[0];
  const rec = !best
    ? `<div class="badge novalue">Value нет — кэфы уже учитывают перевес</div>`
    : best.ev >= 0.05
    ? `<div class="badge value">VALUE: ${best.side} @ ${best.odds} · EV +${(best.ev * 100).toFixed(1)}% · Kelly ${(best.kelly * 100).toFixed(1)}%</div>`
    : `<div class="badge small">Лёгкий перевес: ${best.side} (EV +${(best.ev * 100).toFixed(1)}%), но ниже порога 5%</div>`;
  return `
    <div class="kv"><span>Кэфы → честная вер-ть (без вига)</span><span>${fair ? pct(fair.a) + " / " + pct(fair.b) : "—"}</span></div>
    <div style="margin:8px 0">${rec}</div>
    <div style="margin:8px 0"><button class="logbet primary sm" data-src="live">📝 Записать ставку</button></div>`;
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
  const nameA = live.nameA || (tA ? tA.name : "Команда A");
  const nameB = live.nameB || (tB ? tB.name : "Команда B");
  const format = document.getElementById("liveFormat").value;

  const eg = {
    nwDiff: document.getElementById("egNw").value,
    xpDiff: document.getElementById("egXp").value,
    towersA: document.getElementById("egTowersA").value,
    towersB: document.getElementById("egTowersB").value,
    firstBlood: document.getElementById("egFb").value,
  };
  const ctx = {
    meta: metaData,
    stratz: stratzData,
    knowledge: knowledge || { heroes: {} },
    assignA: Object.keys(live.assignA).length ? live.assignA : null,
    assignB: Object.keys(live.assignB).length ? live.assignB : null,
    teamsElo: tA && tB ? { a: { rating: tA.rating, games: tA.games }, b: { rating: tB.rating, games: tB.games } } : null,
    baseProbA: mlBaseProb(tA, tB),
    earlyGame: eg,
    nameA, nameB, heroName, format,
  };
  const res = analyzeDraft(live.a, live.b, ctx);
  const p = res.perGameA;
  lastLiveCtx = { source: "live", matchId: liveLoadedId || null, teamA: nameA, teamB: nameB, teamAId: teamAId || null, teamBId: teamBId || null, format, probSeriesA: res.seriesA };

  const bullets = res.explanation.bullets
    .map((x) => `<div class="rz-bullet"><span class="rz-icon">${x.icon}</span><span>${x.text}</span></div>`)
    .join("");

  const baseLabel = mlModel ? "База (ML-модель) → с драфтом" : "База по Elo → с драфтом";
  const eloLine = res.eloProbA != null
    ? `<div class="kv"><span>${baseLabel}</span><span>${pct(res.eloProbA)} → ${pct(res.priorProbA)}</span></div>`
    : `<div class="kv"><span>Прогноз по драфту (без базы)</span><span>${pct(res.priorProbA)}</span></div>`;
  const egLabel = liveLoadedId ? "+ экономика игры (live)" : "+ ранняя игра (~10 мин)";
  const earlyLine = res.early
    ? `<div class="kv hl-row"><span>${egLabel}</span><span><b>${pct(res.priorProbA)} → ${pct(p)}</b></span></div>`
    : "";

  out.innerHTML = `
    <div class="result-block">
      <div class="match-teams">
        <div class="team"><div><div class="team-name">${nameA}</div><div class="team-rating">${live.a.length} героев</div></div></div>
        <span class="vs-mid">VS</span>
        <div class="team right"><div><div class="team-name">${nameB}</div><div class="team-rating">${live.b.length} героев</div></div></div>
      </div>
      ${probBar(p)}
      ${eloLine}
      ${earlyLine}
      <div class="kv"><span>Серия (${format.toUpperCase()})</span><span>${pct(res.seriesA)} / ${pct(1 - res.seriesA)}</span></div>
      <div style="margin:10px 0">${confBadge(res.confidence)}</div>
      ${valueBlock(res.seriesA, nameA, nameB, document.getElementById("liveOddsA").value, document.getElementById("liveOddsB").value)}
      <div class="curves-wrap">
        ${curveBars(res.score.curves.a, nameA + " — кривая силы")}
        ${curveBars(res.score.curves.b, nameB + " — кривая силы")}
      </div>
      <div class="rz-title">Разбор</div>
      <div class="reasoning">${bullets || '<div class="threat-empty">Явных перекосов не найдено — матчап близкий.</div>'}</div>
      <div class="disclaimer">${res.early
        ? "Учтена экономика игры (нетворс/вышки) — самый сильный сигнал, прогноз близок к реальному состоянию матча."
        : "Прогноз по драфту (потолок ~65%). Загрузи live-матч или заполни экономику ~10 мин для точности 80–90%."}</div>
    </div>`;
}

// ---- Bet journal (local, for future ROI) ----
const BET_KEY = "dm_bets_v1";
let lastLiveCtx = null; // { source, matchId, teamA, teamB, teamAId, teamBId, format, probSeriesA }
let lastCalcCtx = null;

function loadBets() {
  try { return JSON.parse(localStorage.getItem(BET_KEY)) || []; } catch { return []; }
}
function saveBets(arr) { localStorage.setItem(BET_KEY, JSON.stringify(arr)); }

function makeBet(ctx, oddsA, oddsB) {
  const oA = Number(oddsA), oB = Number(oddsB);
  if (!ctx || !(oA > 1) || !(oB > 1)) return null;
  const pA = ctx.probSeriesA, pB = 1 - pA;
  const evA = pA * oA - 1, evB = pB * oB - 1;
  const pickA = evA >= evB;
  return {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
    source: ctx.source,
    matchId: ctx.matchId || null,
    teamA: ctx.teamA, teamB: ctx.teamB,
    teamAId: ctx.teamAId || null, teamBId: ctx.teamBId || null,
    format: ctx.format,
    probSeriesA: Number(pA.toFixed(4)),
    oddsA: oA, oddsB: oB,
    pick: pickA ? "A" : "B",
    pickTeam: pickA ? ctx.teamA : ctx.teamB,
    oddsPick: pickA ? oA : oB,
    ev: Number((pickA ? evA : evB).toFixed(4)),
    result: null, // 'win' | 'loss' — filled offline by npm run roi
  };
}

function logBet(ctx, oddsA, oddsB) {
  const bet = makeBet(ctx, oddsA, oddsB);
  if (!bet) { alert("Впиши корректные кэфы (оба > 1) перед записью."); return; }
  const arr = loadBets();
  arr.unshift(bet);
  saveBets(arr);
  renderJournal();
  const box = document.querySelector(".journal-box");
  if (box) box.open = true;
}

function renderJournal() {
  const list = document.getElementById("journal-list");
  const countEl = document.getElementById("journalCount");
  const arr = loadBets();
  if (countEl) countEl.textContent = arr.length;
  if (!list) return;
  if (!arr.length) { list.innerHTML = `<div class="threat-empty">Пусто. Записанные ставки появятся тут.</div>`; return; }
  list.innerHTML = arr.map((b) => {
    const res = b.result === "win" ? `<span class="jr-win">✓ выигрыш</span>` : b.result === "loss" ? `<span class="jr-loss">✗ проигрыш</span>` : `<span class="jr-open">ожидает</span>`;
    const d = new Date(b.ts).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    return `<div class="journal-item">
      <div class="ji-top"><b>${b.pickTeam}</b> @ ${b.oddsPick} <span class="muted">(EV +${(b.ev * 100).toFixed(1)}%)</span> ${res}</div>
      <div class="ji-sub muted">${b.teamA} vs ${b.teamB} · ${b.format.toUpperCase()} · ${d}${b.matchId ? " · #" + b.matchId : ""}</div>
      <button class="ji-del" data-id="${b.id}">×</button>
    </div>`;
  }).join("");
  list.querySelectorAll(".ji-del").forEach((btn) =>
    btn.addEventListener("click", () => { saveBets(loadBets().filter((x) => x.id !== btn.dataset.id)); renderJournal(); })
  );
}

function exportBets() {
  const blob = new Blob([JSON.stringify(loadBets(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "dota-money-bets.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importBets(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!Array.isArray(incoming)) throw new Error("не массив");
      const byId = new Map(loadBets().map((b) => [b.id, b]));
      for (const b of incoming) if (b && b.id) byId.set(b.id, b);
      saveBets([...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1)));
      renderJournal();
    } catch (e) { alert("Не удалось импортировать JSON: " + e.message); }
  };
  reader.readAsText(file);
}

// Delegated handler for "Записать ставку" buttons in either tab.
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".logbet");
  if (!btn) return;
  if (btn.dataset.src === "live") {
    logBet(lastLiveCtx, document.getElementById("liveOddsA").value, document.getElementById("liveOddsB").value);
  } else {
    logBet(lastCalcCtx, document.getElementById("oddsA").value, document.getElementById("oddsB").value);
  }
});

// ---- Init ----
async function init() {
  try {
    await loadData();
    renderMeta();
    renderMatches();
    renderRatings();
    fillCalcTeams();
    wireLiveTab();
    renderJournal();
    document.getElementById("calcBtn").addEventListener("click", runCalc);
    document.getElementById("journalExport").addEventListener("click", exportBets);
    document.getElementById("journalClear").addEventListener("click", () => {
      if (confirm("Очистить весь журнал ставок?")) { saveBets([]); renderJournal(); }
    });
    document.getElementById("journalImport").addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) importBets(e.target.files[0]);
    });
  } catch (e) {
    document.getElementById("meta").textContent = "Ошибка загрузки данных. Запусти npm run build-data.";
    document.getElementById("matches-list").innerHTML = `<div class="loading">Нет данных: ${e.message}</div>`;
  }
}
init();
