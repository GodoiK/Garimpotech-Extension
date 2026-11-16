// Núcleo compartilhado: leitura das lojas (Mercado Livre e Amazon) e motor de correspondência de produtos.
// Roda no popup (extension page) e nos content scripts; também é importável em Node para testes.
(() => {
  const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  function parsePrice(str) {
    if (str == null) return null;
    if (typeof str === "number") return str > 0 ? str : null;
    let s = String(str).replace(/[^\d.,]/g, "");
    if (!s) return null;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // "1.299" = mil duzentos e noventa e nove
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y), m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  // ---------- tokenização ----------
  const STOP = new Set(["de", "da", "do", "das", "dos", "com", "para", "e", "a", "o", "em", "kit", "novo", "nova", "usado", "usada", "seminovo"]);
  function tokens(t) {
    return norm(t)
      .replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2") // rtx4060 -> rtx 4060 ; 8gb -> 8 gb
      .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  }
  const shortQuery = (title) => tokens(title).slice(0, 7).join(" ");

  // ---------- marcas e linhas de produto ----------
  const BRANDS = {
    msi: "MSI", asus: "ASUS", gigabyte: "Gigabyte", aorus: "Gigabyte", galax: "Galax", zotac: "Zotac", pny: "PNY",
    palit: "Palit", gainward: "Gainward", sapphire: "Sapphire", powercolor: "PowerColor", xfx: "XFX", asrock: "ASRock",
    evga: "EVGA", colorful: "Colorful", inno3d: "Inno3D", afox: "Afox", maxsun: "Maxsun", biostar: "Biostar",
    leadtek: "Leadtek", corsair: "Corsair", kingston: "Kingston", adata: "ADATA", xpg: "XPG", crucial: "Crucial",
    hyperx: "HyperX", skill: "G.Skill", patriot: "Patriot", redragon: "Redragon", lexar: "Lexar", samsung: "Samsung",
    seagate: "Seagate", toshiba: "Toshiba", netac: "Netac", kingspec: "KingSpec", pichau: "Pichau", husky: "Husky",
    mancer: "Mancer", western: "WD", wd: "WD",
  };
  const LINES = new Set(["oc", "gaming", "ventus", "tuf", "rog", "strix", "dual", "eagle", "windforce", "twin", "edge", "ghost",
    "trio", "suprim", "gamerock", "fighter", "challenger", "pulse", "nitro", "hellhound", "phantom", "mech", "armor", "ultra",
    "plus", "black", "white", "nvidia", "amd", "intel", "geforce", "radeon"]);
  function detectBrand(title) {
    for (const t of tokens(title)) if (BRANDS[t]) return BRANDS[t];
    return "";
  }

  // ---------- modelo "núcleo" (busca genérica) ----------
  const V_GPU = new Set(["ti super", "ti", "super", "xtx", "xt", "gre"]);
  const V_AMD = new Set(["x3d", "xt", "x", "gt", "ge", "g", "f"]);
  const V_INTEL = new Set(["kf", "ks", "k", "f", "t", "h", "hx", "u", "p"]);

  function coreModel(text) {
    const s = " " + tokens(text).join(" ") + " ";
    let m;
    if ((m = s.match(/ (rtx|gtx|gt|rx) (\d{3,4})(?: (ti super|ti|super|xtx|xt|gre))? /))) {
      const mem = (s.match(/ (\d{1,2}) gb /) || [])[1];
      const memN = mem && +mem <= 24 ? +mem : null;
      const variant = m[3] || "";
      return { type: "gpu", pre: [m[1]], num: m[2], variant, vset: V_GPU, mem: memN,
        query: `${m[1]} ${m[2]}${variant ? " " + variant : ""}${memN ? " " + memN + "gb" : ""}` };
    }
    if ((m = s.match(/ ryzen (\d) (\d{4})(?: (x 3 d|xt|x|gt|ge|g|f))? /))) {
      const variant = (m[3] || "").replace(/ /g, "");
      return { type: "cpu", pre: ["ryzen", m[1]], num: m[2], variant, vset: V_AMD, query: `ryzen ${m[1]} ${m[2]}${variant}` };
    }
    if ((m = s.match(/ i (\d) (\d{4,5})(?: (kf|ks|k|f|t|h|hx|u|p))? /))) {
      const variant = m[3] || "";
      return { type: "cpu", pre: ["i", m[1]], num: m[2], variant, vset: V_INTEL, query: `i${m[1]} ${m[2]}${variant}` };
    }
    if ((m = s.match(/ ddr (3|4|5) /))) {
      const cap = s.match(/ (4|8|16|32|64|128) gb /);
      if (cap) return { type: "ram", all: ["ddr", m[1], cap[1], "gb"], query: `ddr${m[1]} ${cap[1]}gb` };
    }
    if (/ (ssd|nvme) /.test(s)) {
      const cap = s.match(/ (\d{3,4}) gb | (\d) tb /);
      if (cap) {
        const num = cap[1] || cap[2], unit = cap[1] ? "gb" : "tb";
        return { type: "ssd", all: [num, unit], any: ["ssd", "nvme"], query: `ssd${/ nvme /.test(s) ? " nvme" : ""} ${num}${unit}` };
      }
    }
    return null;
  }

  function variantAt(tk, i, vset) {
    if (vset.has("x3d") && tk.slice(i + 1, i + 4).join("") === "x3d") return "x3d";
    if (vset.has("ti super") && tk[i + 1] === "ti" && tk[i + 2] === "super") return "ti super";
    return vset.has(tk[i + 1]) ? tk[i + 1] : "";
  }

  // Anúncios de usados costumam omitir "RTX" ("Placa de vídeo 4060 8gb"): aceitamos se houver
  // palavra-pista de GPU e o token anterior não for outra série (ex.: GTX 1030 != GT 1030).
  const GPU_HINTS = new Set(["geforce", "gpu", "placa", "video", "nvidia", "radeon"]);
  const GPU_SERIES = new Set(["rtx", "gtx", "gt", "rx", "arc", "r", "hd"]);

  function matchesCore(tk, c) {
    if (c.num) {
      const hint = c.type === "gpu" && tk.some((t) => GPU_HINTS.has(t));
      for (let i = 0; i < tk.length; i++) {
        if (tk[i] !== c.num) continue;
        const preOk = i >= c.pre.length && c.pre.every((p, j) => tk[i - c.pre.length + j] === p);
        if (!preOk && !(hint && !GPU_SERIES.has(tk[i - 1]))) continue;
        if (variantAt(tk, i, c.vset) !== c.variant) continue; // 4060 != 4060 Ti ; 5600 != 5600X
        return true;
      }
      return false;
    }
    const set = new Set(tk);
    return c.all.every((t) => set.has(t)) && (!c.any || c.any.some((t) => set.has(t)));
  }

  // ---------- filtros de qualidade ----------
  // "sem defeito" NÃO é defeito: remove frases negadas antes de procurar palavras de problema.
  const NEGATED = /\b(sem|nenhum|nenhuma|zero|nao tem|nao possui)( nenhum| nenhuma)? (defeitos?|problemas?|avarias?|detalhes?|marcas?)\b|\bgarantia (contra |de )?defeitos?\b|\bdefeito de fabrica\b/g;
  const JUNK = /\bdefeit\w*|\bsucata\b|\bpecas\b|retirada de peca|queimad|nao funciona|nao liga|conserto|artefato|com problema|sem video|sem imagem|caixa vazia|so a caixa|somente a caixa|dummy plug|anti ?sag|water ?block|backplate/;
  const ACCESSORY_START = /^(suporte|cabo|riser|adaptador|bloco|pasta termica|thermal pad|adesivo|extensor|bracket|capa|protetor|kit de)\b/;
  const SYSTEMS = /notebook|laptop|pc gamer|pc completo|computador|desktop|cpu gamer|gabinete gamer|all in one/;

  function buildSpec(text, o = {}) {
    let core = null, query = text.trim();
    if (o.generic) {
      core = coreModel(text);
      if (core) query = core.query;
      else query = tokens(text).filter((t) => !BRANDS[t] && !LINES.has(t)).slice(0, 5).join(" ") || text.trim();
    }
    return { query, core, tokens: tokens(query), ratio: o.generic ? 0.7 : 0.6, junk: !!o.junk, systems: !!o.systems && !!core };
  }

  function relevant(it, spec) {
    if (!it.title || !it.price) return false;
    const tk = tokens(it.title), n = norm(it.title);
    if (spec.core) {
      if (!matchesCore(tk, spec.core)) return false;
      if (spec.core.mem) {
        const gbs = [];
        tk.forEach((t, i) => { if (tk[i + 1] === "gb" && /^\d+$/.test(t)) gbs.push(+t); });
        if (gbs.length && !gbs.includes(spec.core.mem)) return false; // 8GB != 16GB
      }
    } else {
      const set = new Set(tk);
      if (spec.tokens.filter((w) => set.has(w)).length < Math.ceil(spec.tokens.length * spec.ratio)) return false;
    }
    if (spec.junk) {
      const clean = n.replace(NEGATED, " ");
      if (JUNK.test(clean) || ACCESSORY_START.test(n.trim())) return false;
    }
    if (spec.systems && SYSTEMS.test(n)) return false;
    return true;
  }

  // ---------- lojas ----------
  const $ = (root, sel) => root.querySelector(sel);

  const SOURCES = {
    ml: {
      name: "Mercado Livre", conditions: ["novo", "usado"],
      idFromUrl: (u) => { const m = String(u || "").match(/MLB-?(\d+)/i); return m ? "MLB" + m[1] : null; },
      // relevância + ordenado por preço (o mais barato nem sempre está na 1ª página por relevância)
      // + "controle" sem filtro de condição, para verificar se o filtro realmente funcionou
      searchUrls: (q, cond) => {
        const base = `https://lista.mercadolivre.com.br/${encodeURIComponent(q.trim().replace(/\s+/g, "-"))}`;
        const c = cond === "usado" ? "_ITEM*CONDITION_2230581" : cond === "novo" ? "_ITEM*CONDITION_2230284" : "";
        const urls = [{ kind: "relevancia", url: base + c }, { kind: "preco", url: `${base}_OrderId_PRICE${c}` }];
        if (c) urls.push({ kind: "controle", url: base });
        return urls;
      },
      parse: (doc) => {
        const base = "https://lista.mercadolivre.com.br";
        const abs = (a) => (a && a.getAttribute("href") ? new URL(a.getAttribute("href"), base).href : null);
        const mlPrice = (root) => {
          const ok = (a) => !a.matches('[class*="previous"]') && !a.closest('[class*="previous"]') && !a.closest('[class*="installment"]');
          const amount = root.querySelector(".poly-price__current .andes-money-amount") ||
                         [...root.querySelectorAll(".andes-money-amount")].find(ok);
          if (!amount) return null;
          const frac = amount.querySelector(".andes-money-amount__fraction")?.textContent;
          const cents = amount.querySelector(".andes-money-amount__cents")?.textContent;
          return parsePrice(frac ? `${frac},${cents || "00"}` : null);
        };
        const seen = new Set(), items = [];
        const push = (title, price, url) => {
          if (!title || !price) return;
          const key = (SOURCES.ml.idFromUrl(url) || url || title) + "|" + price;
          if (seen.has(key)) return;
          seen.add(key);
          items.push({ title, price, url });
        };
        // 1) layouts conhecidos
        doc.querySelectorAll("li.ui-search-layout__item, .ui-search-result__wrapper, .poly-card").forEach((el) => {
          const a = el.querySelector("a.poly-component__title, .poly-component__title a, a.ui-search-link, h2 a, h3 a") || el.querySelector("a[href]");
          const t = el.querySelector(".poly-component__title, .ui-search-item__title, h2, h3");
          push((t?.textContent || a?.textContent || "").trim(), mlPrice(el), abs(a));
        });
        // 2) plano B estrutural: link de anúncio + valor no mesmo bloco (resiste a mudanças de classe CSS)
        if (!items.length) {
          doc.querySelectorAll('a[href*="mercadolivre.com.br"]').forEach((a) => {
            const t = a.textContent.trim();
            if (t.length < 20) return;
            let box = a.parentElement;
            for (let i = 0; i < 8 && box; i++, box = box.parentElement) {
              if (box.querySelector(".andes-money-amount__fraction")) { push(t, mlPrice(box), abs(a)); break; }
            }
          });
        }
        return items;
      },
    },
    amazon: {
      name: "Amazon", conditions: ["novo"],
      idFromUrl: (u) => { const m = String(u || "").match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i); return m ? m[1].toUpperCase() : null; },
      searchUrls: (q) => {
        const k = encodeURIComponent(q);
        return [{ kind: "relevancia", url: `https://www.amazon.com.br/s?k=${k}` },
                { kind: "preco", url: `https://www.amazon.com.br/s?k=${k}&s=price-asc-rank` }];
      },
      parse: (doc) =>
        [...doc.querySelectorAll('div[data-component-type="s-search-result"]')].map((el) => {
          const a = $(el, "h2 a") || $(el, "a.a-link-normal[href]");
          return {
            title: $(el, "h2")?.textContent.trim(),
            price: parsePrice($(el, ".a-price .a-offscreen")?.textContent),
            url: a ? new URL(a.getAttribute("href"), "https://www.amazon.com.br").href : null,
          };
        }),
    },
  };

  async function fetchHtml(url) {
    if (location.protocol === "chrome-extension:") {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }
    const res = await chrome.runtime.sendMessage({ type: "fetch", url });
    if (!res || !res.ok) throw new Error(res?.status ? `HTTP ${res.status}` : res?.error || "falha de rede");
    return res.html;
  }

  // opts: { cond: "todos"|"novo"|"usado", spec, limit, self: {url,title,price} }
  async function searchSource(key, query, opts = {}) {
    const src = SOURCES[key], cond = opts.cond || "todos", self = opts.self;
    const reqs = src.searchUrls(query, cond);
    const settled = await Promise.allSettled(reqs.map(async (r) => {
      const doc = new DOMParser().parseFromString(await fetchHtml(r.url), "text/html");
      return { ...r, parsed: src.parse(doc), pageTitle: (doc.title || "").trim().slice(0, 80) };
    }));
    const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
    const main = ok.filter((r) => r.kind !== "controle");
    if (!main.length) throw settled.find((s) => s.status === "rejected")?.reason || new Error("falha na busca");
    const notes = settled.map((s, i) => (s.status === "rejected" && reqs[i].kind === "preco" ? "ordenação por preço indisponível" : null)).filter(Boolean);

    // o filtro de condição funcionou? Se a busca filtrada devolve (quase) o mesmo que a sem filtro, foi ignorado.
    let condVerified = null;
    const ctl = ok.find((r) => r.kind === "controle"), rel = ok.find((r) => r.kind === "relevancia");
    if (ctl && rel && ctl.parsed.length >= 5 && rel.parsed.length >= 5) {
      const ids = (a) => new Set(a.map((i) => src.idFromUrl(i.url) || i.url));
      const A = ids(rel.parsed), B = ids(ctl.parsed);
      let inter = 0; A.forEach((x) => { if (B.has(x)) inter++; });
      condVerified = inter / Math.min(A.size, B.size) < 0.8;
    }
    const label = cond !== "todos" && condVerified !== false ? cond : ""; // sem prova, não rotula

    const seen = new Set(), merged = [];
    for (const r of main) for (const i of r.parsed.slice(0, opts.limit || 48)) {
      const k = (src.idFromUrl(i.url) || i.url || i.title) + "|" + i.price;
      if (!seen.has(k)) { seen.add(k); merged.push(i); }
    }
    const selfId = self?.url ? src.idFromUrl(self.url) : null;
    const items = merged
      .map((i) => ({ ...i, key, store: src.name, cond: /\busad[oa]\b|seminov/.test(norm(i.title)) ? "usado" : label }))
      .filter((i) => relevant(i, opts.spec))
      .filter((i) => !(selfId && src.idFromUrl(i.url) === selfId))                         // o próprio anúncio nunca entra
      .filter((i) => !(self && self.price === i.price && norm(self.title) === norm(i.title)));
    return { url: main[0].url, items, raw: merged.length, pageTitle: main[0].pageTitle, condVerified, notes };
  }

  globalThis.CP = { SOURCES, parsePrice, median, tokens, norm, shortQuery, coreModel, buildSpec, relevant, detectBrand, searchSource, fetchHtml };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.CP;
})();
