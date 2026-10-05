(function () {
"use strict";

/* ============================================================
   Instellingen
   ============================================================ */
const cfg = window.GOLF_CONFIG || {};
const TEES = [
  { k: "MBT", long: "Men's back tees" },
  { k: "MWT", long: "Men's white tees" },
  { k: "MYT", long: "Men's yellow tees" }
];
const FORMULAS = { single: ["Single Matchplay"], double: ["4BBB", "High-Low", "Scramble"] };
const DEFAULT_PCT = { "Single Matchplay": 100, "4BBB": 90, "High-Low": 100, "Scramble": 100 };
const DEFAULT_TEE = "MWT";

const main = document.getElementById("main");
const statusEl = document.getElementById("status");
const accountEl = document.getElementById("account");
const tabsEl = document.getElementById("tabs");

let sb = null;            // Supabase-client
let session = null;       // huidige aanmelding
let channel = null;       // realtime-kanaal
let config = emptyConfig();
let day = emptyDay();
let loaded = false;
let pendingRender = false;
let armed = null;         // verwijderknop die op bevestiging wacht
let reloadTimer = null;
let loginSent = "";

/* ============================================================
   Hulpfuncties
   ============================================================ */
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function num(v) { if (v === "" || v === null || v === undefined) return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; }
function toNum(v) { if (v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
function fmt1(n) { return isNum(n) ? (Math.round(n * 10) / 10).toFixed(1).replace(".", ",") : "–"; }
function fmtHcp(n) { if (!isNum(n)) return "–"; return n < 0 ? "+" + fmt1(-n) : fmt1(n); }
function emptyConfig() { return { teams: [{ id: "a", name: "Team A", players: [] }, { id: "b", name: "Team B", players: [] }], courses: [] }; }
function emptyDay() { return { courseId: null, matches: [] }; }
function setStatus(msg, err) { statusEl.textContent = msg || ""; statusEl.classList.toggle("err", !!err); }

function team(id) { return config.teams.find(t => t.id === id); }
function allPlayers() { return config.teams.flatMap(t => t.players.map(p => ({ ...p, team: t.id }))); }
function playerById(id) { return allPlayers().find(p => p.id === id) || null; }
function courseById(id) { return config.courses.find(c => c.id === id) || null; }
function findPlayer(pid) { for (const t of config.teams) { const i = t.players.findIndex(p => p.id === pid); if (i >= 0) return { t, i, p: t.players[i] }; } return null; }
function findMatch(mid) { return day.matches.find(m => m.id === mid); }

/* ============================================================
   Opstart & aanmelden
   ============================================================ */
function isConfigured() {
  return cfg.supabaseUrl && cfg.supabaseAnonKey && !/JOUW-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);
}

async function start() {
  window.addEventListener("hashchange", () => { armed = null; render(); window.scrollTo(0, 0); });
  if (!window.supabase || !isConfigured()) { renderSetup(); return; }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_event, s) => {
    const was = !!session;
    session = s;
    if (!!s !== was) s ? onSignedIn() : onSignedOut();
  });
  session ? onSignedIn() : onSignedOut();
}

async function onSignedIn() {
  // Ruim de tokens uit de adresbalk op na het klikken op de inloglink.
  if (/access_token|refresh_token|type=/.test(location.hash)) history.replaceState(null, "", location.pathname + "#wedstrijden");
  tabsEl.hidden = false;
  renderAccount();
  setStatus("Gegevens laden…");
  await loadAll();
  if (!channel) {
    channel = sb.channel("golf-changes")
      .on("postgres_changes", { event: "*", schema: "public" }, () => scheduleReload())
      .subscribe();
  }
}

function onSignedOut() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  loaded = false; config = emptyConfig(); day = emptyDay();
  tabsEl.hidden = true;
  renderAccount();
  setStatus("");
  renderLogin();
}

function renderAccount() {
  accountEl.innerHTML = session
    ? `<span>${esc(session.user.email || "")}</span><button class="btn ghost" id="logout">Afmelden</button>`
    : "";
  const b = document.getElementById("logout");
  if (b) b.addEventListener("click", () => sb.auth.signOut());
}

function renderSetup() {
  tabsEl.hidden = true;
  main.innerHTML = `<h2>Nog niet gekoppeld</h2>
  <div class="panel"><p style="margin:0 0 8px">Deze site is nog niet verbonden met een Supabase-project.</p>
  <p class="note">Vul in <code>config.js</code> de project-URL en de anon/publishable key van je Supabase-project in. Je vindt ze in Supabase onder Project Settings → API. Zie ook de README.</p></div>`;
}

function renderLogin() {
  main.innerHTML = `<h2>Aanmelden</h2>
  <p class="help">Vul je e-mailadres in. Je krijgt een link waarmee je meteen bent aangemeld. Alleen uitgenodigde spelers hebben toegang.</p>
  <div class="panel login">
    ${loginSent
      ? `<p style="margin:0">De inloglink is verstuurd naar <strong>${esc(loginSent)}</strong>. Open de mail op dit toestel en klik op de link.</p>
         <p style="margin:12px 0 0"><button class="btn ghost" id="login-again">Ander e-mailadres gebruiken</button></p>`
      : `<div class="row">
          <div><label class="f" for="login-email">E-mailadres</label><input type="email" id="login-email" autocomplete="email" required></div>
          <button class="btn primary" id="login-send">Stuur inloglink</button>
        </div>
        <p class="warn" id="login-err" hidden></p>`}
  </div>`;
  const again = document.getElementById("login-again");
  if (again) again.addEventListener("click", () => { loginSent = ""; renderLogin(); });
  const send = document.getElementById("login-send");
  if (!send) return;
  const input = document.getElementById("login-email");
  const go = async () => {
    const email = input.value.trim();
    const err = document.getElementById("login-err");
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.hidden = false; err.textContent = "Geef een geldig e-mailadres in."; input.focus(); return; }
    send.disabled = true; send.textContent = "Versturen…";
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname }
    });
    send.disabled = false; send.textContent = "Stuur inloglink";
    if (error) {
      err.hidden = false;
      err.textContent = /signup|not allowed|not found/i.test(error.message)
        ? "Dit e-mailadres heeft nog geen toegang. Vraag de beheerder om je uit te nodigen."
        : /rate|seconds/i.test(error.message)
          ? "Je hebt net een link aangevraagd. Wacht even en probeer opnieuw."
          : "Versturen is mislukt: " + error.message;
      return;
    }
    loginSent = email; renderLogin();
  };
  send.addEventListener("click", go);
  input.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  input.focus();
}

/* ============================================================
   Gegevens laden uit Supabase
   ============================================================ */
function scheduleReload(delay = 250) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadAll, delay);
}

async function loadAll() {
  if (!session) return;
  const res = await Promise.all([
    sb.from("teams").select("id,name"),
    sb.from("players").select("id,team_id,name,hcp").order("created_at"),
    sb.from("courses").select("id,name,par").order("created_at"),
    sb.from("course_tees").select("course_id,tee,slope,course_rating"),
    sb.from("match_day").select("course_id").eq("id", 1).maybeSingle(),
    sb.from("matches").select("id,mode,formula,pct,slots").order("created_at")
  ]);
  const failed = res.find(r => r.error);
  if (failed) { setStatus("Gegevens laden is mislukt: " + failed.error.message, true); return; }
  const [teams, players, courses, tees, dayRow, matches] = res.map(r => r.data);

  config = {
    teams: ["a", "b"].map(id => {
      const row = (teams || []).find(x => x.id === id);
      return {
        id,
        name: row ? row.name : (id === "a" ? "Team A" : "Team B"),
        players: (players || []).filter(p => p.team_id === id).map(p => ({ id: p.id, name: p.name, hcp: toNum(p.hcp) }))
      };
    }),
    courses: (courses || []).map(c => {
      const t = {};
      TEES.forEach(tt => {
        const r = (tees || []).find(x => x.course_id === c.id && x.tee === tt.k);
        t[tt.k] = { slope: r ? toNum(r.slope) : null, cr: r ? toNum(r.course_rating) : null };
      });
      return { id: c.id, name: c.name, par: toNum(c.par) ?? 72, tees: t };
    })
  };
  day = { courseId: dayRow ? dayRow.course_id : null, matches: (matches || []).map(normalizeMatch) };
  loaded = true;
  if (statusEl.textContent === "Gegevens laden…") setStatus("");
  requestRender();
}

function normalizeMatch(row) {
  const mode = row.mode === "single" ? "single" : "double";
  const formula = FORMULAS[mode].includes(row.formula) ? row.formula : FORMULAS[mode][0];
  const n = mode === "single" ? 1 : 2;
  const slots = (row.slots && typeof row.slots === "object") ? row.slots : {};
  const side = s => Array.from({ length: n }, (_, i) => {
    const v = (Array.isArray(slots[s]) ? slots[s] : [])[i] || {};
    return { pid: v.pid || null, tee: TEES.some(t => t.k === v.tee) ? v.tee : DEFAULT_TEE };
  });
  return { id: row.id, mode, formula, pct: isNum(row.pct) ? row.pct : DEFAULT_PCT[formula], a: side("a"), b: side("b") };
}

/* ============================================================
   Opslaan in Supabase (lokaal meteen bijwerken, daarna wegschrijven)
   ============================================================ */
async function run(query) {
  const { error } = await query;
  if (error) {
    setStatus(/row-level security|permission/i.test(error.message)
      ? "Je hebt geen toegang om dit te wijzigen. Meld je opnieuw aan."
      : "Opslaan is mislukt: " + error.message, true);
    scheduleReload(0);
    return false;
  }
  setStatus("Opgeslagen.");
  return true;
}
const matchRow = m => ({ mode: m.mode, formula: m.formula, pct: m.pct, slots: { a: m.a, b: m.b } });
const saveMatch = m => run(sb.from("matches").update(matchRow(m)).eq("id", m.id));
const saveTee = (c, tee) => run(sb.from("course_tees").upsert(
  { course_id: c.id, tee, slope: c.tees[tee].slope, course_rating: c.tees[tee].cr },
  { onConflict: "course_id,tee" }));

/* ============================================================
   Berekening
   Course handicap  = HI × slope / 113 + (course rating − par), afgerond
   Playing handicap = course handicap × percentage, afgerond
   ============================================================ */
function calcPlayer(p, tee, course, pct) {
  const t = course.tees[tee];
  if (!t || !isNum(t.slope) || !isNum(t.cr)) return { error: `${tee} van ${course.name || "deze baan"} heeft nog geen slope of course rating.` };
  const chRaw = p.hcp * t.slope / 113 + (t.cr - course.par);
  const ch = Math.round(chRaw);
  const ph = Math.round(ch * pct / 100);
  return { chRaw, ch, ph };
}

function calcMatch(m) {
  const course = courseById(day.courseId);
  if (!course) return { state: "empty", msg: "Kies eerst een golfbaan bovenaan." };
  const rows = [];
  for (const side of ["a", "b"]) {
    for (const s of m[side]) {
      const p = playerById(s.pid);
      if (!p) return { state: "empty", msg: "Kies voor elk team " + (m.mode === "single" ? "een speler" : "twee spelers") + "." };
      if (!isNum(p.hcp)) return { state: "empty", msg: `${p.name} heeft nog geen handicap.` };
      const r = calcPlayer(p, s.tee, course, m.pct);
      if (r.error) return { state: "empty", msg: r.error };
      rows.push({ side, p, tee: s.tee, ...r });
    }
  }
  const tot = { a: 0, b: 0 };
  rows.forEach(r => tot[r.side] += r.ph);
  const low = Math.min(...rows.map(r => r.ph));
  rows.forEach(r => r.strokes = r.ph - low);
  const diff = tot.a - tot.b;
  return { state: "ok", rows, tot, diff, receiver: diff > 0 ? "a" : diff < 0 ? "b" : null, course };
}

/* ============================================================
   Weergave
   ============================================================ */
function route() { const r = (location.hash || "").replace("#", ""); return ["wedstrijden", "teams", "banen"].includes(r) ? r : "wedstrijden"; }
function isTyping() {
  const a = document.activeElement;
  return a && main.contains(a) && a.tagName === "INPUT" && ["text", "number", "email"].includes(a.type);
}
function requestRender(force) {
  if (isTyping() && !force) { pendingRender = true; return; }
  render();
}
main.addEventListener("focusout", () => setTimeout(() => { if (pendingRender && !isTyping()) render(); }, 0));

function render() {
  if (!session) { if (sb) renderLogin(); return; }
  pendingRender = false;
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
  const ta = team("a"), tb = team("b");
  document.getElementById("title").innerHTML = `<span class="a">${esc(ta.name)}</span><span class="vs">vs</span><span class="b">${esc(tb.name)}</span>`;
  const r = route();
  document.querySelectorAll("nav.tabs a").forEach(a => a.dataset.route === r ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (!loaded) { main.innerHTML = ""; return; }
  main.innerHTML = r === "teams" ? renderTeams() : r === "banen" ? renderCourses() : renderMatches();
  if (focusKey) { const el = main.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`); if (el) el.focus(); }
}

function renderTeams() {
  return `<h2>Teams &amp; spelers</h2>
  <p class="help">Pas de teamnamen aan, voeg spelers toe en werk handicaps bij. Een plus-handicap vul je in als negatief getal (bv. +2,1 wordt −2,1).</p>
  <div class="grid2">${config.teams.map(t => {
    const other = config.teams.find(x => x.id !== t.id);
    const c = t.id === "a" ? "var(--teamA)" : "var(--teamB)";
    return `<section class="panel team" style="--c:${c}" aria-label="${esc(t.name)}">
      <div class="name"><label class="f" for="tn-${t.id}">Teamnaam</label>
        <input type="text" id="tn-${t.id}" data-fk="tn-${t.id}" data-act="team-name" data-team="${t.id}" value="${esc(t.name)}"></div>
      <h3 style="margin-top:14px">Spelers<span class="count">${t.players.length}</span></h3>
      ${t.players.length ? `<div class="scroll"><table class="ptable"><thead><tr><th>Naam</th><th class="num">Handicap</th><th></th></tr></thead><tbody>
      ${t.players.map(p => `<tr>
        <td><input type="text" aria-label="Naam" data-fk="pn-${p.id}" data-act="p-name" data-pid="${p.id}" value="${esc(p.name)}"></td>
        <td><input type="number" step="0.1" min="-10" max="54" aria-label="Handicap van ${esc(p.name)}" data-fk="ph-${p.id}" data-act="p-hcp" data-pid="${p.id}" value="${isNum(p.hcp) ? p.hcp : ""}" style="text-align:right"></td>
        <td><button class="btn ghost" data-act="p-move" data-pid="${p.id}" data-fk="pm-${p.id}" title="Verplaats naar ${esc(other.name)}">Naar ${esc(other.name)}</button>
            <button class="btn ghost danger ${armed === "p-" + p.id ? "armed" : ""}" data-act="p-del" data-pid="${p.id}" data-fk="pd-${p.id}">${armed === "p-" + p.id ? "Zeker?" : "Verwijder"}</button></td>
      </tr>`).join("")}</tbody></table></div>` : `<p class="note" style="margin-top:8px">Nog geen spelers. Voeg hieronder de eerste toe.</p>`}
      <div class="addrow">
        <div><label class="f" for="new-n-${t.id}">Nieuwe speler</label><input type="text" id="new-n-${t.id}" data-fk="new-n-${t.id}" placeholder="Naam"></div>
        <div><label class="f" for="new-h-${t.id}">Handicap</label><input type="number" step="0.1" id="new-h-${t.id}" data-fk="new-h-${t.id}" placeholder="18,0"></div>
        <button class="btn primary" data-act="p-add" data-team="${t.id}" data-fk="new-b-${t.id}">Speler toevoegen</button>
      </div>
      <p class="warn" id="add-err-${t.id}" hidden></p>
    </section>`;
  }).join("")}</div>`;
}

function renderCourses() {
  return `<h2>Golfbanen</h2>
  <p class="help">Per baan de par en, voor elke tee, de course rating en slope rating. Deze waarden bepalen de course handicap van elke speler.</p>
  <div class="stack">
  ${config.courses.map(c => `<section class="panel" aria-label="${esc(c.name)}">
    <div class="course-head">
      <div><label class="f" for="cn-${c.id}">Naam van de baan</label><input type="text" id="cn-${c.id}" data-fk="cn-${c.id}" data-act="c-name" data-cid="${c.id}" value="${esc(c.name)}"></div>
      <div><label class="f" for="cp-${c.id}">Par</label><input type="number" id="cp-${c.id}" data-fk="cp-${c.id}" data-act="c-par" data-cid="${c.id}" value="${isNum(c.par) ? c.par : ""}" min="54" max="80" style="text-align:right"></div>
      <button class="btn danger ${armed === "c-" + c.id ? "armed" : ""}" data-act="c-del" data-cid="${c.id}" data-fk="cd-${c.id}">${armed === "c-" + c.id ? "Klik nogmaals om te verwijderen" : "Baan verwijderen"}</button>
    </div>
    <div class="scroll"><table class="ctable"><thead><tr><th>Tee</th><th class="num">Course rating</th><th class="num">Slope rating</th></tr></thead><tbody>
    ${TEES.map(t => { const v = c.tees[t.k]; return `<tr>
      <td><span class="tee-dot tee-${t.k}" aria-hidden="true"></span><strong>${t.k}</strong> <span class="note" style="display:inline">${t.long}</span></td>
      <td><input type="number" step="0.1" aria-label="Course rating ${t.k}" data-fk="cr-${c.id}-${t.k}" data-act="c-cr" data-cid="${c.id}" data-tee="${t.k}" value="${isNum(v.cr) ? v.cr : ""}"></td>
      <td><input type="number" step="1" min="55" max="155" aria-label="Slope rating ${t.k}" data-fk="sl-${c.id}-${t.k}" data-act="c-slope" data-cid="${c.id}" data-tee="${t.k}" value="${isNum(v.slope) ? v.slope : ""}"></td>
    </tr>`; }).join("")}
    </tbody></table></div>
  </section>`).join("")}
  ${config.courses.length ? "" : `<div class="panel empty-state"><p style="margin:0">Nog geen golfbanen. Voeg een baan toe om wedstrijden te kunnen berekenen.</p></div>`}
  <div><button class="btn primary" data-act="c-add" data-fk="c-add">Golfbaan toevoegen</button></div>
  </div>`;
}

function renderMatches() {
  const hasPlayers = config.teams.every(t => t.players.length > 0);
  if (!config.courses.length || !hasPlayers) {
    const need = [];
    if (!config.courses.length) need.push(`minstens één <a href="#banen">golfbaan</a>`);
    if (!hasPlayers) need.push(`spelers in beide <a href="#teams">teams</a>`);
    return `<h2>Wedstrijden</h2><div class="panel empty-state"><p style="margin:0">Om te beginnen heb je ${need.join(" en ")} nodig.</p></div>`;
  }
  return `<h2>Wedstrijden</h2>
  <p class="help">Kies de baan, stel per wedstrijd de spelers, hun tees en het percentage in. Het verschil in strokes verschijnt meteen.</p>
  <div class="stack">
    <div class="panel daybar">
      <div><label class="f" for="day-course">Golfbaan</label>
        <select id="day-course" data-fk="day-course" data-act="day-course">
          <option value="">Kies een baan…</option>
          ${config.courses.map(c => `<option value="${c.id}" ${c.id === day.courseId ? "selected" : ""}>${esc(c.name || "Naamloze baan")} — par ${c.par}</option>`).join("")}
        </select></div>
      <button class="btn primary" data-act="m-add" data-fk="m-add">Wedstrijd toevoegen</button>
    </div>
    ${day.matches.length ? day.matches.map((m, i) => renderMatch(m, i)).join("") : `<div class="panel empty-state"><p style="margin:0">Nog geen wedstrijden. Voeg er een toe om de strokes te berekenen.</p></div>`}
    <p class="note">Course handicap = handicap index × slope ÷ 113 + (course rating − par), afgerond. Playing handicap = course handicap × percentage, afgerond. Het team met de hoogste totale playing handicap krijgt het verschil aan strokes.</p>
  </div>`;
}

function usedElsewhere(m, side, idx) {
  const set = new Set();
  day.matches.forEach(o => ["a", "b"].forEach(s => o[s].forEach((sl, j) => { if (sl.pid && !(o.id === m.id && s === side && j === idx)) set.add(sl.pid); })));
  return set;
}

function renderMatch(m, i) {
  const side = (sid, t) => {
    const c = sid === "a" ? "var(--teamA)" : "var(--teamB)";
    return `<div class="side" style="--c:${c}"><h4>${esc(t.name)}</h4>
    ${m[sid].map((s, j) => { const used = usedElsewhere(m, sid, j); return `<div class="slot">
      <select aria-label="Speler ${j + 1} ${esc(t.name)}" data-fk="m-${m.id}-${sid}-${j}-p" data-act="m-player" data-mid="${m.id}" data-side="${sid}" data-idx="${j}">
        <option value="">Kies speler…</option>
        ${t.players.map(p => `<option value="${p.id}" ${p.id === s.pid ? "selected" : ""}>${esc(p.name)} (${fmtHcp(p.hcp)})${used.has(p.id) ? " · speelt al" : ""}</option>`).join("")}
      </select>
      <select aria-label="Tee speler ${j + 1} ${esc(t.name)}" data-fk="m-${m.id}-${sid}-${j}-t" data-act="m-tee" data-mid="${m.id}" data-side="${sid}" data-idx="${j}">
        ${TEES.map(tt => `<option value="${tt.k}" ${tt.k === s.tee ? "selected" : ""}>${tt.k}</option>`).join("")}
      </select></div>`; }).join("")}
    ${m.mode === "double" && m[sid][0].pid && m[sid][0].pid === m[sid][1].pid ? `<p class="warn">Twee keer dezelfde speler gekozen.</p>` : ""}
    </div>`;
  };
  return `<section class="panel match" aria-label="Wedstrijd ${i + 1}">
    <div class="match-top"><h3>Wedstrijd ${i + 1}</h3>
      <button class="btn ghost danger ${armed === "m-" + m.id ? "armed" : ""}" data-act="m-del" data-mid="${m.id}" data-fk="md-${m.id}">${armed === "m-" + m.id ? "Zeker?" : "Verwijder"}</button></div>
    <div class="match-body">
      <div class="settings">
        <div><span class="f" style="display:block;font-size:.85rem;font-weight:600;color:var(--muted);margin-bottom:4px">Type</span>
          <div class="seg" role="group" aria-label="Type wedstrijd">
            <button data-act="m-mode" data-mode="single" data-mid="${m.id}" data-fk="m-${m.id}-single" aria-pressed="${m.mode === "single"}">Single</button>
            <button data-act="m-mode" data-mode="double" data-mid="${m.id}" data-fk="m-${m.id}-double" aria-pressed="${m.mode === "double"}">Dubbel</button>
          </div></div>
        <div><label class="f" for="mf-${m.id}">Formule</label>
          <select id="mf-${m.id}" data-fk="mf-${m.id}" data-act="m-formula" data-mid="${m.id}">
            ${FORMULAS[m.mode].map(f => `<option ${f === m.formula ? "selected" : ""}>${f}</option>`).join("")}
          </select></div>
        <div><label class="f" for="mp-${m.id}">Percentage van de handicap</label>
          <div class="pct"><input type="range" min="0" max="100" step="1" id="mp-${m.id}" data-fk="mp-${m.id}" data-act="m-pct" data-mid="${m.id}" value="${m.pct}">
          <output id="mpo-${m.id}" for="mp-${m.id}">${m.pct}%</output></div></div>
      </div>
      <div class="sides">${side("a", team("a"))}${side("b", team("b"))}</div>
      <div id="res-${m.id}">${renderResult(m)}</div>
    </div>
  </section>`;
}

function renderResult(m) {
  const r = calcMatch(m);
  const ta = team("a"), tb = team("b");
  if (r.state !== "ok") return `<div class="board empty"><div class="bres">${esc(r.msg)}</div></div>`;
  const label = m.mode === "single" ? "playing hcp" : m.formula === "Scramble" ? "teamhandicap" : "som playing hcp";
  const recv = r.receiver ? team(r.receiver) : null;
  const n = Math.abs(r.diff);
  const meta = `<small>${esc(m.formula)} · ${m.pct}% · ${esc(r.course.name)}</small>`;
  const big = recv
    ? `<span class="big" style="color:${r.receiver === "a" ? "var(--boardA)" : "var(--boardB)"}">+${n}</span>
       <span class="who">${esc(recv.name)} ${m.mode === "double" ? "krijgen" : "krijgt"} ${n} ${n === 1 ? "stroke" : "strokes"}${meta}</span>`
    : `<span class="big">0</span><span class="who">Gelijk opgaan, geen strokes${meta}</span>`;
  const perPlayer = m.formula !== "Scramble";
  return `<div class="board" aria-live="polite">
    <div class="brow"><span class="tn" style="color:var(--boardA)">${esc(ta.name)}</span><span class="tv"><span class="tl">${label}</span>${r.tot.a}</span></div>
    <div class="brow"><span class="tn" style="color:var(--boardB)">${esc(tb.name)}</span><span class="tv"><span class="tl">${label}</span>${r.tot.b}</span></div>
    <div class="bres">${big}</div>
  </div>
  <div class="scroll" style="margin-top:12px"><table class="detail"><thead><tr>
    <th>Speler</th><th>Tee</th><th class="num">Handicap</th><th class="num">Course hcp</th><th class="num">Playing hcp</th>${perPlayer ? `<th class="num">Strokes</th>` : ""}
  </tr></thead><tbody>
  ${r.rows.map(x => `<tr>
    <td><span style="color:${x.side === "a" ? "var(--teamA)" : "var(--teamB)"};font-weight:700">${esc(x.p.name)}</span></td>
    <td>${x.tee}</td><td class="num">${fmtHcp(x.p.hcp)}</td>
    <td class="num" title="${fmt1(x.chRaw)} voor afronding">${x.ch}</td><td class="num">${x.ph}</td>
    ${perPlayer ? `<td class="num strokes">${x.strokes}</td>` : ""}
  </tr>`).join("")}
  </tbody></table></div>
  ${perPlayer && m.mode === "double" ? `<p class="note" style="margin-top:8px">Strokes per speler = verschil met de laagste playing handicap van de vier spelers.</p>` : ""}`;
}

/* ============================================================
   Gebeurtenissen
   ============================================================ */
main.addEventListener("change", e => {
  const el = e.target, act = el.dataset.act;
  if (!act || !session) return;

  if (act === "team-name") {
    const t = team(el.dataset.team), v = el.value.trim();
    if (!v) { el.value = t.name; return; }
    t.name = v; requestRender(true);
    run(sb.from("teams").upsert({ id: t.id, name: v }));
  }
  else if (act === "p-name") {
    const f = findPlayer(el.dataset.pid), v = el.value.trim();
    if (!f) return;
    if (!v) { el.value = f.p.name; return; }
    f.p.name = v; requestRender(true);
    run(sb.from("players").update({ name: v }).eq("id", f.p.id));
  }
  else if (act === "p-hcp") {
    const f = findPlayer(el.dataset.pid), v = num(el.value);
    if (!f) return;
    if (v === null || v < -10 || v > 54) { el.value = isNum(f.p.hcp) ? f.p.hcp : ""; setStatus("Een handicap ligt tussen +10 (−10) en 54.", true); return; }
    f.p.hcp = Math.round(v * 10) / 10; requestRender(true);
    run(sb.from("players").update({ hcp: f.p.hcp }).eq("id", f.p.id));
  }
  else if (act === "c-name") {
    const c = courseById(el.dataset.cid); if (!c) return;
    c.name = el.value.trim(); requestRender(true);
    run(sb.from("courses").update({ name: c.name }).eq("id", c.id));
  }
  else if (act === "c-par") {
    const c = courseById(el.dataset.cid), v = num(el.value); if (!c) return;
    if (v === null || v < 54 || v > 80) { el.value = c.par; setStatus("Par ligt tussen 54 en 80.", true); return; }
    c.par = Math.round(v); requestRender(true);
    run(sb.from("courses").update({ par: c.par }).eq("id", c.id));
  }
  else if (act === "c-cr") {
    const c = courseById(el.dataset.cid), v = num(el.value); if (!c) return;
    if (v !== null && (v < 50 || v > 90)) { el.value = c.tees[el.dataset.tee].cr ?? ""; setStatus("Een course rating ligt tussen 50 en 90.", true); return; }
    c.tees[el.dataset.tee].cr = v === null ? null : Math.round(v * 10) / 10; requestRender(true);
    saveTee(c, el.dataset.tee);
  }
  else if (act === "c-slope") {
    const c = courseById(el.dataset.cid), v = num(el.value); if (!c) return;
    if (v !== null && (v < 55 || v > 155)) { el.value = c.tees[el.dataset.tee].slope ?? ""; setStatus("Een slope rating ligt tussen 55 en 155.", true); return; }
    c.tees[el.dataset.tee].slope = v === null ? null : Math.round(v); requestRender(true);
    saveTee(c, el.dataset.tee);
  }
  else if (act === "day-course") {
    day.courseId = el.value || null; requestRender(true);
    run(sb.from("match_day").upsert({ id: 1, course_id: day.courseId }));
  }
  else if (act === "m-formula") {
    const m = findMatch(el.dataset.mid); if (!m) return;
    m.formula = el.value; m.pct = DEFAULT_PCT[m.formula]; requestRender(true); saveMatch(m);
  }
  else if (act === "m-player" || act === "m-tee") {
    const m = findMatch(el.dataset.mid); if (!m) return;
    const slot = m[el.dataset.side][+el.dataset.idx];
    if (act === "m-player") slot.pid = el.value || null; else slot.tee = el.value;
    requestRender(true); saveMatch(m);
  }
  else if (act === "m-pct") {
    const m = findMatch(el.dataset.mid); if (!m) return;
    m.pct = +el.value; saveMatch(m);
  }
});

// Schuifbalk: resultaat live bijwerken tijdens het slepen, pas opslaan bij loslaten.
main.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.act !== "m-pct") return;
  const m = findMatch(el.dataset.mid); if (!m) return;
  m.pct = +el.value;
  const o = document.getElementById("mpo-" + m.id); if (o) o.textContent = m.pct + "%";
  const r = document.getElementById("res-" + m.id); if (r) r.innerHTML = renderResult(m);
});

main.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.id && /^new-[nh]-[ab]$/.test(e.target.id)) addPlayer(e.target.id.slice(-1));
});

function addPlayer(tid) {
  const nEl = document.getElementById("new-n-" + tid), hEl = document.getElementById("new-h-" + tid), err = document.getElementById("add-err-" + tid);
  const name = nEl.value.trim(), h = num(hEl.value);
  if (!name) { err.hidden = false; err.textContent = "Geef een naam in."; nEl.focus(); return; }
  if (h === null || h < -10 || h > 54) { err.hidden = false; err.textContent = "Geef een handicap tussen −10 en 54 in."; hEl.focus(); return; }
  const p = { id: uuid(), name, hcp: Math.round(h * 10) / 10 };
  team(tid).players.push(p);
  render();
  const n2 = document.getElementById("new-n-" + tid); if (n2) n2.focus();
  run(sb.from("players").insert({ id: p.id, team_id: tid, name: p.name, hcp: p.hcp }));
}

function confirmDelete(key, fn) {
  if (armed === key) { armed = null; fn(); return; }
  armed = key; render();
  setTimeout(() => { if (armed === key) { armed = null; render(); } }, 4000);
}

main.addEventListener("click", async e => {
  const el = e.target.closest("button[data-act]");
  if (!el || !session) return;
  const act = el.dataset.act;

  if (act === "p-add") addPlayer(el.dataset.team);

  else if (act === "p-move") {
    const f = findPlayer(el.dataset.pid); if (!f) return;
    const other = config.teams.find(t => t.id !== f.t.id);
    f.t.players.splice(f.i, 1); other.players.push(f.p);
    const touched = day.matches.filter(m => ["a", "b"].some(s => m[s].some(sl => sl.pid === f.p.id)));
    touched.forEach(m => ["a", "b"].forEach(s => m[s].forEach(sl => { if (sl.pid === f.p.id) sl.pid = null; })));
    render();
    await run(sb.from("players").update({ team_id: other.id }).eq("id", f.p.id));
    touched.forEach(saveMatch);
  }

  else if (act === "p-del") confirmDelete("p-" + el.dataset.pid, () => {
    const f = findPlayer(el.dataset.pid); if (!f) return;
    f.t.players.splice(f.i, 1); render();
    run(sb.from("players").delete().eq("id", f.p.id));
  });

  else if (act === "c-add") {
    const c = { id: uuid(), name: "Nieuwe baan", par: 72, tees: {} };
    TEES.forEach(t => c.tees[t.k] = { slope: null, cr: null });
    config.courses.push(c); render();
    const input = document.getElementById("cn-" + c.id); if (input) { input.focus(); input.select(); }
    if (await run(sb.from("courses").insert({ id: c.id, name: c.name, par: c.par }))) {
      run(sb.from("course_tees").insert(TEES.map(t => ({ course_id: c.id, tee: t.k }))));
    }
  }

  else if (act === "c-del") confirmDelete("c-" + el.dataset.cid, () => {
    const id = el.dataset.cid;
    config.courses = config.courses.filter(c => c.id !== id);
    if (day.courseId === id) day.courseId = null;
    render();
    run(sb.from("courses").delete().eq("id", id)); // tees worden mee verwijderd, match_day wordt leeg gezet
  });

  else if (act === "m-add") {
    const formula = "4BBB";
    const m = { id: uuid(), mode: "double", formula, pct: DEFAULT_PCT[formula],
      a: [{ pid: null, tee: DEFAULT_TEE }, { pid: null, tee: DEFAULT_TEE }],
      b: [{ pid: null, tee: DEFAULT_TEE }, { pid: null, tee: DEFAULT_TEE }] };
    day.matches.push(m); render();
    run(sb.from("matches").insert({ id: m.id, ...matchRow(m) }));
  }

  else if (act === "m-del") confirmDelete("m-" + el.dataset.mid, () => {
    const id = el.dataset.mid;
    day.matches = day.matches.filter(m => m.id !== id); render();
    run(sb.from("matches").delete().eq("id", id));
  });

  else if (act === "m-mode") {
    const m = findMatch(el.dataset.mid);
    if (!m || m.mode === el.dataset.mode) return;
    m.mode = el.dataset.mode; m.formula = FORMULAS[m.mode][0]; m.pct = DEFAULT_PCT[m.formula];
    const n = m.mode === "single" ? 1 : 2;
    ["a", "b"].forEach(s => { m[s] = Array.from({ length: n }, (_, i) => m[s][i] || { pid: null, tee: DEFAULT_TEE }); });
    render(); saveMatch(m);
  }
});

start();
})();
