import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger, describeError } from '../logger.js';

export const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

// Documentacao: https://www.affiliateshopee.com.br/documentacao
// Assinatura: SHA256(AppId + Timestamp + Payload + Secret), em hexadecimal.
// Exportada pra ser reaproveitada em shopeeLink.js (gera link de afiliado
// pra uma URL especifica, em vez de buscar por palavra-chave).
export function buildAuthHeader(payload) {
  const { appId, appSecret } = config.shopee;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash('sha256')
    .update(appId + timestamp + payload + appSecret)
    .digest('hex');

  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

// productOfferV2 sem "keyword" devolve uma lista vazia - confirmado testando
// com credenciais reais. Precisa buscar por palavra-chave.
//
// Lista grande e variada de propósito: com poucas palavras-chave repetidas,
// a busca sempre volta com os mesmos produtos, e depois de um tempo o filtro
// de "ja postado" (dedupe) rejeita tudo - parece que o bot "parou" quando na
// verdade so ficou sem produto novo pra mostrar. Girando por varias
// categorias reduz bastante esse efeito.
const SEARCH_KEYWORDS = [
  'ofertas',
  'promocao',
  'cozinha',
  'panela',
  'utensilios de cozinha',
  'eletrodomestico',
  'roupas',
  'moda feminina',
  'moda masculina',
  'calcados',
  'tenis',
  'sapato',
  'eletronicos',
  'celular',
  'fone de ouvido',
  'acessorios celular',
  'beleza',
  'maquiagem',
  'perfume',
  'cuidados com a pele',
  'casa',
  'decoracao',
  'organizador',
  'brinquedos',
  'pet shop',
];

// Gira pela lista em sequencia (em vez de sortear) pra cobrir todas as
// categorias com o tempo, sem ficar repetindo a mesma busca toda hora.
let keywordCursor = 0;

function nextKeywords(count) {
  const picked = [];
  for (let i = 0; i < count; i++) {
    picked.push(SEARCH_KEYWORDS[keywordCursor % SEARCH_KEYWORDS.length]);
    keywordCursor++;
  }
  return picked;
}

function buildQuery(keyword) {
  return `{
    productOfferV2(keyword: "${keyword}", sortType: 2, page: 1, limit: 20) {
      nodes {
        itemId
        productName
        offerLink
        imageUrl
        priceMin
        priceDiscountRate
      }
    }
  }`;
}

async function runQuery(query, attempt = 1) {
  const body = JSON.stringify({ query, operationName: null, variables: {} });

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildAuthHeader(body),
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`resposta ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) {
    // A API as vezes devolve um erro transitorio ("System Error") - vale
    // tentar de novo uma vez antes de desistir.
    if (attempt === 1) {
      await new Promise((r) => setTimeout(r, 1000));
      return runQuery(query, attempt + 1);
    }
    throw new Error(JSON.stringify(json.errors));
  }

  return json?.data?.productOfferV2?.nodes || [];
}

const KEYWORDS_PER_CYCLE = 5;

export async function fetchShopeeDeals() {
  if (!config.shopee.enabled) return [];

  const keywords = nextKeywords(KEYWORDS_PER_CYCLE);
  const seenIds = new Set();
  const allNodes = [];

  for (const keyword of keywords) {
    let nodes;
    try {
      nodes = await runQuery(buildQuery(keyword));
    } catch (err) {
      logger.error(`Shopee: erro ao buscar ofertas ("${keyword}") - ${describeError(err)}`);
      continue;
    }
    for (const n of nodes) {
      if (n.itemId && !seenIds.has(n.itemId)) {
        seenIds.add(n.itemId);
        allNodes.push(n);
      }
    }
  }

  return allNodes
    .filter((n) => n.itemId && n.offerLink && Number(n.priceDiscountRate) >= config.behavior.minDiscountPercent)
    .map((n) => ({
      source: 'shopee',
      productId: String(n.itemId),
      title: n.productName,
      price: Number(n.priceMin),
      discountPct: Number(n.priceDiscountRate),
      imageUrl: n.imageUrl,
      affiliateLink: n.offerLink,
    }));
}
