import { config } from '../config.js';
import { logger, describeError } from '../logger.js';
import { getAccessToken } from '../mercadolivreAuth.js';
import { extractAffiliateParams, buildAffiliateLink } from '../mercadolivreLink.js';

const SEARCH_ENDPOINT = 'https://api.mercadolibre.com/sites/MLB/search';

// ATENCAO: o Mercado Livre bloqueou esse endpoint de busca pra
// desenvolvedores (confirmado em 2026-07: erro 403 "PA_UNAUTHORIZED_RESULT_FROM_POLICIES"
// mesmo com token valido - varios outros devs relataram o mesmo). Deixamos o
// codigo aqui pronto pro caso do Mercado Livre reverter isso, mas na pratica
// esta fonte esta desativada. Use "npm run link-mercadolivre" (manual) enquanto isso.
export async function fetchMercadoLivreDeals() {
  if (!config.mercadolivre.enabled) return [];

  const affiliateParams = extractAffiliateParams(config.mercadolivre.sampleAffiliateLink);
  if (!affiliateParams) return [];

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    logger.warn(
      `Mercado Livre: nao consegui renovar o token de acesso (${describeError(err)}). ` +
        'Talvez o refresh token tenha expirado - rode "npm run setup-mercadolivre" de novo. ' +
        'Pulando Mercado Livre neste ciclo.'
    );
    return [];
  }

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('q', 'ofertas');
  url.searchParams.set('sort', 'relevance');

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    logger.error(`Mercado Livre: falha de rede ao buscar produtos - ${describeError(err)}`);
    return [];
  }

  if (!response.ok) {
    logger.warn(`Mercado Livre: resposta ${response.status} ao buscar produtos (pulando este ciclo).`);
    return [];
  }

  const json = await response.json();
  const results = json?.results || [];

  return results
    .filter((item) => item.original_price && item.original_price > item.price)
    .map((item) => {
      const discountPct = Math.round(
        ((item.original_price - item.price) / item.original_price) * 100
      );
      return { item, discountPct };
    })
    .filter(({ discountPct }) => discountPct >= config.behavior.minDiscountPercent)
    .map(({ item, discountPct }) => ({
      source: 'mercadolivre',
      productId: String(item.id),
      title: item.title,
      price: item.price,
      discountPct,
      imageUrl: item.thumbnail,
      affiliateLink: buildAffiliateLink(item.permalink, affiliateParams),
    }));
}
