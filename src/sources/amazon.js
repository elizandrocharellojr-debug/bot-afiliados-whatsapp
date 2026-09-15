import { config } from '../config.js';
import { logger, describeError } from '../logger.js';

// A antiga PA-API (assinatura AWS SigV4) foi desativada pela Amazon em
// 15/05/2026. A substituta e a Creators API, que usa OAuth2 (client
// credentials) em vez de chaves AWS. Exige um minimo de vendas recentes
// (janela movel de 30 dias) para funcionar - se a conta nao tiver isso,
// a Amazon responde com erro de autorizacao e esta fonte e pulada sozinha.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const { clientId, clientSecret, tokenUrl } = config.amazon;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'creatorsapi::search',
    }),
  });

  if (!response.ok) {
    throw new Error(`token endpoint respondeu ${response.status}`);
  }

  const json = await response.json();
  cachedToken = json.access_token;
  cachedTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}

const SEARCH_KEYWORDS = ['ofertas', 'promocao'];

export async function fetchAmazonDeals() {
  if (!config.amazon.enabled) return [];

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    logger.warn(
      `Amazon: nao consegui autenticar na Creators API (${describeError(err)}). ` +
        'Provavel causa: conta ainda sem o minimo de vendas recentes exigido pelo programa, ou ' +
        'credenciais erradas no .env. Pulando Amazon neste ciclo.'
    );
    return [];
  }

  const deals = [];

  for (const keywords of SEARCH_KEYWORDS) {
    let response;
    try {
      response = await fetch(`${config.amazon.apiBase}/catalog/v1/searchItems`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          partnerTag: config.amazon.associateTag,
          partnerType: 'Associates',
          marketplace: config.amazon.marketplace,
          keywords,
          itemCount: 10,
          resources: ['ItemInfo.Title', 'Images.Primary.Large', 'OffersV2.Listings.Price'],
        }),
      });
    } catch (err) {
      logger.error(`Amazon: falha de rede ao buscar produtos - ${describeError(err)}`);
      continue;
    }

    if (!response.ok) {
      logger.warn(`Amazon: resposta ${response.status} ao buscar "${keywords}" (pulando).`);
      continue;
    }

    const json = await response.json();
    const items = json?.searchResult?.items || json?.items || [];

    for (const item of items) {
      const listing = item?.offersV2?.listings?.[0];
      const price = listing?.price?.amount;
      const savingBasis = listing?.price?.savingBasis?.amount;
      if (!price || !savingBasis || savingBasis <= price) continue;

      const discountPct = Math.round(((savingBasis - price) / savingBasis) * 100);
      if (discountPct < config.behavior.minDiscountPercent) continue;

      // A API ja deveria devolver o link com nossa "partnerTag" embutida, mas
      // garantimos aqui mesmo assim, sobrescrevendo o parametro se ja existir.
      const link = new URL(item.detailPageUrl);
      link.searchParams.set('tag', config.amazon.associateTag);

      deals.push({
        source: 'amazon',
        productId: item.asin,
        title: item?.itemInfo?.title?.displayValue || item.asin,
        price,
        discountPct,
        imageUrl: item?.images?.primary?.large?.url,
        affiliateLink: link.toString(),
      });
    }
  }

  return deals;
}
