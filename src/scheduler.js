import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { wasRecentlyPosted, markAsPosted } from './dedupe.js';
import { formatDealMessage } from './formatter.js';
import { sendDealToGroups } from './whatsapp/sender.js';
import { fetchShopeeDeals } from './sources/shopee.js';
import { fetchMercadoLivreDeals } from './sources/mercadolivre.js';
import { fetchAmazonDeals } from './sources/amazon.js';

const SOURCES = [
  { name: 'shopee', fetch: fetchShopeeDeals },
  { name: 'mercadolivre', fetch: fetchMercadoLivreDeals },
  { name: 'amazon', fetch: fetchAmazonDeals },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processSource(source) {
  let deals;
  try {
    deals = await source.fetch();
  } catch (err) {
    logger.error(`${source.name}: erro inesperado ao buscar ofertas - ${err.message}`);
    return;
  }

  const fresh = deals.filter((d) => !wasRecentlyPosted(d.source, d.productId));
  const toPost = fresh.slice(0, config.behavior.postsPerCyclePerSource);

  if (toPost.length === 0) {
    logger.info(`${source.name}: nenhuma oferta nova neste ciclo.`);
    return;
  }

  for (const deal of toPost) {
    const text = formatDealMessage(deal);

    if (config.dryRun) {
      logger.info(`[TESTE] Postaria em ${deal.source}:\n${text}\n`);
    } else {
      const ok = await sendDealToGroups(config.whatsapp.groupJids, {
        text,
        imageUrl: deal.imageUrl,
      });
      if (ok) {
        logger.info(`${source.name}: postado "${deal.title}"`);
      }
    }

    markAsPosted(deal.source, deal.productId);
    await sleep(config.behavior.delayBetweenPostsSeconds * 1000);
  }
}

export async function runPollCycle() {
  logger.info('Iniciando ciclo de busca de ofertas...');
  for (const source of SOURCES) {
    await processSource(source);
  }
  logger.info('Ciclo concluido.');
}

let cycleRunning = false;

export function startScheduler() {
  const minutes = config.behavior.pollIntervalMinutes;
  const expression = `*/${minutes} * * * *`;

  logger.info(`Agendador ativo: buscando ofertas a cada ${minutes} minuto(s).`);
  cron.schedule(expression, () => {
    // Evita dois ciclos rodando ao mesmo tempo (pode acontecer com intervalo
    // curto, tipo 1 minuto, se um ciclo demorar mais que isso pra terminar) -
    // sem essa trava, o ritmo real de postagem ficaria descontrolado.
    if (cycleRunning) {
      logger.warn('Ciclo anterior ainda rodando, pulando este disparo.');
      return;
    }
    cycleRunning = true;
    runPollCycle()
      .catch((err) => logger.error(`Erro no ciclo agendado: ${err.message}`))
      .finally(() => {
        cycleRunning = false;
      });
  });
}
