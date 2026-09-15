import { existsSync } from 'node:fs';
import { logger } from './logger.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const env = process.env;

export const config = {
  dryRun: process.argv.includes('--dry-run'),

  shopee: {
    appId: env.SHOPEE_APP_ID || '',
    appSecret: env.SHOPEE_APP_SECRET || '',
    get enabled() {
      return Boolean(this.appId && this.appSecret);
    },
  },

  mercadolivre: {
    sampleAffiliateLink: env.ML_SAMPLE_AFFILIATE_LINK || '',
    clientId: env.ML_CLIENT_ID || '',
    clientSecret: env.ML_CLIENT_SECRET || '',
    redirectUri: env.ML_REDIRECT_URI || '',
    refreshToken: env.ML_REFRESH_TOKEN || '',
    // Usa um navegador logado na sua conta pra gerar o link OFICIAL
    // "meli.la" (via mercadolivreBrowser.js) pros links achados nos grupos
    // de origem - certeza de comissao, mas abre uma janela de Chrome e pode
    // ser mais lento/instavel. Ponha "nao" pra usar so o metodo alternativo
    // (link do produto + matt_word/matt_tool direto, sem navegador).
    usarNavegador: !['nao', 'não', 'false', '0'].includes(
      String(env.ML_USAR_NAVEGADOR || 'sim').trim().toLowerCase()
    ),
    get enabled() {
      return Boolean(
        this.sampleAffiliateLink && this.clientId && this.clientSecret && this.refreshToken
      );
    },
  },

  amazon: {
    clientId: env.AMAZON_CREATORS_CLIENT_ID || '',
    clientSecret: env.AMAZON_CREATORS_CLIENT_SECRET || '',
    associateTag: env.AMAZON_ASSOCIATE_TAG || '',
    marketplace: env.AMAZON_MARKETPLACE || 'www.amazon.com.br',
    tokenUrl: env.AMAZON_CREATORS_TOKEN_URL || 'https://api.amazon.com/auth/o2/token',
    apiBase: env.AMAZON_CREATORS_API_BASE || 'https://api.amazon.com',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret && this.associateTag);
    },
  },

  whatsapp: {
    // WHATSAPP_GROUP_JIDS (varios, separados por virgula) e o novo padrao.
    // Ainda le WHATSAPP_GROUP_JID (singular, antigo) se so ele estiver preenchido.
    groupJids: (env.WHATSAPP_GROUP_JIDS || env.WHATSAPP_GROUP_JID || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Telegram - canal de destino das promocoes. Ao contrario do WhatsApp,
  // aqui a automacao e' oficialmente suportada (Bot API), entao nao tem
  // risco de suspensao por postar automaticamente.
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    // Aceita "@canal", "canal" ou o link "t.me/canal" - normaliza pro
    // formato "@canal" que a Bot API espera.
    chatId: (() => {
      const bruto = (env.TELEGRAM_CANAL || '').trim();
      if (!bruto) return '';
      if (/^-?\d+$/.test(bruto)) return bruto; // id numerico (canal privado)
      const nome = bruto.replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '');
      return `@${nome}`;
    })(),
    get enabled() {
      return Boolean(this.botToken && this.chatId);
    },
  },

  // Painel das promocoes (http://IP:PORTA/painel) - a pagina de onde voce
  // manda as promocoes pro grupo na mao.
  painel: {
    // Servidores na nuvem (Railway e outros) definem a porta sozinhos via
    // variavel PORT e esperam que o app escute nela - por isso ela vem
    // ANTES de EXTENSION_SERVER_PORT (que continua valendo no seu PC).
    porta: int(env.PORT || env.EXTENSION_SERVER_PORT, 4545),
    // "sim" = aceita acesso de outros aparelhos da MESMA rede (pra abrir no
    // celular). "nao" = so no proprio PC (127.0.0.1).
    naRede: ['sim', 'true', '1'].includes(
      String(env.PAINEL_NA_REDE || 'nao').trim().toLowerCase()
    ),
    // Senha simples de acesso. Obrigatoria quando o painel esta na rede -
    // sem isso, qualquer aparelho no mesmo Wi-Fi poderia postar no seu grupo.
    token: (env.PAINEL_TOKEN || '').trim(),
    // "sim" (padrao) = o proprio "npm start" ja sobe um tunel do Cloudflare
    // (igual o "npm run tunel" separado, so que dentro do mesmo processo/
    // janela) e mostra o endereco publico (https://...trycloudflare.com) no
    // terminal - da pra usar o painel fora de casa (dados moveis) sem
    // precisar abrir uma segunda janela. "nao" = so o endereco local/rede
    // (Wi-Fi de casa), do jeito antigo.
    tunelAutomatico: ['sim', 'true', '1'].includes(
      String(env.PAINEL_TUNEL_AUTOMATICO ?? 'sim').trim().toLowerCase()
    ),
  },

  behavior: {
    minDiscountPercent: int(env.MIN_DISCOUNT_PERCENT, 20),
    dedupeWindowDays: int(env.DEDUPE_WINDOW_DAYS, 30),
    pollIntervalMinutes: int(env.POLL_INTERVAL_MINUTES, 15),
    postsPerCyclePerSource: int(env.POSTS_PER_CYCLE_PER_SOURCE, 3),
    delayBetweenPostsSeconds: int(env.DELAY_BETWEEN_POSTS_SECONDS, 10),
    // Busca automatica de ofertas (Shopee/ML/Amazon por palavra-chave, sem
    // relacao com os grupos de origem). Desativada por padrao - o pedido era
    // so copiar promocao de outros grupos, nao inventar oferta nova sozinho.
    // Ponha "sim" no .env (BUSCAR_OFERTAS_AUTOMATICO=sim) pra religar.
    buscaAutomaticaAtiva: ['sim', 'true', '1'].includes(
      String(env.BUSCAR_OFERTAS_AUTOMATICO || 'nao').trim().toLowerCase()
    ),
  },

  // Leitor de grupos de origem (substitui o antigo script Python/Selenium -
  // aqui e tudo por evento em tempo real, sem abrir/fechar chat nenhum).
  // Reaproveita as mesmas variaveis PY_* que ja estavam preenchidas pro
  // script antigo, pra nao precisar configurar tudo de novo.
  groupReader: {
    sourceGroupNames: (env.GRUPOS_ORIGEM || env.PY_GRUPOS_ORIGEM || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    meuNumero: env.MEU_NUMERO || env.PY_MEU_NUMERO || '',
    aprovacaoManual: !['nao', 'não', 'false', '0'].includes(
      String(env.APROVACAO_MANUAL || env.PY_APROVACAO_MANUAL || 'sim').trim().toLowerCase()
    ),
    delayEntrePostsSegundos: int(
      env.DELAY_ENTRE_POSTS_SEGUNDOS_ORIGEM || env.PY_DELAY_ENTRE_POSTS_SEGUNDOS,
      10
    ),
    // Pra onde vao as promocoes achadas: "telegram" (padrao - oficial, sem
    // risco de ban), "whatsapp" (grupo do WHATSAPP_GROUP_JIDS) ou "ambos".
    destino: String(env.DESTINO_POSTAGEM || 'telegram').trim().toLowerCase(),
    // Segundos entre posts consecutivos NO WHATSAPP (o Telegram sai sempre na
    // hora, sem espera). Serve pra nao postar rapido demais e o numero cair
    // por suspeita de automacao. Ex: 120 = 1 post a cada 2 min. Aceita um
    // intervalo "min-max" (ex: "90-150") pra ficar aleatorio e mais natural.
    segundosEntrePostsWhatsapp: env.SEGUNDOS_ENTRE_POSTS_WHATSAPP || '30-90',
    get postaNoTelegram() {
      return this.destino === 'telegram' || this.destino === 'ambos';
    },
    get postaNoWhatsapp() {
      return this.destino === 'whatsapp' || this.destino === 'ambos';
    },
    get enabled() {
      return this.sourceGroupNames.length > 0;
    },
  },
};

export function validateConfig() {
  const problems = [];

  // So exige grupo do WhatsApp se ele for mesmo um destino de postagem -
  // quem posta so no Telegram nao precisa de grupo de destino no WhatsApp.
  if (!config.dryRun && config.groupReader.postaNoWhatsapp && config.whatsapp.groupJids.length === 0) {
    problems.push(
      'Nenhum grupo do WhatsApp configurado. Rode "npm run setup-whatsapp" primeiro para conectar o WhatsApp e escolher o(s) grupo(s).'
    );
  }

  if (config.groupReader.postaNoTelegram && !config.telegram.enabled) {
    const faltando = [];
    if (!config.telegram.botToken) faltando.push('TELEGRAM_BOT_TOKEN');
    if (!config.telegram.chatId) faltando.push('TELEGRAM_CANAL');
    problems.push(
      `Destino de postagem e o Telegram, mas falta preencher ${faltando.join(' e ')} no .env. ` +
        'Crie o bot no @BotFather (comando /newbot), cole o token aqui e rode "npm run testar-telegram".'
    );
  }

  const anySourceEnabled =
    config.shopee.enabled || config.mercadolivre.enabled || config.amazon.enabled;

  if (!anySourceEnabled) {
    problems.push(
      'Nenhuma fonte de ofertas configurada (Shopee, Mercado Livre ou Amazon). Preencha pelo menos uma no .env.'
    );
  }

  if (!config.shopee.enabled) {
    logger.warn('Shopee desativada: faltam SHOPEE_APP_ID / SHOPEE_APP_SECRET no .env.');
  }
  if (!config.mercadolivre.enabled) {
    const faltando = [];
    if (!config.mercadolivre.sampleAffiliateLink) faltando.push('ML_SAMPLE_AFFILIATE_LINK');
    if (!config.mercadolivre.clientId) faltando.push('ML_CLIENT_ID');
    if (!config.mercadolivre.clientSecret) faltando.push('ML_CLIENT_SECRET');
    if (!config.mercadolivre.refreshToken) faltando.push('ML_REFRESH_TOKEN');
    logger.warn(
      `Mercado Livre desativado: falta preencher ${faltando.join(', ')} no .env` +
        (faltando.includes('ML_REFRESH_TOKEN') ? ' (rode "npm run setup-mercadolivre").' : '.')
    );
  }
  if (!config.amazon.enabled) {
    logger.warn(
      'Amazon desativada: faltam AMAZON_CREATORS_CLIENT_ID / AMAZON_CREATORS_CLIENT_SECRET / AMAZON_ASSOCIATE_TAG no .env.'
    );
  }

  if (problems.length > 0) {
    for (const p of problems) logger.error(p);
    throw new Error('Configuracao incompleta. Corrija o .env e rode novamente.');
  }
}
