const { SOURCES, median, coreModel, buildSpec, detectBrand, shortQuery, searchSource } = CP;
const $ = (id) => document.getElementById(id);
const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const ORDER = Object.keys(SOURCES); // ml primeiro (marketplace principal)
const OUTLIER_RATIO = 0.5;          // preço < 50% da mediana é tratado como suspeito (mín. 6 anúncios)

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "onclick") el.addEventListener("click", v);
    else if (k === "open") { if (v) el.setAttribute("open", ""); }
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

let ctx = null, results = {}, runId = 0, autoValue = "";
const expanded = {};
const prefs = { generic: true, cond: "todos", junk: true, systems: true, off: [], lastQuery: "" };
const savePrefs = () => chrome.storage.local.set({ prefs });

// ---------- página de produto aberta na aba ----------
async function getCtx() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  for (let i = 0; i < 6; i++) {
    let s = null;
    try { s = await chrome.tabs.sendMessage(tab.id, { type: "getState" }); } catch (_) { return null; }
    if (s && s.status === "ready") return s;
    if (s && s.status === "notproduct") return null;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function autoQuery() {
  if (!ctx) return "";
  if (!$("generic").checked) return shortQuery(ctx.title);
  return coreModel(ctx.title)?.query ?? buildSpec(ctx.title, { generic: true }).query;
}

// ---------- controles ----------
for (const [k, s] of Object.entries(SOURCES)) {
  const cb = h("input", { type: "checkbox", id: "src-" + k });
  cb.addEventListener("change", () => { prefs.off = ORDER.filter((x) => !$("src-" + x).checked); savePrefs(); run(); });
  $("sources").append(h("label", { id: "lbl-" + k }, cb, " " + s.name + "  "));
}
function syncSources() {
  const c = $("cond").value;
  for (const k of ORDER) {
    const ok = c === "todos" || SOURCES[k].conditions.includes(c);
    $("src-" + k).disabled = !ok;
    $("lbl-" + k).classList.toggle("off", !ok);
    $("lbl-" + k).title = ok ? "" : "Esta loja não tem esse tipo de anúncio";
  }
}
const enabled = (k) => !$("src-" + k).disabled && $("src-" + k).checked;

$("moreBtn").addEventListener("click", () => $("more").classList.toggle("hidden"));
$("generic").addEventListener("change", () => {
  prefs.generic = $("generic").checked; savePrefs();
  if (ctx && ($("q").value.trim() === autoValue || !$("q").value.trim())) { autoValue = autoQuery(); $("q").value = autoValue; }
  run();
});
$("cond").addEventListener("change", () => { prefs.cond = $("cond").value; savePrefs(); syncSources(); run(); });
for (const id of ["junk", "systems"]) $(id).addEventListener("change", () => { prefs[id] = $(id).checked; savePrefs(); run(); });
$("pmin").addEventListener("input", () => renderResults());
$("pmax").addEventListener("input", () => renderResults());
$("f").addEventListener("submit", (e) => { e.preventDefault(); run(); });

// ---------- busca ----------
async function run() {
  const text = $("q").value.trim();
  if (!text) return;
  prefs.lastQuery = text; savePrefs();
  const id = ++runId;
  const cond = $("cond").value, generic = $("generic").checked;
  const spec = buildSpec(text, { generic, junk: $("junk").checked, systems: $("systems").checked });
  const why = !generic ? "busca exata" : spec.core ? "modelo reconhecido · todas as marcas" : "modelo não reconhecido · marcas removidas";
  $("info").textContent = `Procurando por "${spec.query}" (${why})`;

  const keys = ORDER.filter((k) => enabled(k));
  results = {};
  keys.forEach((k) => (results[k] = { state: "loading" }));
  renderResults();

  const self = ctx ? { url: ctx.url, title: ctx.title, price: ctx.price } : null;
  await Promise.all(keys.map(async (k) => {
    try {
      const r = await searchSource(k, spec.query, { cond, spec, limit: k === "ml" ? 48 : 30, self });
      if (id === runId) results[k] = { state: "done", ...r };
    } catch (e) {
      if (id === runId) results[k] = { state: "error", error: e.message };
    }
    if (id === runId) renderResults();
  }));
}

// ---------- resultados ----------
function sparkline(history) {
  const W = 500, H = 56, pad = 4, ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const ps = history.map((e) => e.p), min = Math.min(...ps), max = Math.max(...ps);
  const t0 = history[0].t, t1 = history[history.length - 1].t;
  const x = (t) => pad + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (W - 2 * pad));
  const y = (p) => (max === min ? H / 2 : H - pad - ((p - min) / (max - min)) * (H - 2 * pad));
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", history.map((e) => `${x(e.t).toFixed(1)},${y(e.p).toFixed(1)}`).join(" "));
  line.setAttribute("fill", "none"); line.setAttribute("stroke", "#2563eb"); line.setAttribute("stroke-width", "2");
  svg.append(line);
  return svg;
}

function historyBlock() {
  const hist = ctx.history || [];
  const ps = hist.map((e) => e.p);
  const body = [];
  if (!ps.length) body.push(h("div", { class: "muted" }, "Sem registros ainda."));
  else {
    const min = Math.min(...ps), max = Math.max(...ps), avg = ps.reduce((a, b) => a + b, 0) / ps.length;
    let verdict, cls = "";
    if (ps.length < 2) verdict = "Primeiro registro deste anúncio. Volte outro dia para ver a variação.";
    else if (ctx.price <= min) { verdict = "✅ Menor preço já registrado!"; cls = "cheaper"; }
    else { const pct = Math.round(((ctx.price - min) / min) * 100); verdict = `${pct}% acima do menor preço registrado`; cls = pct > 10 ? "pricier" : ""; }
    body.push(h("div", { class: cls, style: "font-weight:600" }, verdict),
      h("div", { class: "stats" },
        h("div", {}, h("span", { class: "muted" }, "Mínimo"), h("b", {}, brl(min))),
        h("div", {}, h("span", { class: "muted" }, "Média"), h("b", {}, brl(avg))),
        h("div", {}, h("span", { class: "muted" }, "Máximo"), h("b", {}, brl(max)))));
    if (hist.length >= 2) body.push(sparkline(hist));
    body.push(h("div", { class: "muted" }, `${hist.length} registro(s) desde ${new Date(hist[0].t).toLocaleDateString("pt-BR")} (salvo neste navegador)`));
  }
  return h("details", {}, h("summary", {}, "Histórico de preços deste anúncio"), ...body);
}

function itemRow(it) {
  const pct = ctx ? Math.round(((it.price - ctx.price) / ctx.price) * 100) : null;
  const delta = pct == null ? null : h("span", { class: pct < 0 ? "cheaper" : "pricier" }, ` ${pct < 0 ? "−" : "+"}${Math.abs(pct)}%`);
  return h("div", { class: "row" },
    h("span", { class: "p" }, brl(it.price), delta),
    h("a", { href: it.url || "#", target: "_blank", rel: "noopener", title: it.title }, it.title),
    h("span", { class: "meta" }, detectBrand(it.title), it.cond ? h("span", { class: `tag ${it.cond}` }, it.cond) : null));
}

function renderResults() {
  const pmin = parseFloat($("pmin").value) || 0, pmax = parseFloat($("pmax").value) || Infinity;
  const filtered = {};
  for (const k of ORDER) {
    const r = results[k];
    if (r && r.state === "done") filtered[k] = r.items.filter((i) => i.price >= pmin && i.price <= pmax);
  }
  const everything = Object.values(filtered).flat();
  // preços muito abaixo da mediana (golpe, peça avulsa, anúncio errado) ficam fora das estatísticas
  const thr = everything.length >= 6 ? median(everything.map((i) => i.price)) * OUTLIER_RATIO : 0;
  const suspicious = everything.filter((i) => i.price < thr).sort((a, b) => a.price - b.price);
  const bySource = {};
  for (const k of Object.keys(filtered)) bySource[k] = filtered[k].filter((i) => i.price >= thr).sort((a, b) => a.price - b.price);
  const all = Object.values(bySource).flat().sort((a, b) => a.price - b.price);

  // --- status por loja ---
  const st = $("status"); st.replaceChildren();
  for (const k of ORDER) {
    const r = results[k]; if (!r) continue;
    const name = SOURCES[k].name;
    if (r.state === "loading") st.append(h("div", { class: "muted" }, `${name}: buscando…`));
    else if (r.state === "error") st.append(h("div", { class: "warn" }, `${name}: ✗ não foi possível consultar (${r.error})`));
    else {
      const parts = [`${name}: ${r.items.length} anúncio(s)`];
      if (r.raw === 0) parts.push(` ⚠ a página veio sem anúncios legíveis${r.pageTitle ? ` (título recebido: "${r.pageTitle}")` : ""} — pode ser bloqueio ou mudança de layout`);
      else if (r.raw !== r.items.length) parts.push(` (de ${r.raw} lidos; o resto foi filtrado)`);
      st.append(h("div", { class: r.raw === 0 ? "warn" : "muted" }, parts.join(""), " ", h("a", { href: r.url, target: "_blank", rel: "noopener" }, "abrir busca ↗")));
      if (r.condVerified === false) st.append(h("div", { class: "warn" }, `${name}: ⚠ o filtro de condição parece não ter sido aplicado; a condição dos anúncios é desconhecida.`));
      for (const n of r.notes || []) st.append(h("div", { class: "muted" }, `${name}: ${n}`));
    }
  }

  // --- contexto: anúncio aberto ---
  const cx = $("ctx"); cx.replaceChildren();
  if (ctx) {
    const mlMed = bySource.ml && bySource.ml.length ? median(bySource.ml.map((i) => i.price)) : null;
    const rank = all.filter((i) => i.price < ctx.price).length + 1;
    const lines = [h("div", { class: "muted" }, `Você está vendo (${ctx.storeName}${ctx.cond ? " · " + ctx.cond : ""})`),
      h("div", { class: "big" }, brl(ctx.price)),
      h("div", { class: "muted", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: ctx.title }, ctx.title)];
    if (all.length) lines.push(h("div", {}, `Posição: ${rank}º mais barato entre ${all.length + 1} anúncios` +
      (mlMed ? ` · ${ctx.price <= mlMed ? "abaixo" : "acima"} da mediana do Mercado Livre (${brl(mlMed)})` : "")));
    cx.append(h("div", { class: "card same" }, ...lines), historyBlock());
  }

  // --- saída ---
  const out = $("out"); out.replaceChildren();
  if (!all.length && !suspicious.length) {
    if (Object.values(results).every((r) => r.state !== "loading"))
      out.append(h("div", { class: "card" }, "Nenhum anúncio encontrado com esses filtros. Tente desligar os filtros ou usar a busca genérica."));
    return;
  }

  const ml = bySource.ml || [];
  if (ml.length) {
    const p = ml.map((i) => i.price);
    out.append(h("div", { class: "card ref" },
      h("h3", {}, "Mercado Livre — referência", h("span", { class: "muted" }, `${ml.length} anúncios`)),
      h("div", { class: "stats" },
        h("div", {}, h("span", { class: "muted" }, "Menor"), h("b", {}, brl(p[0]))),
        h("div", {}, h("span", { class: "muted" }, "Mediana"), h("b", {}, brl(median(p)))),
        h("div", {}, h("span", { class: "muted" }, "Maior"), h("b", {}, brl(p[p.length - 1]))))));
  }

  if (all.length) {
    const best = all[0];
    out.append(h("div", { class: "card best" },
      h("div", { class: "muted" }, "Menor preço encontrado (todas as lojas)"),
      h("div", { class: "big" }, brl(best.price)),
      h("div", {}, `${best.store}${best.cond ? " · " + best.cond : ""}`),
      h("a", { href: best.url || "#", target: "_blank", rel: "noopener" }, best.title)));
  }

  for (const k of ORDER) {
    const list = bySource[k]; if (!list) continue;
    const isMl = k === "ml", lim = expanded[k] ? list.length : isMl ? 10 : 5;
    const det = h("details", { class: isMl ? "main" : "", open: true },
      h("summary", {}, `${SOURCES[k].name}${isMl ? " (principal)" : ""} — ${list.length}`));
    if (!list.length) det.append(h("div", { class: "muted" }, "Nenhum resultado."));
    list.slice(0, lim).forEach((it) => det.append(itemRow(it)));
    if (list.length > lim) det.append(h("button", { class: "more-btn", onclick: () => { expanded[k] = true; renderResults(); } }, `mostrar todos (${list.length})`));
    out.append(det);
  }

  if (suspicious.length) {
    const det = h("details", { class: "sus" }, h("summary", {}, `⚠ ${suspicious.length} preço(s) suspeito(s) — abaixo de ${OUTLIER_RATIO * 100}% da mediana`),
      h("div", { class: "muted" }, "Podem ser golpe, peça avulsa ou anúncio com valor errado. Ficaram fora das estatísticas."));
    suspicious.slice(0, 10).forEach((it) => det.append(itemRow(it)));
    out.append(det);
  }

  const byBrand = new Map();
  for (const it of all) { const b = detectBrand(it.title) || "Não identificada"; if (!byBrand.has(b)) byBrand.set(b, []); byBrand.get(b).push(it.price); }
  if (byBrand.size > 1) {
    const rows = [...byBrand.entries()].sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]));
    out.append(h("details", {}, h("summary", {}, "Por marca"),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Marca"), h("th", {}, "Anúncios"), h("th", {}, "Menor"), h("th", {}, "Mediana"))),
        h("tbody", {}, rows.map(([b, p]) => h("tr", {}, h("td", {}, b), h("td", {}, String(p.length)), h("td", {}, brl(Math.min(...p))), h("td", {}, brl(median(p)))))))));
  }
}

// ---------- início ----------
(async function init() {
  const got = await chrome.storage.local.get("prefs");
  Object.assign(prefs, got.prefs || {});
  $("generic").checked = prefs.generic; $("junk").checked = prefs.junk; $("systems").checked = prefs.systems;
  $("cond").value = prefs.cond;
  for (const k of ORDER) $("src-" + k).checked = !prefs.off.includes(k);
  syncSources();

  $("info").textContent = "Lendo a página aberta…";
  ctx = await getCtx();
  if (ctx) {
    if (ctx.cond) { $("cond").value = ctx.cond; syncSources(); }
    autoValue = autoQuery();
    $("q").value = autoValue;
    run();
  } else {
    $("info").textContent = "Digite um produto para comparar (ou abra a página de um produto).";
    $("q").value = prefs.lastQuery || "";
    $("q").focus();
  }
})();
