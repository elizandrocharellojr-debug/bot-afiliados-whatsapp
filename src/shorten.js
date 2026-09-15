// ulvis.net: encurtador gratuito, sem precisar de conta nem chave de API.
// (Trocamos do TinyURL porque a API antiga deles foi descontinuada e passou
// a mostrar uma pagina de aviso em vez de redirecionar direto - confirmado
// testando de verdade num navegador.)
export async function shortenUrl(longUrl) {
  try {
    const res = await fetch(
      'https://ulvis.net/api.php?url=' + encodeURIComponent(longUrl) + '&type=text'
    );
    if (!res.ok) return longUrl;
    const text = (await res.text()).trim();
    return text.startsWith('https://ulvis.net/') ? text : longUrl;
  } catch {
    // Se o encurtador falhar (sem internet, servico fora do ar...), usa o link
    // completo mesmo - o importante e nunca travar por causa disso.
    return longUrl;
  }
}
