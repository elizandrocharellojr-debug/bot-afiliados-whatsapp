import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Tunnel } from 'cloudflared';
import { config } from './config.js';
import { logger, describeError } from './logger.js';
import { waitForConnection } from './whatsapp/connection.js';
import { sendDealToGroups } from './whatsapp/sender.js';
import { extractAffiliateParams, buildAffiliateLink as buildMlLink } from './mercadolivreLink.js';
import { buildAffiliateLink as buildAmazonLink } from './amazonLink.js';
import { tratarRotaDoPainel } from './painel.js';

function buildAffiliateLink(source, productUrl) {
  if (source === 'mercadolivre') {
    const params = extractAffiliateParams(config.mercadolivre.sampleAffiliateLink);
    if (!params) throw new Error('ML_SAMPLE_AFFILIATE_LINK nao configurado ou invalido no .env');
    return buildMlLink(productUrl, params);
  }
  if (source === 'amazon') {
    if (!config.amazon.associateTag) throw new Error('AMAZON_ASSOCIATE_TAG nao configurado no .env');
    return buildAmazonLink(productUrl, config.amazon.associateTag);
  }
  throw new Error(`fonte desconhecida: ${source}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('JSON invalido'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

async function handlePost(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }

  const { source, productUrl, title, price, originalPrice, imageUrl, coupon } = payload;

  if (!source || !productUrl || !title || !price) {
    sendJson(res, 400, { ok: false, error: 'Campos obrigatorios: source, productUrl, title, price' });
    return;
  }

  let affiliateLink;
  try {
    affiliateLink = buildAffiliateLink(source, productUrl);
  } catch (err) {
    logger.error(`Extensao: falha ao montar link - ${err.message}`);
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }

  // Sem encurtador generico (ulvis.net) - o link vai com o dominio real
  // (amazon.com.br / mercadolivre.com.br / shopee) visivel, que passa mais
  // confianca pra quem clica.

  const priceLine = originalPrice
    ? `De: R$ ${originalPrice} | Por: R$ ${price} 🥷`
    : `R$ ${price} 🥷`;
  const couponLine = coupon ? `⚠️ cupom: ${coupon}\n` : '';
  const message =
    `${title}\n\n` +
    `${priceLine}\n` +
    `${couponLine}\n` +
    `Link: ${affiliateLink}`;

  if (config.whatsapp.groupJids.length === 0) {
    sendJson(res, 400, { ok: false, error: 'Nenhum grupo do WhatsApp configurado no .env' });
    return;
  }

  try {
    await waitForConnection();
    const ok = await sendDealToGroups(config.whatsapp.groupJids, { text: message, imageUrl: imageUrl || undefined });
    if (ok) {
      logger.info(`Extensao: postado "${title}" (${source})`);
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 500, { ok: false, error: 'Falha ao enviar pro WhatsApp' });
    }
  } catch (err) {
    logger.error(`Extensao: erro ao enviar - ${describeError(err)}`);
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

// Descobre o IP do PC na rede local (o que o celular precisa usar).
function ipsDaRede() {
  const ips = [];
  for (const lista of Object.values(networkInterfaces())) {
    for (const iface of lista || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

let tunelAtivo = null;

// Chamada ao encerrar o bot (Ctrl+C) - evita deixar um cloudflared.exe
// zumbi rodando sozinho depois que a janela fecha.
export function pararTunel() {
  try {
    tunelAtivo?.stop();
  } catch {
    // se ja tiver morrido sozinho, tanto faz
  }
}

// Sobe o mesmo tunel que antes precisava de "npm run tunel" numa segunda
// janela - agora dentro do proprio processo do bot, uma janela so. Nao trava
// nada se falhar (sem internet pro Cloudflare, por exemplo): so avisa no log
// e o painel continua funcionando normal no PC/Wi-Fi de casa.
function iniciarTunelAutomatico(port, tokenQuery) {
  logger.info('Painel: abrindo tunel do Cloudflare (acesso fora de casa)...');
  try {
    tunelAtivo = Tunnel.quick(`http://127.0.0.1:${port}`);
  } catch (err) {
    logger.warn(`Painel: nao consegui iniciar o tunel automatico (${describeError(err)}) - use o painel so no Wi-Fi de casa, ou rode "npm run tunel" manualmente.`);
    return;
  }

  tunelAtivo.once('url', (url) => {
    logger.info(`PAINEL FORA DE CASA (dados moveis): ${url}/painel${tokenQuery}`);
  });
  tunelAtivo.on('error', (err) => {
    logger.warn(`Painel: erro no tunel automatico (${describeError(err)}) - o painel local/rede continua funcionando normal.`);
  });
  tunelAtivo.on('exit', (code) => {
    if (code && code !== 0) {
      logger.warn(`Painel: o tunel automatico caiu (codigo ${code}) - o painel local/rede continua funcionando normal. Reinicie o bot pra tentar de novo.`);
    }
    tunelAtivo = null;
  });
}

export function startLocalServer() {
  const port = config.painel.porta;

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/post') {
      handlePost(req, res);
      return;
    }

    // Painel local das promocoes prontas (/painel e rotas filhas).
    if (tratarRotaDoPainel(req, res, sendJson, readJsonBody)) return;

    sendJson(res, 404, { ok: false, error: 'nao encontrado' });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Servidor da extensao: porta ${port} ja esta em uso (outro "npm start" rodando?). ` +
          'A extensao do navegador nao vai funcionar ate isso ser resolvido, mas o resto do bot continua normal.'
      );
    } else {
      logger.error(`Servidor da extensao: erro inesperado - ${err.message}`);
    }
  });

  // Por padrao so aceita conexoes do proprio PC. Com PAINEL_NA_REDE=sim,
  // aceita tambem os aparelhos da mesma rede (pra abrir o painel no celular).
  const endereco = config.painel.naRede ? '0.0.0.0' : '127.0.0.1';

  server.listen(port, endereco, () => {
    logger.info(`Servidor da extensao ativo em http://127.0.0.1:${port}`);
    const t = config.painel.token ? `?t=${config.painel.token}` : '';
    logger.info(`PAINEL DAS PROMOCOES (neste PC): http://127.0.0.1:${port}/painel${t}`);

    if (config.painel.naRede) {
      if (!config.painel.token) {
        logger.error(
          'PAINEL_NA_REDE=sim mas PAINEL_TOKEN esta vazio no .env - o painel na rede fica BLOQUEADO ' +
            'por seguranca (qualquer aparelho do Wi-Fi poderia postar no seu grupo). Preencha PAINEL_TOKEN.'
        );
      }
      for (const ip of ipsDaRede()) {
        logger.info(`PAINEL NO CELULAR (mesmo Wi-Fi): http://${ip}:${port}/painel${t}`);
      }

      if (config.painel.tunelAutomatico) {
        if (!config.painel.token) {
          logger.warn(
            'PAINEL_TUNEL_AUTOMATICO=sim mas PAINEL_TOKEN esta vazio - nao vou abrir o tunel publico ' +
              'sem senha configurada (ficaria aberto pra qualquer um). Preencha PAINEL_TOKEN no .env.'
          );
        } else {
          iniciarTunelAutomatico(port, t);
        }
      }
    }
  });

  return server;
}
