// Service worker (MV3): faz as requisições às lojas em nome do content script.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "fetch") {
    fetch(msg.url, { credentials: "include" })
      .then(async (r) => ({ ok: r.ok, status: r.status, html: await r.text() }))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, error: String(e) }));
    return true; // resposta assíncrona
  }
});
