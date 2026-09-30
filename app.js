/* Bacheca Scuola — web app che legge Google Classroom e Gmail con l'account Google che scegli tu.
   Tutto gira nel browser: nessun server, nessun dato inviato altrove. */
(function () {
  "use strict";

  // ---------- Configurazione ----------
  const SCOPES = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.announcements.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
  ];
  const SCOPE_CLASSROOM = SCOPES.slice(0, 3);
  const SCOPE_GMAIL = SCOPES[3];
  const DEFAULTS = {
    argoQuery: "newer_than:60d (argo OR circolare OR bacheca)",
    mailQuery: "newer_than:14d in:inbox -category:promotions -category:social",
  };
  const K = { cfg: "bs.cfg.v1", data: "bs.data.v1", tok: "bs.tok.v1" };

  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const sess = {
    get(k) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
  };

  const BUILTIN_CLIENT_ID = "793551851465-v01hsqrenpshdfpm5e77ngu29jkiiio8.apps.googleusercontent.com";
  let cfg = Object.assign({ clientId: BUILTIN_CLIENT_ID, email: "" }, DEFAULTS, store.get(K.cfg, {}));
  let data = store.get(K.data, null); // {updatedAt, email, tasks, announcements, argo, posta, errors}
  let token = sess.get(K.tok); // {access_token, exp, scope}
  let ui = { view: "home", filter: "todo", course: "tutti", loading: false };
  let tokenClient = null;
  let pendingToken = null;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const saveCfg = () => store.set(K.cfg, cfg);

  // ---------- Date ----------
  function dueToMs(dueDate, dueTime) {
    if (!dueDate || !dueDate.year) return null;
    const t = dueTime || {};
    // Classroom restituisce scadenza in UTC; senza orario vale fine giornata
    const hasTime = t.hours != null || t.minutes != null;
    return Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day, hasTime ? t.hours || 0 : 23, hasTime ? t.minutes || 0 : 59);
  }
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function relDue(ms, now = Date.now()) {
    if (ms == null) return "";
    const n = Math.round((startOfDay(ms) - startOfDay(now)) / 864e5);
    if (ms < now) return "scaduto";
    if (n === 0) return "oggi";
    if (n === 1) return "domani";
    return "tra " + n + " gg";
  }
  function fmtDay(ms) { return new Date(ms).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "long" }); }
  function fmtDateTime(ms) { return new Date(ms).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }

  // ---------- Auth ----------
  function tokenValid() { return token && token.access_token && token.exp > Date.now() + 60000; }
  function hasScope(s) { return !!(token && token.scope && token.scope.split(" ").includes(s)); }

  function gisReady() {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function wait() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (Date.now() - t0 > 10000) return reject(new Error("Non riesco a caricare il login di Google. Controlla la connessione."));
        setTimeout(wait, 100);
      })();
    });
  }

  async function ensureClient() {
    await gisReady();
    if (tokenClient && tokenClient._cid === cfg.clientId) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPES.join(" "),
      include_granted_scopes: true,
      callback: (resp) => {
        const p = pendingToken; pendingToken = null;
        if (!p) return;
        if (resp.error) return p.reject(new Error(authErrorText(resp.error)));
        token = { access_token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000, scope: resp.scope || "" };
        sess.set(K.tok, token);
        p.resolve(token);
      },
      error_callback: (err) => {
        const p = pendingToken; pendingToken = null;
        if (!p) return;
        const t = err && err.type;
        p.reject(new Error(t === "popup_closed" ? "Hai chiuso la finestra di accesso." : t === "popup_failed_to_open" ? "Il browser ha bloccato la finestra di accesso. Consenti i popup per questo sito." : "Accesso non riuscito."));
      },
    });
    tokenClient._cid = cfg.clientId;
  }

  function authErrorText(code) {
    if (code === "access_denied") return "Hai negato l'accesso, oppure la tua scuola blocca le app esterne su questo account.";
    if (code === "invalid_client") return "Client ID non valido. Ricontrollalo in Account.";
    return "Errore di accesso Google: " + code;
  }

  async function getToken(chooseAccount) {
    if (!chooseAccount && tokenValid()) return token;
    if (!cfg.clientId) throw new Error("Manca il Client ID.");
    await ensureClient();
    return new Promise((resolve, reject) => {
      pendingToken = { resolve, reject };
      const opts = { prompt: chooseAccount || !cfg.email ? "select_account" : "" };
      if (cfg.email && !chooseAccount) opts.login_hint = cfg.email;
      tokenClient.requestAccessToken(opts);
    });
  }

  function signOut() {
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(token.access_token, () => {}); } catch (e) {}
    }
    token = null; sess.del(K.tok);
    data = null; store.del(K.data);
    cfg.email = ""; saveCfg();
  }

  // ---------- API ----------
  class ApiError extends Error { constructor(status, msg, reason) { super(msg); this.status = status; this.reason = reason; } }

  async function api(url) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token.access_token } });
    if (r.ok) return r.json();
    let body = null; try { body = await r.json(); } catch (e) {}
    const err = body && body.error;
    const reason = err && err.details && err.details.find && (err.details.find((d) => d.reason) || {}).reason || (err && err.status) || "";
    if (r.status === 401) { token = null; sess.del(K.tok); }
    throw new ApiError(r.status, (err && err.message) || "HTTP " + r.status, reason);
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  function explain(e, what) {
    if (!(e instanceof ApiError)) return what + ": " + (e.message || "errore di rete.");
    const m = e.message || "";
    if (e.status === 401) return "Sessione scaduta. Premi Aggiorna per rientrare.";
    if (e.reason === "SERVICE_DISABLED" || e.reason === "accessNotConfigured" || /has not been used|is disabled/i.test(m))
      return what + ": l'API non è attivata nel tuo progetto Google Cloud. Attivala e riprova.";
    if (e.status === 403 && /insufficient/i.test(m)) return what + ": non hai concesso questo permesso all'accesso. Esci e rientra spuntando tutte le caselle.";
    if (e.status === 403) return what + ": accesso negato da Google (" + m + "). Può essere un blocco della scuola.";
    if (e.status === 429) return what + ": troppe richieste, riprova tra un minuto.";
    return what + ": " + m;
  }

  const CL = "https://classroom.googleapis.com/v1";
  const GM = "https://gmail.googleapis.com/gmail/v1/users/me";

  async function fetchClassroom() {
    const cr = await api(CL + "/courses?studentId=me&courseStates=ACTIVE&pageSize=50");
    const courses = cr.courses || [];
    const tasks = [], announcements = [], courseErrors = [];
    await pool(courses, 4, async (c) => {
      try {
        const [cw, subs, an] = await Promise.all([
          api(`${CL}/courses/${c.id}/courseWork?orderBy=${encodeURIComponent("updateTime desc")}&pageSize=40`).catch((e) => ({ _err: e })),
          api(`${CL}/courses/${c.id}/courseWork/-/studentSubmissions?userId=me&pageSize=100`).catch((e) => ({ _err: e })),
          api(`${CL}/courses/${c.id}/announcements?orderBy=${encodeURIComponent("updateTime desc")}&pageSize=10`).catch((e) => ({ _err: e })),
        ]);
        if (cw._err) throw cw._err;
        const subBy = {};
        (subs.studentSubmissions || []).forEach((s) => { subBy[s.courseWorkId] = s; });
        (cw.courseWork || []).forEach((w) => {
          const s = subBy[w.id];
          const done = !!s && (s.state === "TURNED_IN" || s.state === "RETURNED");
          tasks.push({
            id: w.id, courseId: c.id, course: c.name, title: w.title || "(senza titolo)", description: w.description || "",
            due: dueToMs(w.dueDate, w.dueTime), created: Date.parse(w.creationTime) || null, link: w.alternateLink || c.alternateLink || "",
            type: w.workType || "", done, late: !!(s && s.late), grade: s && s.assignedGrade != null ? s.assignedGrade : null, maxPoints: w.maxPoints ?? null,
          });
        });
        (an.announcements || []).forEach((a) => {
          announcements.push({ id: a.id, course: c.name, courseId: c.id, text: a.text || "", created: Date.parse(a.updateTime || a.creationTime) || null, link: a.alternateLink || "" });
        });
      } catch (e) { courseErrors.push(c.name + ": " + (e.message || "errore")); }
    });
    return { courses: courses.map((c) => ({ id: c.id, name: c.name })), tasks, announcements, courseErrors };
  }

  function header(msg, name) {
    const h = (msg.payload && msg.payload.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : "";
  }
  function cleanFrom(f) { const m = /^\s*"?([^"<]+?)"?\s*<.+>$/.exec(f || ""); return m ? m[1] : f || ""; }
  function decodeEntities(s) { const t = document.createElement("textarea"); t.innerHTML = s || ""; return t.value; }

  async function fetchMail(q, max) {
    const list = await api(`${GM}/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
    const ids = (list.messages || []).map((m) => m.id);
    const msgs = await pool(ids, 6, (id) =>
      api(`${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null));
    return msgs.filter(Boolean).map((m) => ({
      id: m.id, threadId: m.threadId, from: cleanFrom(header(m, "From")), subject: header(m, "Subject") || "(senza oggetto)",
      date: Number(m.internalDate) || Date.parse(header(m, "Date")) || null, snippet: decodeEntities(m.snippet),
      unread: (m.labelIds || []).includes("UNREAD"),
    }));
  }

  function b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }
  function extractText(payload) {
    let plain = "", html = "";
    (function walk(p) {
      if (!p) return;
      if (p.mimeType === "text/plain" && p.body && p.body.data && !plain) plain = b64urlDecode(p.body.data);
      else if (p.mimeType === "text/html" && p.body && p.body.data && !html) html = b64urlDecode(p.body.data);
      (p.parts || []).forEach(walk);
    })(payload);
    if (plain) return plain.trim();
    if (html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("style,script").forEach((n) => n.remove());
      return (doc.body.innerText || doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    }
    return "";
  }

  // ---------- Caricamento ----------
  async function refresh(chooseAccount) {
    if (ui.loading) return;
    ui.loading = true; render();
    try {
      try { await getToken(chooseAccount); }
      catch (e) { setStatus("warn", "Accesso non riuscito", e.message); return; }
      setStatus("info", "Aggiorno", "Leggo Classroom e Gmail…");

      let email = cfg.email;
      const errors = {};
      const next = { updatedAt: Date.now(), tasks: [], announcements: [], courses: [], argo: [], posta: [], errors };

      const jobs = [];
      if (hasScope(SCOPE_GMAIL)) {
        jobs.push(api(GM + "/profile").then((p) => { email = p.emailAddress; }).catch(() => {}));
        jobs.push(fetchMail(cfg.argoQuery, 25).then((r) => { next.argo = r; }).catch((e) => { errors.argo = explain(e, "Argo (Gmail)"); }));
        jobs.push(fetchMail(cfg.mailQuery, 25).then((r) => { next.posta = r; }).catch((e) => { errors.posta = explain(e, "Gmail"); }));
      } else {
        errors.argo = errors.posta = "Non hai concesso l'accesso a Gmail. Vai in Account → Cambia account e spunta tutti i permessi.";
      }
      if (SCOPE_CLASSROOM.every(hasScope)) {
        jobs.push(fetchClassroom().then((r) => {
          Object.assign(next, { tasks: r.tasks, announcements: r.announcements, courses: r.courses });
          if (r.courseErrors.length) errors.classroomCourses = r.courseErrors;
        }).catch((e) => { errors.classroom = explain(e, "Classroom"); }));
      } else {
        errors.classroom = "Non hai concesso tutti i permessi di Classroom. Vai in Account → Cambia account e spunta tutte le caselle.";
      }
      await Promise.all(jobs);

      if (email) { cfg.email = email; saveCfg(); }
      next.email = cfg.email;
      data = next; store.set(K.data, data);
      const errs = [errors.classroom, errors.argo, errors.posta].filter(Boolean);
      if (errs.length) setStatus("warn", "Alcune parti non si sono caricate", [...new Set(errs)].join(" "));
      else setStatus(null);
    } finally {
      ui.loading = false; render();
    }
  }

  // ---------- Riepilogo (calcolato dai dati, niente testo inventato) ----------
  function buildSummary(d, now = Date.now()) {
    const week = now + 7 * 864e5;
    const todo = d.tasks.filter((t) => !t.done && t.due != null && t.due >= now);
    const soon = todo.filter((t) => t.due <= week);
    const today = todo.filter((t) => relDue(t.due, now) === "oggi");
    const tomorrow = todo.filter((t) => relDue(t.due, now) === "domani");
    const overdue = d.tasks.filter((t) => !t.done && t.due != null && t.due < now && now - t.due < 30 * 864e5);
    const unreadArgo = d.argo.filter((m) => m.unread).length;
    const parts = [];
    if (today.length) parts.push(`${today.length} ${today.length === 1 ? "consegna" : "consegne"} oggi (${today.map((t) => t.course).join(", ")})`);
    if (tomorrow.length) parts.push(`${tomorrow.length} per domani (${tomorrow.map((t) => t.course).join(", ")})`);
    if (soon.length && soon.length > today.length + tomorrow.length) parts.push(`${soon.length} in totale nei prossimi 7 giorni`);
    if (!soon.length) parts.push("nessuna consegna nei prossimi 7 giorni");
    if (overdue.length) parts.push(`${overdue.length} ${overdue.length === 1 ? "compito scaduto non consegnato" : "compiti scaduti non consegnati"}`);
    if (unreadArgo) parts.push(`${unreadArgo} ${unreadArgo === 1 ? "email Argo non letta" : "email Argo non lette"}`);
    const s = parts.join(", ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }

  // ---------- Render ----------
  const TITLES = { home: "Oggi a scuola", classroom: "Classroom", argo: "Argo", posta: "Posta", account: "Account" };

  function taskItem(t, now = Date.now()) {
    const d = new Date(t.due ?? t.created ?? now);
    const rel = t.due != null ? relDue(t.due, now) : "";
    const urgent = !t.done && t.due != null && (rel === "oggi" || rel === "domani" || rel === "scaduto");
    return `<li><button class="item${urgent ? " urgent" : ""}${t.done ? " done" : ""}" data-kind="task" data-id="${esc(t.courseId + ":" + t.id)}" type="button">
      <span class="date"><b>${d.getDate()}</b>${MESI[d.getMonth()]}</span>
      <span class="body"><span class="t">${esc(t.title)}</span>
        ${t.description ? `<span class="d">${esc(t.description)}</span>` : ""}
        <span class="chips"><span class="chip classroom">${esc(t.course)}</span>${t.done ? '<span class="chip">consegnato</span>' : rel ? `<span class="chip due">${esc(rel)}</span>` : ""}</span>
      </span></button></li>`;
  }
  function annItem(a) {
    const d = new Date(a.created || Date.now());
    return `<li><button class="item" data-kind="ann" data-id="${esc(a.courseId + ":" + a.id)}" type="button">
      <span class="date"><b>${d.getDate()}</b>${MESI[d.getMonth()]}</span>
      <span class="body"><span class="t">${esc(a.course)}</span><span class="d">${esc(a.text)}</span>
      <span class="chips"><span class="chip classroom">annuncio</span></span></span></button></li>`;
  }
  function mailItem(m, kind) {
    const d = new Date(m.date || Date.now());
    return `<li><button class="item" data-kind="${kind}" data-id="${esc(m.id)}" type="button">
      <span class="date"><b>${d.getDate()}</b>${MESI[d.getMonth()]}</span>
      <span class="body"><span class="t">${esc(m.subject)}</span><span class="d">${esc(m.snippet)}</span>
      <span class="chips"><span class="chip ${kind === "argo" ? "argo" : ""}">${esc(m.from)}</span>${m.unread ? '<span class="chip due">non letta</span>' : ""}</span></span></button></li>`;
  }
  const list = (html, empty) => (html ? `<ul class="list">${html}</ul>` : `<div class="empty">${esc(empty)}</div>`);
  const errBox = (msg) => (msg ? `<div class="banner warn">${esc(msg)}</div>` : "");

  function renderSetup() {
    const origin = location.origin;
    return `<div class="hero"><h2>Prima configurazione</h2>
      <p>L'app legge Classroom e Gmail direttamente da Google con l'account che scegli al login, anche diverso da quello che usi altrove. Serve un Client ID gratuito di Google, da creare una volta sola.</p></div>
      <div class="card"><span class="eyebrow">Su console.cloud.google.com</span><ol>
        <li>Crea un progetto (nome qualsiasi).</li>
        <li>In <b>API e servizi → Libreria</b> attiva <b>Google Classroom API</b> e <b>Gmail API</b>.</li>
        <li>In <b>Schermata consenso OAuth</b> scegli <b>Esterno</b>, lascialo in <b>Test</b> e aggiungi come utente di test l'indirizzo della scuola.</li>
        <li>In <b>Credenziali → Crea credenziali → ID client OAuth</b> scegli <b>Applicazione web</b>. In <b>Origini JavaScript autorizzate</b> metti:<br><code>${esc(origin)}</code></li>
        <li>Copia l'ID client e incollalo qui sotto.</li>
      </ol></div>
      <form id="setupForm"><label for="cid">Client ID</label>
        <input type="text" id="cid" placeholder="123456-abc.apps.googleusercontent.com" autocomplete="off" spellcheck="false" value="${esc(cfg.clientId)}">
        <div class="actions"><button class="btn solid" type="submit">Salva e accedi</button></div></form>`;
  }

  function renderLogin() {
    return `<div class="hero"><h2>Accedi</h2>
      <p>Scegli l'account Google della scuola. Ti chiederà il permesso di leggere Classroom e Gmail: spunta tutte le caselle.</p>
      <div class="actions"><button class="btn solid" type="button" data-act="login">Accedi con Google</button></div></div>`;
  }

  function renderHome(now = Date.now()) {
    const d = data;
    const todo = d.tasks.filter((t) => !t.done && t.due != null && t.due >= now).sort((a, b) => a.due - b.due);
    const overdue = d.tasks.filter((t) => !t.done && t.due != null && t.due < now && now - t.due < 30 * 864e5).sort((a, b) => b.due - a.due);
    const ann = [...d.announcements].sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 4);
    const argo = [...d.argo].sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 5);
    return `<div class="summary"><span class="eyebrow">Riepilogo</span><p>${esc(buildSummary(d, now))}</p></div>
      <div class="counts">
        <button class="count" data-go="classroom"><strong>${todo.length}</strong><span>Da consegnare</span></button>
        <button class="count" data-go="argo"><strong>${d.argo.length}</strong><span>Email Argo</span></button>
        <button class="count" data-go="posta"><strong>${d.posta.filter((m) => m.unread).length}</strong><span>Non lette</span></button>
      </div>
      <section class="block"><h2>In scadenza <span class="n">${todo.length}</span></h2>${errBox(d.errors.classroom)}${d.errors.classroom ? "" : list(todo.slice(0, 8).map((t) => taskItem(t, now)).join(""), "Nessun compito con scadenza da consegnare.")}</section>
      ${overdue.length ? `<section class="block"><h2>Scaduti, non consegnati <span class="n">${overdue.length}</span></h2>${list(overdue.map((t) => taskItem(t, now)).join(""), "")}</section>` : ""}
      <section class="block"><h2>Argo <span class="n">${d.argo.length}</span></h2>${errBox(d.errors.argo)}${d.errors.argo ? "" : list(argo.map((m) => mailItem(m, "argo")).join(""), "Nessuna email trovata con la ricerca Argo. Modificala in Account.")}</section>
      <section class="block"><h2>Annunci Classroom</h2>${d.errors.classroom ? "" : list(ann.map(annItem).join(""), "Nessun annuncio recente.")}</section>`;
  }

  function renderClassroom(now = Date.now()) {
    const d = data;
    if (d.errors.classroom) return errBox(d.errors.classroom);
    const byCourse = (x) => ui.course === "tutti" || x.courseId === ui.course;
    const f = [["todo", "Da fare"], ["all", "Tutti i compiti"], ["ann", "Annunci"]]
      .map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${ui.filter === k}">${l}</button>`).join("");
    const c = [["tutti", "Tutti i corsi"], ...d.courses.map((x) => [x.id, x.name])]
      .map(([k, l]) => `<button type="button" data-course="${esc(k)}" aria-pressed="${ui.course === k}">${esc(l)}</button>`).join("");
    let body;
    if (ui.filter === "ann") {
      body = list(d.announcements.filter(byCourse).sort((a, b) => (b.created || 0) - (a.created || 0)).map(annItem).join(""), "Nessun annuncio.");
    } else {
      let ts = d.tasks.filter(byCourse);
      if (ui.filter === "todo") ts = ts.filter((t) => !t.done).sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
      else ts = ts.sort((a, b) => (b.due ?? b.created ?? 0) - (a.due ?? a.created ?? 0));
      body = list(ts.map((t) => taskItem(t, now)).join(""), ui.filter === "todo" ? "Niente da consegnare." : "Nessun compito.");
    }
    const ce = d.errors.classroomCourses ? `<div class="banner warn">Alcuni corsi non si sono caricati: ${esc(d.errors.classroomCourses.join("; "))}</div>` : "";
    return `<div class="filters" role="group">${f}</div><div class="filters" role="group">${c}</div>${ce}<section class="block">${body}</section>`;
  }

  function renderMail(kind) {
    const d = data;
    if (d.errors[kind]) return errBox(d.errors[kind]);
    const ms = [...d[kind]].sort((a, b) => (b.date || 0) - (a.date || 0));
    const q = kind === "argo" ? cfg.argoQuery : cfg.mailQuery;
    return `<p class="hint" style="margin-top:14px">Ricerca: <code>${esc(q)}</code></p>
      <section class="block" style="margin-top:10px">${list(ms.map((m) => mailItem(m, kind)).join(""), "Nessuna email trovata.")}</section>`;
  }

  function renderAccount() {
    return `<div class="card"><span class="eyebrow">Account collegato</span>
        <p style="margin:.5em 0 0;overflow-wrap:anywhere"><b>${esc(cfg.email || "Nessuno")}</b></p>
        <div class="actions"><button class="btn" type="button" data-act="switch">Cambia account</button>
        <button class="btn danger" type="button" data-act="logout">Esci</button></div></div>
      <form id="qForm">
        <label for="argoQ">Ricerca email Argo</label>
        <p class="hint">Sintassi di ricerca Gmail. Quando vedi da che indirizzo arrivano le email di Argo, metti per esempio <code>from:indirizzo</code>.</p>
        <input type="text" id="argoQ" value="${esc(cfg.argoQuery)}" autocomplete="off" spellcheck="false">
        <label for="mailQ">Ricerca per la sezione Posta</label>
        <input type="text" id="mailQ" value="${esc(cfg.mailQuery)}" autocomplete="off" spellcheck="false">
        <div class="actions"><button class="btn solid" type="submit">Salva e aggiorna</button><button class="btn" type="button" data-act="resetq">Ripristina</button></div>
      </form>
      <div class="card"><span class="eyebrow">Client ID</span><p class="hint" style="overflow-wrap:anywhere">${esc(cfg.clientId)}</p>
        <div class="actions"><button class="btn" type="button" data-act="editcid">Cambia Client ID</button></div></div>
      <div class="card"><span class="eyebrow">Installazione</span><p style="margin:.4em 0 0">Da Chrome: menu ⋮ → <b>Installa app</b> o <b>Aggiungi a schermata Home</b>.</p></div>`;
  }

  function render() {
    const setup = !cfg.clientId || ui.view === "setup";
    const needLogin = !setup && !data;
    const v = setup ? "setup" : needLogin ? "login" : ui.view;
    $("#titleText").textContent = setup ? "Bacheca Scuola" : needLogin ? "Bacheca Scuola" : TITLES[v];
    $("#subtitle").textContent = data && !setup ? (cfg.email ? cfg.email + " · " : "") + "agg. " + fmtDateTime(data.updatedAt) : "";
    $("#nav").hidden = setup || needLogin;
    const rb = $("#refresh"); rb.hidden = setup || needLogin; rb.disabled = ui.loading;
    rb.querySelector(".ico").outerHTML = ui.loading ? '<span class="ico spin"></span>' : '<span class="ico">↻</span>';
    rb.querySelector(".lbl").textContent = ui.loading ? "Carico…" : "Aggiorna";
    let html;
    if (setup) html = renderSetup();
    else if (needLogin) html = renderLogin();
    else if (v === "home") html = renderHome();
    else if (v === "classroom") html = renderClassroom();
    else if (v === "argo") html = renderMail("argo");
    else if (v === "posta") html = renderMail("posta");
    else html = renderAccount();
    $("#view").innerHTML = html;
    document.querySelectorAll(".navbtn").forEach((b) => (b.dataset.view === v ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  }

  function setStatus(kind, title, text) {
    $("#status").innerHTML = kind ? `<div class="banner ${kind}" role="status"><b>${esc(title)}</b>${esc(text)}</div>` : "";
  }

  // ---------- Dettaglio ----------
  function openSheet(html) { $("#sheet").innerHTML = html; $("#sheetBg").hidden = false; $("#sheet").hidden = false; const c = $("#closeSheet"); if (c) c.focus(); }
  function closeSheet() { $("#sheetBg").hidden = true; $("#sheet").hidden = true; }
  const closeBtn = '<button class="btn" id="closeSheet" type="button">Chiudi</button>';

  function showTask(t) {
    const rel = t.due != null ? relDue(t.due) : "";
    const grade = t.grade != null ? `<div class="meta">Voto: ${esc(t.grade)}${t.maxPoints ? "/" + esc(t.maxPoints) : ""}</div>` : "";
    openSheet(`<span class="chips"><span class="chip classroom">${esc(t.course)}</span>${t.done ? '<span class="chip">consegnato</span>' : rel ? `<span class="chip due">${esc(rel)}</span>` : ""}</span>
      <h3>${esc(t.title)}</h3>
      <div class="meta">${t.due != null ? "Scadenza: " + esc(fmtDay(t.due)) + " " + esc(new Date(t.due).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })) : "Senza scadenza"}</div>${grade}
      <div class="full">${esc(t.description || "Nessuna descrizione.")}</div>
      <div class="actions">${t.link ? `<a class="btn solid" href="${esc(t.link)}" target="_blank" rel="noopener">Apri in Classroom</a>` : ""}${closeBtn}</div>`);
  }
  function showAnn(a) {
    openSheet(`<span class="chips"><span class="chip classroom">${esc(a.course)}</span><span class="chip">annuncio</span></span>
      <h3>${esc(a.course)}</h3><div class="meta">${a.created ? esc(fmtDateTime(a.created)) : ""}</div>
      <div class="full">${esc(a.text)}</div>
      <div class="actions">${a.link ? `<a class="btn solid" href="${esc(a.link)}" target="_blank" rel="noopener">Apri in Classroom</a>` : ""}${closeBtn}</div>`);
  }
  async function showMail(m, kind) {
    const gmailLink = `https://mail.google.com/mail/?authuser=${encodeURIComponent(cfg.email || "")}#all/${encodeURIComponent(m.id)}`;
    const head = `<span class="chips"><span class="chip ${kind === "argo" ? "argo" : ""}">${esc(m.from)}</span></span>
      <h3>${esc(m.subject)}</h3><div class="meta">${m.date ? esc(fmtDateTime(m.date)) : ""}</div>`;
    const foot = `<div class="actions"><a class="btn solid" href="${esc(gmailLink)}" target="_blank" rel="noopener">Apri in Gmail</a>${closeBtn}</div>`;
    openSheet(head + `<div class="full" id="mailBody">${esc(m.snippet)}\n\n<span class="spin"></span></div>` + foot);
    try {
      if (!tokenValid()) throw new Error("no token");
      const full = await api(`${GM}/messages/${m.id}?format=full`);
      const txt = extractText(full.payload) || m.snippet;
      const el = $("#mailBody"); if (el) el.textContent = txt.slice(0, 20000);
    } catch (e) {
      const el = $("#mailBody"); if (el) el.textContent = m.snippet + "\n\n(Testo completo non disponibile ora: premi Aggiorna o aprila in Gmail.)";
    }
  }

  // ---------- Eventi ----------
  document.addEventListener("click", (e) => {
    const t = e.target;
    const nb = t.closest(".navbtn"); if (nb) { ui.view = nb.dataset.view; ui.filter = "todo"; ui.course = "tutti"; render(); scrollTo(0, 0); return; }
    const go = t.closest("[data-go]"); if (go) { ui.view = go.dataset.go; ui.filter = "todo"; render(); scrollTo(0, 0); return; }
    const fb = t.closest("[data-filter]"); if (fb) { ui.filter = fb.dataset.filter; render(); return; }
    const cb = t.closest("[data-course]"); if (cb) { ui.course = cb.dataset.course; render(); return; }
    const it = t.closest(".item");
    if (it) {
      const kind = it.dataset.kind, id = it.dataset.id;
      if (kind === "task") { const x = data.tasks.find((q) => q.courseId + ":" + q.id === id); if (x) showTask(x); }
      else if (kind === "ann") { const x = data.announcements.find((q) => q.courseId + ":" + q.id === id); if (x) showAnn(x); }
      else { const x = data[kind].find((q) => q.id === id); if (x) showMail(x, kind); }
      return;
    }
    if (t.id === "sheetBg" || t.closest("#closeSheet")) { closeSheet(); return; }
    const act = t.closest("[data-act]") && t.closest("[data-act]").dataset.act;
    if (act === "login") refresh(true);
    else if (act === "switch") { signOut(); render(); refresh(true); }
    else if (act === "logout") { signOut(); setStatus(null); ui.view = "home"; render(); }
    else if (act === "resetq") { cfg.argoQuery = DEFAULTS.argoQuery; cfg.mailQuery = DEFAULTS.mailQuery; saveCfg(); render(); }
    else if (act === "editcid") { ui.view = "setup"; render(); }
  });
  $("#refresh").addEventListener("click", () => refresh(false));
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "setupForm") {
      const v = $("#cid").value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)) { setStatus("warn", "Client ID non valido", "Deve finire con .apps.googleusercontent.com"); return; }
      if (v !== cfg.clientId) { signOut(); tokenClient = null; }
      cfg.clientId = v; saveCfg(); ui.view = "home"; setStatus(null); render(); refresh(true);
    } else if (e.target.id === "qForm") {
      cfg.argoQuery = $("#argoQ").value.trim() || DEFAULTS.argoQuery;
      cfg.mailQuery = $("#mailQ").value.trim() || DEFAULTS.mailQuery;
      saveCfg(); refresh(false);
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  // ---------- Avvio ----------
  render();
  if (cfg.clientId && data && tokenValid()) refresh(false);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // Per i test
  window.__bacheca = { dueToMs, relDue, buildSummary, extractText, cleanFrom };
})();
