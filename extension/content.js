// Content script: lê título/preço/condição do anúncio aberto e registra o histórico local de preços.
(() => {
  if (window.top !== window) return;
  const { SOURCES, parsePrice } = CP;
  const $ = (root, sel) => root.querySelector(sel);

  function fromJsonLd() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const list = Array.isArray(data) ? data : [data, ...(data["@graph"] || [])];
        for (const d of list) {
          if (d && d["@type"] === "Product") {
            const offer = Array.isArray(d.offers) ? d.offers[0] : d.offers;
            const price = parsePrice(offer && (offer.price || offer.lowPrice));
            if (d.name && price) return { title: d.name, price };
          }
        }
      } catch (_) {}
    }
    return null;
  }

  const PAGE = {
    ml: {
      host: /mercadolivre\.com\.br$/,
      current: () => ({
        title: $(document, "h1.ui-pdp-title")?.textContent.trim(),
        price: parsePrice($(document, 'meta[itemprop="price"]')?.content) ??
               parsePrice($(document, ".ui-pdp-price__second-line .andes-money-amount__fraction")?.textContent),
      }),
      cond: () => {
        const t = $(document, ".ui-pdp-subtitle, .ui-pdp-header__subtitle")?.textContent || "";
        return /usado/i.test(t) ? "usado" : /novo/i.test(t) ? "novo" : null;
      },
    },
    amazon: {
      host: /amazon\.com\.br$/,
      current: () => ({
        title: $(document, "#productTitle")?.textContent.trim(),
        price: parsePrice($(document, "#corePrice_feature_div .a-offscreen, .a-price .a-offscreen")?.textContent),
      }),
      cond: () => "novo",
    },
  };

  const found = Object.entries(PAGE).find(([, p]) => p.host.test(location.hostname));
  if (!found) return;
  const [currentKey, page] = found;

  const state = { status: "loading", currentKey, storeName: SOURCES[currentKey].name };
  chrome.runtime.onMessage.addListener((msg, _s, send) => { if (msg.type === "getState") send(state); });

  async function saveHistory(productKey, price) {
    const k = `hist:${productKey}`;
    try {
      const got = await chrome.storage.local.get(k);
      const arr = got[k] || [];
      const last = arr[arr.length - 1], now = Date.now();
      if (!last || last.p !== price || now - last.t > 12 * 3600 * 1000) arr.push({ t: now, p: price });
      while (arr.length > 300) arr.shift();
      await chrome.storage.local.set({ [k]: arr });
      return arr;
    } catch (_) { return []; }
  }

  async function init() {
    let { title, price } = page.current();
    if (!title || !price) {
      const ld = fromJsonLd();
      if (ld) { title = title || ld.title; price = price || ld.price; }
    }
    if (!title || !price) { state.status = "notproduct"; return; }
    const idPart = SOURCES[currentKey].idFromUrl(location.href) || location.origin + location.pathname;
    Object.assign(state, { title, price, cond: page.cond(), url: location.href });
    state.history = await saveHistory(`${currentKey}:${idPart}`, price);
    state.status = "ready";
  }
  setTimeout(init, 1200);
})();
