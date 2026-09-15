import { logger } from './logger.js';

// O Mercado Livre nao tem API oficial de afiliados. O link gerado no portal
// (afiliados.mercadolivre.com.br) e a URL normal do produto com um parametro
// extra ligado a sua conta. Lemos esse parametro UMA vez a partir do link de
// exemplo que voce colou no .env, e reaplicamos em qualquer produto depois.
// Isso nao e documentado oficialmente pelo Mercado Livre - se pararem de
// funcionar, gere um novo link de exemplo no portal e atualize o .env.
const KNOWN_PARAM_SETS = [['tag'], ['matt_word', 'matt_tool']];

export function extractAffiliateParams(sampleLink) {
  let url;
  try {
    url = new URL(sampleLink);
  } catch {
    logger.error('Mercado Livre: ML_SAMPLE_AFFILIATE_LINK nao e uma URL valida.');
    return null;
  }

  if (url.pathname.includes('/sec/')) {
    logger.error(
      'Mercado Livre: o link de exemplo e um link curto (/sec/...), gerado por produto pelo ' +
        'proprio Mercado Livre. Nao da pra reaplicar esse formato em outros produtos automaticamente. ' +
        'Mercado Livre desativado ate revisarmos esse caso.'
    );
    return null;
  }

  for (const paramSet of KNOWN_PARAM_SETS) {
    if (paramSet.every((p) => url.searchParams.has(p))) {
      const params = {};
      for (const p of paramSet) params[p] = url.searchParams.get(p);
      return params;
    }
  }

  logger.error(
    'Mercado Livre: nao reconheci o formato do link de exemplo (esperava "tag" ou ' +
      '"matt_word"+"matt_tool" na URL). Mercado Livre desativado ate revisarmos esse caso.'
  );
  return null;
}

// Quando voce usa o botao "Compartilhar" de dentro do app/site do Mercado
// Livre pra um produto especifico, ele gera um link (dominio meli.la, ou com
// um parametro "ref") que ja vem com rastreamento de comissao E a vitrine
// bonita da marca (a que mostra "OfertaNinja" + foto + botao "Ir para
// produto"). Esse link e assinado pelo proprio Mercado Livre - nao da pra
// recriar isso do zero, entao se voce ja tiver um link desses, o certo e
// usar ele direto, sem mexer.
const NATIVE_SHARE_DOMAINS = ['meli.la'];

export function isNativeShareLink(productUrl) {
  try {
    const url = new URL(productUrl);
    if (NATIVE_SHARE_DOMAINS.includes(url.hostname)) return true;
    if (url.searchParams.has('ref') && url.searchParams.has('matt_word')) return true;
    return false;
  } catch {
    return false;
  }
}

export function buildAffiliateLink(productUrl, affiliateParams) {
  if (isNativeShareLink(productUrl)) return productUrl;

  const url = new URL(productUrl);
  for (const [key, value] of Object.entries(affiliateParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// Diferente de buildAffiliateLink acima: essa e pra link achado em OUTRO
// grupo (nao gerado por voce). "meli.la" so vem "ja com seu afiliado" quando
// e VOCE que compartilha - um link meli.la que outra pessoa mandou tem o
// afiliado DELA, nao o seu.
//
// Tentativa anterior: pegar a pagina "/social/<usuario>?ref=..." que o
// meli.la abre e trocar so matt_word/matt_tool (ou tambem o nome de usuario
// no caminho). Não funcionou de forma confiavel - essa pagina e' o perfil
// "Creator" de QUEM compartilhou, o "ref" e' um token assinado ligado a essa
// pessoa+produto especificos, e testando de verdade (em outro aparelho, nao
// logado como o dono) continuava caindo numa tela generica de recomendacoes
// em vez do produto especifico.
//
// Solucao mais confiavel: em vez de tentar reaproveitar essa pagina "social"
// de outra pessoa, a gente pega o link DIRETO do produto (o mesmo que o
// botao "Ir para produto" usa, tipo produto.mercadolivre.com.br/MLB-123...)
// e aplica seu matt_word/matt_tool nele do jeito NORMAL - o mesmo metodo que
// ja funciona pros links vindos da busca da API (buildAffiliateLink acima).
// Isso evita depender de qualquer token exclusivo de outra pessoa.
const USER_AGENT_NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function buscarHtml(url) {
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT_NAVEGADOR,
      Accept: 'text/html,application/xhtml+xml,application/xml',
    },
  });
  const html = await resp.text();
  return { urlFinal: resp.url, html };
}

// Acha o primeiro link de produto (.../MLB-123...) no HTML da pagina - e'
// assim que a pagina "/social/..." lista o produto em destaque (o mesmo que
// o "ref" seleciona), sem precisar entender o token. O subdominio pode
// variar ("produto.mercadolivre.com.br", "www.mercadolivre.com.br", ou sem
// subdominio nenhum) - aceita qualquer um, desde que seja mercadolivre.com.br
// (ou .com pra outros paises) e tenha o padrao "/MLB-123...".
function extrairPermalinkProduto(html) {
  const htmlLimpo = html
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/');
  // Aceita os dois formatos de produto: o classico "/MLB-123..." (com hifen)
  // e o de catalogo "/p/MLB123..." (sem hifen, produtos de marca com varios
  // vendedores - ex: tenis).
  const match = htmlLimpo.match(
    /https?:\/\/[a-z0-9.-]*mercadoli(?:vre|bre)\.com(?:\.br)?\/(?:p\/)?MLB-?\d+[^"'\s]*/i
  );
  return match ? match[0].split(/[?#]/)[0] : null;
}

// Devolve a URL direta do produto (produto.mercadolivre.com.br/MLB-123...),
// resolvendo meli.la/"/social/..." se precisar. Usada tanto pelo metodo
// alternativo abaixo (aplica matt_word/matt_tool direto) quanto pelo
// gerador via navegador (mercadolivreBrowser.js), que precisa abrir a
// pagina do produto de verdade pra clicar no botao "Compartilhar".
export async function resolverPermalinkProduto(productUrl) {
  const parsedInicial = new URL(productUrl);
  // Produtos "de catalogo" (marca conhecida, varios vendedores no mesmo
  // anuncio - ex: tenis Nike) usam formato "/p/MLB123..." (SEM hifen depois
  // de MLB), diferente do permalink classico "/MLB-123..." (COM hifen).
  // Aceita os dois.
  const jaEhPermalink =
    /MLB-?\d+/i.test(parsedInicial.pathname) || parsedInicial.hostname === 'produto.mercadolivre.com.br';

  if (jaEhPermalink) {
    return productUrl;
  }

  // meli.la (link curto) ou uma pagina "/social/..." direto - busca o HTML
  // e procura o link de produto de verdade dentro dela.
  let html;
  let urlFinal;
  try {
    ({ html, urlFinal } = await buscarHtml(productUrl));
  } catch (err) {
    throw new Error(`nao consegui abrir o link pra resolver o produto (${err.message})`);
  }

  // PERIGO: muitos meli.la de revendedores abrem a pagina "Perfil Social"
  // (mercadolivre.com.br/social/<usuario>) - a VITRINE da pessoa, nao o
  // produto especifico. O produto que a gente leria dessa pagina e' outro
  // (o que a pessoa deixou em destaque), NAO o da promocao. Ja aconteceu de
  // converter um whey e sair outro whey de valor bem diferente. Preferimos
  // recusar a arriscar postar o produto ERRADO com a sua tag.
  if (/\/social\//i.test(urlFinal || '')) {
    throw new Error(
      'esse link abre a vitrine/perfil de outro afiliado, nao o produto especifico - ' +
        'nao da pra identificar com certeza qual produto e, entao nao converti (confira na mao)'
    );
  }

  const permalink = extrairPermalinkProduto(html);
  if (!permalink) {
    throw new Error(
      'nao encontrei o link direto do produto dentro da pagina (formato pode ter mudado)'
    );
  }
  return permalink;
}

// Metodo alternativo (fallback) - usado so se o navegador (metodo oficial,
// veja mercadolivreBrowser.js) nao estiver disponivel ou falhar.
export async function buildAffiliateLinkFromScrapedUrl(productUrl, affiliateParams) {
  const permalink = await resolverPermalinkProduto(productUrl);
  return buildAffiliateLink(permalink, affiliateParams);
}
