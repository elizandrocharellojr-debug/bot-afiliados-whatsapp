const SERVER_URL = 'http://127.0.0.1:4545/post';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'POST_DEAL') return;

  fetch(SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message.payload),
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      sendResponse({ ok: res.ok && data.ok, error: data.error });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: 'Nao consegui falar com o bot (ele esta rodando? "npm start")' });
    });

  return true; // resposta assincrona
});
