import { config } from '../config.js';
import { logger } from '../logger.js';
import { ENDPOINT, buildAuthHeader } from './shopee.js';

// Diferente de fetchShopeeDeals (que busca produtos por palavra-chave), essa
// funcao recebe uma URL de produto especifica (achada num link copiado de
// outro grupo) e devolve o mesmo link com SEU afiliado, via a mutation
// generateShortLink da API Aberta de Afiliados da Shopee.
// Docs: https://www.affiliateshopee.com.br/documentacao
export async function generateShopeeAffiliateLink(productUrl) {
  if (!config.shopee.enabled) {
    return { link: null, erro: 'SHOPEE_APP_ID/SHOPEE_APP_SECRET nao configurado no .env' };
  }

  const query = `mutation{generateShortLink(input:{originUrl:"${productUrl.replace(/"/g, '\\"')}",subIds:["whatsapp"]}){shortLink}}`;
  const payload = JSON.stringify({ query, operationName: null, variables: {} });

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: buildAuthHeader(payload),
      },
      body: payload,
    });
  } catch (err) {
    return { link: null, erro: `erro de rede chamando a API da Shopee (${err.message})` };
  }

  if (!response.ok) {
    return { link: null, erro: `API da Shopee respondeu ${response.status}` };
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    return { link: null, erro: `resposta invalida da API da Shopee (${err.message})` };
  }

  if (json.errors) {
    logger.warn(`Shopee: API recusou o link (${JSON.stringify(json.errors)})`);
    return { link: null, erro: 'API da Shopee recusou gerar o link (produto invalido ou fora do programa?)' };
  }

  const shortLink = json?.data?.generateShortLink?.shortLink;
  if (!shortLink) {
    return { link: null, erro: 'API da Shopee nao devolveu link (resposta vazia)' };
  }

  return { link: shortLink, erro: null };
}
