// Acha o codigo do produto (ASIN - 10 caracteres) dentro do caminho da URL,
// nos formatos mais comuns: "/dp/ASIN", "/gp/product/ASIN" ou "/product/ASIN".
// Aceita qualquer coisa depois do ASIN (barra, parametro, ou nada) - e' esse
// "qualquer coisa depois" que costuma vir cheio de lixo tipo
// "/ref=cm_sw_r_as_gl_api_..." quando o link foi compartilhado pelo app.
const ASIN_REGEX = /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i;

export function buildAffiliateLink(productUrl, tag) {
  const url = new URL(productUrl);
  const match = url.pathname.match(ASIN_REGEX);

  if (match) {
    // Link limpo e curto: so o essencial pra comissao funcionar (ASIN + sua
    // tag) - descarta o resto (ref=..., linkCode=..., psc=1, th=1...), que e'
    // so rastreamento de QUEM compartilhou o link originalmente e nao tem
    // nada a ver com a SUA comissao. Isso e' o mesmo formato curto que a
    // propria Amazon usa nos links de afiliado ("amazon.com.br/dp/ASIN?tag=...").
    return `${url.origin}/dp/${match[1].toUpperCase()}?tag=${encodeURIComponent(tag)}`;
  }

  // Formato que a gente nao reconheceu (raro) - so troca/adiciona a tag, sem
  // mexer no resto, pra nao arriscar quebrar um link que a gente nao entende
  // direito.
  url.searchParams.set('tag', tag);
  return url.toString();
}
