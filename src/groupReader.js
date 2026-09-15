import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { logger, describeError } from './logger.js';
import { onConnect } from './whatsapp/connection.js';
import { resolveGroupJidsByName } from './whatsapp/groupResolver.js';
import { wasMessageProcessed, markMessageProcessed } from './dedupe.js';
import {
  extractAffiliateParams,
  buildAffiliateLinkFromScrapedUrl,
  resolverPermalinkProduto,
} from './mercadolivreLink.js';
import {
  gerarLinkAfiliadoML,
  gerarLinkDePerfilSocial,
  buscarImagemDeCapaNoNavegador,
} from './mercadolivreBrowser.js';
import { buildAffiliateLink as buildAmazonAffiliateLink } from './amazonLink.js';
import { generateShopeeAffiliateLink } from './sources/shopeeLink.js';
import { tentarEnviarPromocaoTelegram } from './telegram.js';
import { salvarPromocao } from './promoStore.js';

const LINK_RE = /https?:\/\/\S+/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fila global de promocoes: mesmo que varios grupos lancem itens ao mesmo
// tempo, cada promocao e processada e postada UMA POR VEZ, na ordem em que
// chegou - nunca varios posts no mesmo segundo (assinatura obvia de bot).
let filaPromocoes = Promise.resolve();
function enfileirarPromocao(tarefa) {
  const resultado = filaPromocoes.then(tarefa, tarefa);
  filaPromocoes = resultado.then(() => {}, () => {});
  return resultado;
}

// Le o intervalo configurado (SEGUNDOS_ENTRE_POSTS_WHATSAPP) - aceita um
// numero fixo ("120") ou uma faixa aleatoria ("90-150"). Devolve ms.
function sortearIntervaloWhatsappMs() {
  const bruto = String(config.groupReader.segundosEntrePostsWhatsapp || '30-90').trim();
  const m = bruto.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    return (min + Math.random() * Math.max(0, max - min)) * 1000;
  }
  const n = Number(bruto);
  return (Number.isFinite(n) ? n : 60) * 1000;
}

// Fila SO do WhatsApp: as promocoes ja convertidas entram aqui e sao postadas
// no grupo UMA POR VEZ, com espacamento entre elas (anti-restricao). O
// Telegram NAO passa por aqui - ele recebe tudo na hora, sem espera nenhuma,
// porque e' oficial e nao corre risco. Assim nada fica pra tras: se chegam
// muitas juntas, elas se acumulam nesta fila e vao saindo no ritmo seguro,
// enquanto o Telegram ja recebeu todas na hora.
const filaWhatsapp = [];
let drenandoWhatsapp = false;

function enfileirarWhatsapp(tarefa) {
  filaWhatsapp.push(tarefa);
  if (!drenandoWhatsapp) drenarFilaWhatsapp();
}

async function drenarFilaWhatsapp() {
  drenandoWhatsapp = true;
  try {
    while (filaWhatsapp.length > 0) {
      const tarefa = filaWhatsapp.shift();
      try {
        await tarefa();
      } catch (err) {
        logger.error(`Leitor de grupos: erro postando no WhatsApp - ${describeError(err)}`);
      }
      // Espaca so se ainda tem mais na fila (post isolado nao precisa esperar).
      if (filaWhatsapp.length > 0) {
        const esperaMs = sortearIntervaloWhatsappMs();
        logger.info(
          `Leitor de grupos: ${filaWhatsapp.length} promocao(oes) na fila do WhatsApp - proxima em ${Math.round(esperaMs / 1000)}s (Telegram ja recebeu todas).`
        );
        await sleep(esperaMs);
      }
    }
  } finally {
    drenandoWhatsapp = false;
  }
}

function normalizeBareJid(jid) {
  if (!jid) return null;
  const [user] = jid.split(':');
  const domain = jid.split('@')[1];
  return domain ? `${user.split('@')[0]}@${domain}` : user;
}

// Grupos com "mensagens temporarias" (autodestroi apos X tempo) ligado
// embrulham toda mensagem dentro de "ephemeralMessage" - sem desembrulhar
// isso, extractText() nao acha nada e a mensagem passa batido em silencio
// (foi o motivo de 3 dos 5 grupos nunca aparecerem: provavelmente estao com
// mensagem temporaria ligada). "viewOnceMessage" (ver uma vez) embrulha do
// mesmo jeito.
function desembrulharMensagem(message) {
  if (!message) return message;
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.viewOnceMessageV2Extension?.message ||
    message.documentWithCaptionMessage?.message ||
    message
  );
}

function extractText(message) {
  const m = desembrulharMensagem(message);
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    ''
  );
}

// Encurtadores da propria Amazon. Sao links que JA carregam a tag de quem
// postou no grupo de origem - por isso precisam ser resolvidos ate a URL do
// produto antes de receber a SUA tag, senao a comissao fica com a outra
// pessoa (foi o caso do "amzlink.to", que passava batido).
const DOMINIOS_CURTOS_AMAZON = new Set([
  'amzn.to',
  'amzlink.to',
  'a.co',
  'amzn.eu',
  'amzn.asia',
  'amzn.com',
  'amzn.la',
  'link.amazon',
  'amzn.divulguei.app',
]);

const USER_AGENT_NAVEGADOR =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Segue o(s) redirecionamento(s) de um link curto/encurtado GENERICO (sem
// saber de antemao pra onde vai) e devolve a URL final, ou null se nao
// conseguiu. Usado como ultimo recurso pra links de encurtadores que a gente
// nao conhece o dominio (ex: cloakers como "divulguei.app" com outro prefixo,
// ou qualquer encurtador novo que apareca) - assim nao precisamos adivinhar
// cada dominio nao-oficial que os grupos passarem a usar.
async function seguirRedirecionamentoGenerico(url) {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT_NAVEGADOR },
      signal: AbortSignal.timeout(10000),
    });
    resp.body?.cancel?.().catch(() => {});
    return resp.url || null;
  } catch {
    return null;
  }
}

// Baixa os bytes de uma URL de imagem qualquer (ja resolvida). Devolve null
// se falhar - sem foto e' melhor que travar a promocao inteira por causa
// disso.
async function baixarBufferDaImagem(urlImagem) {
  try {
    const resp = await fetch(urlImagem, {
      headers: { 'User-Agent': USER_AGENT_NAVEGADOR },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      logger.warn(`Leitor de grupos: busca de foto - baixar a imagem deu HTTP ${resp.status} (${urlImagem.slice(0, 90)})`);
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return buffer.length > 0 ? buffer : null;
  } catch (err) {
    logger.warn(`Leitor de grupos: busca de foto - falha baixando a imagem (${describeError(err)})`);
    return null;
  }
}

// Busca a URL da foto de capa (tag "og:image") direto na pagina do produto,
// com um fetch simples (rapido, sem abrir navegador nenhum). Funciona bem
// pra paginas que ja vem prontas do servidor (Mercado Livre, a maioria das
// lojas) - NAO funciona bem quando a pagina monta o conteudo via JavaScript
// depois de carregar (varios links curtos da Shopee fazem isso).
async function buscarUrlImagemViaFetch(url) {
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT_NAVEGADOR, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      logger.warn(`Leitor de grupos: busca de foto (fetch simples) - pagina respondeu HTTP ${resp.status} (${url.slice(0, 90)})`);
      return null;
    }
    const html = await resp.text();

    // Aceita og:image com "property" antes OU depois de "content" (a ordem
    // dos atributos varia de site pra site), e cai pro twitter:image se a
    // pagina nao tiver og:image.
    const urlImagem = (
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    )?.[1] || null;

    if (!urlImagem) {
      logger.warn(`Leitor de grupos: busca de foto (fetch simples) - pagina carregou mas nao achei og:image (${url.slice(0, 90)})`);
    }
    return urlImagem;
  } catch (err) {
    logger.warn(`Leitor de grupos: busca de foto (fetch simples) - falha (${describeError(err)}) em ${url.slice(0, 90)}`);
    return null;
  }
}

// Ultimo recurso quando a promocao chega SEM NENHUMA foto (nem no grupo, nem
// numa mensagem seguinte, dentro do prazo de espera): busca a foto de capa
// direto na pagina do produto - a mesma imagem que aparece quando VOCE
// compartilha esse link em qualquer rede social. Toda loja grande (Amazon,
// Mercado Livre, Shopee) publica isso na tag "og:image" da pagina, entao da
// pra pegar sem precisar entender o layout de cada site.
//
// 1a tentativa: fetch simples, sem navegador (rapido). 2a tentativa (so pra
// Mercado Livre, que ja tem o navegador aberto e logado): abre a pagina de
// verdade no Edge - mais lento, mas passa do bloqueio de robo que a Amazon
// costuma aplicar em pedidos "crus", e tambem funciona em paginas que so
// montam o conteudo via JavaScript (a 1a tentativa nao consegue essas).
async function buscarFotoDoProduto(url) {
  if (!url) return null;

  const urlImagem = await buscarUrlImagemViaFetch(url);
  if (urlImagem) {
    const buffer = await baixarBufferDaImagem(urlImagem);
    if (buffer) return buffer;
  }

  if (config.mercadolivre.usarNavegador) {
    try {
      const urlImagemNavegador = await buscarImagemDeCapaNoNavegador(url);
      if (urlImagemNavegador) {
        const buffer = await baixarBufferDaImagem(urlImagemNavegador);
        if (buffer) return buffer;
      } else {
        logger.warn(`Leitor de grupos: busca de foto (navegador) - nao achei og:image na pagina renderizada (${url.slice(0, 90)})`);
      }
    } catch (err) {
      logger.warn(`Leitor de grupos: busca de foto (navegador) - falha (${describeError(err)}) em ${url.slice(0, 90)}`);
    }
  }

  return null;
}

// Devolve {link, aviso} - "aviso" preenchido quando nao foi possivel aplicar
// seu afiliado (o link original e devolvido do mesmo jeito).
// "seguirRedirectGenerico" controla se, quando o dominio nao for reconhecido,
// tentamos seguir o redirecionamento pra ver se ele cai em Shopee/ML/Amazon
// (fica false na chamada recursiva, pra nunca tentar duas vezes o mesmo link).
async function montarLinkAfiliado(urlOriginal, { seguirRedirectGenerico = true } = {}) {
  let dominio;
  try {
    dominio = new URL(urlOriginal).hostname.toLowerCase();
  } catch {
    return { link: urlOriginal, aviso: 'link invalido' };
  }

  if (dominio.includes('amazon.') || DOMINIOS_CURTOS_AMAZON.has(dominio)) {
    if (!config.amazon.associateTag) {
      return { link: urlOriginal, aviso: 'AMAZON_ASSOCIATE_TAG nao configurado no .env' };
    }
    let urlProduto = urlOriginal;
    if (DOMINIOS_CURTOS_AMAZON.has(dominio)) {
      // Link curto da Amazon (amzn.to, amzlink.to, a.co...) - precisa
      // resolver o redirecionamento pra pegar a URL real do produto antes de
      // marcar com a sua tag. Sem isso, a tag de QUEM POSTOU no grupo de
      // origem continua valendo, e a comissao vai pra essa pessoa.
      try {
        const resp = await fetch(urlOriginal, {
          redirect: 'follow',
          headers: { 'User-Agent': USER_AGENT_NAVEGADOR },
        });
        urlProduto = resp.url || urlOriginal;
      } catch (err) {
        return {
          link: urlOriginal,
          aviso: `nao consegui resolver o link curto da Amazon (${dominio}: ${err.message})`,
        };
      }
      // Se o redirecionamento nao saiu do encurtador, marcar a tag nao
      // adianta nada - melhor avisar do que postar um link da outra pessoa.
      const dominioResolvido = (() => {
        try {
          return new URL(urlProduto).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();
      if (!dominioResolvido.includes('amazon.')) {
        return {
          link: urlOriginal,
          aviso: `o link curto ${dominio} nao levou a uma pagina da Amazon - nao da pra garantir sua comissao`,
        };
      }
    }
    // Manda o link da Amazon "cru" (com sua tag), sem encurtar - o dominio
    // amazon.com.br visivel passa confianca pra quem vai clicar; um
    // encurtador generico (ulvis.net) escondia isso.
    const linkFinal = buildAmazonAffiliateLink(urlProduto, config.amazon.associateTag);
    return { link: linkFinal, aviso: null };
  }

  if (dominio.includes('mercadolivre.') || dominio === 'meli.la' || dominio.includes('mercadolibre.')) {
    const params = extractAffiliateParams(config.mercadolivre.sampleAffiliateLink);
    if (!params) {
      return { link: urlOriginal, aviso: 'ML_SAMPLE_AFFILIATE_LINK nao configurado/reconhecido no .env' };
    }

    // 1a tentativa (rapida, SEM navegador): link do produto + matt_word/
    // matt_tool direto na URL - so um fetch, geralmente menos de 1s. Isso
    // funciona pra quase todo link (a mesma tecnica que o link de exemplo do
    // .env usa) e evita abrir o Chrome pra cada promocao - antes disso, TODA
    // promocao do Mercado Livre esperava o navegador (podia levar dezenas de
    // segundos, e como so um link e processado por vez, isso atrasava as
    // promocoes SEGUINTES tambem, de qualquer origem, ate acabar).
    try {
      const link = await buildAffiliateLinkFromScrapedUrl(urlOriginal, params);
      return { link, aviso: null };
    } catch (err) {
      const msgErro = describeError(err);

      // Caso do link de revendedor (pagina "/social/..."): esse aqui SO da
      // pra resolver com navegador mesmo (o fetch simples nao roda o
      // JavaScript da pagina) - abre o link no navegador LOGADO e pega o
      // produto que ele destaca (o certo vem em primeiro).
      if (config.mercadolivre.usarNavegador && /perfil de outro afiliado/i.test(msgErro)) {
        try {
          const { link, permalink } = await gerarLinkDePerfilSocial(urlOriginal);
          logger.info(
            `Leitor de grupos: link era de revendedor - peguei o produto em destaque (${permalink.slice(0, 60)}) e gerei seu meli.la.`
          );
          return { link, aviso: null };
        } catch (errPerfil) {
          return { link: urlOriginal, aviso: `link de revendedor e nao consegui pegar o produto em destaque (${describeError(errPerfil)})` };
        }
      }

      // Qualquer outro erro (formato mudou, produto tirado do ar etc.): como
      // ultimo recurso, tenta o navegador tambem (ele as vezes resolve casos
      // que o fetch simples nao consegue, por exemplo paginas que so montam
      // via JavaScript) antes de desistir e mandar pra conferida manual.
      if (config.mercadolivre.usarNavegador) {
        try {
          const permalink = await resolverPermalinkProduto(urlOriginal);
          const linkOficial = await gerarLinkAfiliadoML(permalink);
          return { link: linkOficial, aviso: null };
        } catch (errNavegador) {
          return { link: urlOriginal, aviso: describeError(errNavegador) };
        }
      }

      return { link: urlOriginal, aviso: msgErro };
    }
  }

  if (dominio.includes('shopee.') || dominio.includes('shope.ee')) {
    const { link, erro } = await generateShopeeAffiliateLink(urlOriginal);
    if (erro) return { link: urlOriginal, aviso: erro };
    return { link, aviso: null };
  }

  // Dominio nao reconhecido de cara - antes de desistir, tenta seguir o
  // redirecionamento UMA vez (pode ser um encurtador/cloaker novo escondendo
  // um link da Shopee/ML/Amazon por baixo, tipo os "divulguei.app" que os
  // grupos usam). So faz isso na 1a passada (seguirRedirectGenerico=false na
  // recursao evita loop se o destino tambem nao for reconhecido).
  if (seguirRedirectGenerico) {
    const destinoFinal = await seguirRedirecionamentoGenerico(urlOriginal);
    if (destinoFinal && destinoFinal !== urlOriginal) {
      let dominioFinal;
      try {
        dominioFinal = new URL(destinoFinal).hostname.toLowerCase();
      } catch {
        dominioFinal = null;
      }
      if (dominioFinal && dominioFinal !== dominio) {
        const resultado = await montarLinkAfiliado(destinoFinal, { seguirRedirectGenerico: false });
        if (!resultado.aviso) return resultado;
      }
    }
  }

  return { link: urlOriginal, aviso: 'sem link de afiliado configurado pra este site' };
}

// Pendentes de aprovacao manual (modo PY_APROVACAO_MANUAL=sim). Em memoria -
// se o bot reiniciar, os pendentes anteriores se perdem (o proximo ciclo de
// leitura simplesmente nao vai encontra-los de novo, ja que a mensagem
// original ja foi marcada como processada).
const pendentes = new Map();
let proximoIdPendente = 1;

function montarMensagemAprovacao(id, grupoOrigem, textoFinal, aviso) {
  const avisoTxt = aviso ? `\n\nAtencao: ${aviso}` : '';
  return (
    `[#${id}] Achado no grupo "${grupoOrigem}":\n\n${textoFinal}${avisoTxt}\n\n` +
    `Responda "sim ${id}" pra postar no grupo de destino, ou "nao ${id}" pra ignorar.`
  );
}

// Posta no grupo do WhatsApp (uma passada). Devolve true se conseguiu em
// pelo menos um grupo. Chamada de dentro da fila do WhatsApp (com
// espacamento entre os posts) - NUNCA direto do fluxo principal.
async function postarNoWhatsapp(sock, texto, imagemBuffer) {
  let ok = false;
  for (const jid of config.whatsapp.groupJids) {
    try {
      if (imagemBuffer) {
        await sock.sendMessage(jid, { image: imagemBuffer, caption: texto });
      } else {
        await sock.sendMessage(jid, { text: texto });
      }
      ok = true;
    } catch (err) {
      logger.error(`Leitor de grupos: falha ao postar no grupo de destino - ${describeError(err)}`);
    }
    if (config.whatsapp.groupJids.length > 1) await sleep(2000);
  }
  return ok;
}

// Distribui a promocao: Telegram na HORA (sem espera), WhatsApp entra na fila
// espacada. Devolve true se pelo menos um caminho aceitou a promocao.
async function postarNoDestino(sock, texto, imagemBuffer) {
  let aceitou = false;

  if (config.groupReader.postaNoTelegram) {
    const ok = await tentarEnviarPromocaoTelegram(texto, imagemBuffer);
    if (ok) {
      aceitou = true;
      logger.info('Leitor de grupos: postado no canal do Telegram.');
    }
  }

  if (config.groupReader.postaNoWhatsapp) {
    // Nao espera aqui - so poe na fila. A fila posta no ritmo seguro.
    enfileirarWhatsapp(() => postarNoWhatsapp(sock, texto, imagemBuffer));
    aceitou = true;
  }

  return aceitou;
}

async function baixarImagem(sock, msg) {
  if (!desembrulharMensagem(msg.message)?.imageMessage) return null;
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: undefined, reuploadRequest: sock.updateMediaMessage }
    );
    return buffer;
  } catch (err) {
    logger.warn(`Leitor de grupos: nao consegui baixar a imagem da mensagem (${describeError(err)}).`);
    return null;
  }
}

// "Foto solta": quando quem posta manda a IMAGEM e o LINK em mensagens
// SEPARADAS (em vez de foto com legenda), em qualquer ordem - foto antes do
// link, ou o link antes da foto. So casa se for do MESMO remetente e dentro
// de uma janela curta, pra nao repetir o bug antigo de grudar a foto de uma
// promocao no texto de outra.
const JANELA_FOTO_SOLTA_MS = 25_000; // foto chegou ANTES do link: por quanto tempo guardamos ela esperando o link
const JANELA_ESPERA_FOTO_MS = 6_000; // link chegou SEM foto: quanto tempo esperamos a foto chegar antes de postar sem ela
const imagensSoltas = new Map(); // chave: "remoteJid|participant" -> { buffer, timestamp }
const textosAguardandoFoto = new Map(); // chave -> { resolverComFoto(buffer) }

function chaveFotoSolta(remoteJid, participant) {
  return `${remoteJid}|${participant || ''}`;
}

function limparFotosSoltasExpiradas() {
  const agora = Date.now();
  for (const [chave, valor] of imagensSoltas) {
    if (agora - valor.timestamp > JANELA_FOTO_SOLTA_MS) imagensSoltas.delete(chave);
  }
}

// Espera ate JANELA_ESPERA_FOTO_MS por uma foto que ainda pode estar a
// caminho (do mesmo remetente) antes de desistir e devolver null.
function esperarFotoAtrasada(chaveFoto) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      textosAguardandoFoto.delete(chaveFoto);
      resolve(null);
    }, JANELA_ESPERA_FOTO_MS);
    textosAguardandoFoto.set(chaveFoto, {
      resolverComFoto: (buffer) => {
        clearTimeout(timer);
        resolve(buffer);
      },
    });
  });
}

async function processarMensagemDeGrupo(sock, msg, nomeGrupo) {
  const remoteJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  const participant = msg.key.participant || remoteJid;
  const chaveFoto = chaveFotoSolta(remoteJid, participant);

  if (wasMessageProcessed(remoteJid, messageId)) return;

  const texto = extractText(msg.message).trim();
  const match = texto.match(LINK_RE);
  const temImagemNestaMensagem = Boolean(desembrulharMensagem(msg.message)?.imageMessage);

  if (!texto || !match) {
    // Sem link nesta mensagem. Se veio com foto (foto solta, sem link na
    // legenda): se JA tem um link dessa mesma promocao esperando foto (o
    // link chegou primeiro), entrega a foto pra ele na hora. Senao, guarda
    // por um tempo curto - o link pode vir numa mensagem seguinte.
    if (temImagemNestaMensagem) {
      const buffer = await baixarImagem(sock, msg);
      if (buffer) {
        const aguardando = textosAguardandoFoto.get(chaveFoto);
        if (aguardando) {
          textosAguardandoFoto.delete(chaveFoto);
          aguardando.resolverComFoto(buffer);
        } else {
          limparFotosSoltasExpiradas();
          imagensSoltas.set(chaveFoto, { buffer, timestamp: Date.now() });
        }
      }
    }
    markMessageProcessed(remoteJid, messageId);
    return;
  }

  const linkOriginal = match[0];
  let resultado;
  try {
    resultado = await montarLinkAfiliado(linkOriginal);
  } catch (err) {
    logger.error(`Leitor de grupos: erro montando link de afiliado - ${describeError(err)}`);
    return; // nao marca como processada - tenta de novo na proxima mensagem/ciclo
  }

  const { link: linkFinal, aviso } = resultado;
  const textoFinal = texto.replace(linkOriginal, linkFinal);

  // 1a opcao: imagem junto do PROPRIO texto (legenda da foto). 2a opcao: a
  // "foto solta" recente do MESMO remetente, se o link chegou DEPOIS dela.
  // 3a opcao: o link chegou ANTES da foto - espera alguns segundos pra ver
  // se ela chega. 4a opcao (ultimo recurso): a promocao nao veio com foto
  // NENHUMA no WhatsApp - busca a foto de capa direto na pagina do produto
  // (o link ja convertido, com seu afiliado). So se nem isso der e' que
  // manda sem foto mesmo.
  let imagemBuffer = await baixarImagem(sock, msg);
  if (!imagemBuffer) {
    limparFotosSoltasExpiradas();
    const solta = imagensSoltas.get(chaveFoto);
    if (solta) {
      imagemBuffer = solta.buffer;
      imagensSoltas.delete(chaveFoto);
    } else {
      imagemBuffer = await esperarFotoAtrasada(chaveFoto);
    }
  }
  if (!imagemBuffer) {
    imagemBuffer = await buscarFotoDoProduto(linkFinal);
  }

  if (!config.groupReader.aprovacaoManual && !aviso) {
    // Telegram sai na hora; WhatsApp entra na fila espacada (dentro de
    // postarNoDestino). Nada de espera aqui - senao o Telegram atrasaria junto.
    const postou = await postarNoDestino(sock, textoFinal, imagemBuffer);
    if (postou) {
      // Guarda no painel local (http://127.0.0.1:PORTA/painel), de onde voce
      // copia e cola no WhatsApp Web sem precisar do celular.
      try {
        salvarPromocao({ texto: textoFinal, imagemBuffer, origem: nomeGrupo });
      } catch (err) {
        logger.warn(`Leitor de grupos: nao consegui salvar no painel (${describeError(err)}).`);
      }
      logger.info(`Leitor de grupos: postado automaticamente (origem: "${nomeGrupo}").`);
      markMessageProcessed(remoteJid, messageId);
    } else {
      logger.error(
        `Leitor de grupos: NAO consegui postar a promocao de "${nomeGrupo}" (conexao caida?) - nao vou marcar como processada.`
      );
    }
    return;
  }

  // Cai aqui quando o link nao pode ser convertido com confianca (aviso) ou
  // quando a aprovacao manual esta ligada. Sempre logamos - antes isso ficava
  // mudo no terminal, e as mensagens iam quietas pra aprovacao no privado (ou
  // se perdiam se MEU_NUMERO nao estivesse certo), dando a impressao de que o
  // bot tinha ignorado a promocao.
  if (aviso) {
    logger.warn(
      `Leitor de grupos: link de "${nomeGrupo}" NAO foi convertido pro seu afiliado (${aviso}) - enviando pra aprovacao manual.`
    );
  } else {
    logger.info(`Leitor de grupos: aprovacao manual ligada - enviando promocao de "${nomeGrupo}" pra voce revisar.`);
  }

  const id = proximoIdPendente++;
  pendentes.set(id, { textoFinal, imagemBuffer });

  // Mesmo precisando de conferida, salva no painel - assim nada some da sua
  // lista. O campo "aviso" faz o card aparecer marcado ("confira o link")
  // pra voce decidir se manda mesmo assim ou nao.
  try {
    salvarPromocao({ texto: textoFinal, imagemBuffer, origem: nomeGrupo, aviso });
  } catch (err) {
    logger.warn(`Leitor de grupos: nao consegui salvar no painel (${describeError(err)}).`);
  }

  // Quando o WhatsApp NAO e destino de postagem (ex: numero secundario usado
  // so pra LER os grupos), o bot nao pode mandar nada por la - nem pedido de
  // aprovacao. Enviar mensagem e' justamente o que faz o WhatsApp desconfiar
  // e suspender. Nesse caso o aviso vai pro Telegram, que e' oficial.
  if (!config.groupReader.postaNoWhatsapp) {
    if (config.groupReader.postaNoTelegram) {
      const enviou = await tentarEnviarPromocaoTelegram(
        `⚠️ Precisa da sua conferida (origem: "${nomeGrupo}")\n` +
          (aviso ? `Motivo: ${aviso}\n` : '') +
          `\n${textoFinal}`,
        imagemBuffer
      );
      if (enviou) {
        logger.info(`Leitor de grupos: promocao #${id} mandada pro Telegram pra voce conferir.`);
      }
    } else {
      logger.warn(
        `Leitor de grupos: promocao de "${nomeGrupo}" precisa de conferida, mas nao ha destino ` +
          'configurado pra avisar voce. Confira DESTINO_POSTAGEM no .env.'
      );
    }
    pendentes.delete(id);
    markMessageProcessed(remoteJid, messageId);
    return;
  }

  const numero = config.groupReader.meuNumero.replace(/\D/g, '');
  // Numero brasileiro valido: 55 + DDD (2) + celular (9) = 13 digitos (ou 12
  // pra fixo). Mandar mensagem pra numero INEXISTENTE e' um jeito classico de
  // o WhatsApp derrubar a sessao por suspeita de spam - ja aconteceu aqui
  // (sessao encerrada 1 segundo depois de um pedido de aprovacao).
  const numeroInvalido = numero.startsWith('55') && numero.length !== 12 && numero.length !== 13;
  if (!numero || numeroInvalido) {
    logger.warn(
      numeroInvalido
        ? `Leitor de grupos: MEU_NUMERO/PY_MEU_NUMERO parece INVALIDO ("${numero}" tem ${numero.length} digitos; ` +
            'celular brasileiro tem 13: 55 + DDD + 9 digitos). NAO vou mandar pedido de aprovacao pra ele - ' +
            'mensagem pra numero inexistente pode DERRUBAR a sessao do WhatsApp. Corrija no .env.'
        : 'Leitor de grupos: MEU_NUMERO/PY_MEU_NUMERO nao configurado - nao consegui pedir aprovacao. Mensagem ignorada.'
    );
    pendentes.delete(id);
    markMessageProcessed(remoteJid, messageId);
    return;
  }

  const selfJid = `${numero}@s.whatsapp.net`;
  try {
    await sock.sendMessage(selfJid, {
      text: montarMensagemAprovacao(id, nomeGrupo, textoFinal, aviso),
    });
    logger.info(`Leitor de grupos: pedido de aprovacao #${id} enviado pro seu privado.`);
  } catch (err) {
    logger.error(`Leitor de grupos: falha ao pedir aprovacao - ${describeError(err)}`);
  }

  markMessageProcessed(remoteJid, messageId);
}

const PADRAO_RESPOSTA = /\b(sim|ok|aprovar)\s+(\d+)\b|\b(nao|não|ignorar)\s+(\d+)\b/i;

async function processarRespostaAprovacao(sock, msg) {
  const texto = extractText(msg.message).trim();
  const m = texto.match(PADRAO_RESPOSTA);
  if (!m) return;

  const aprovou = Boolean(m[1]);
  const id = Number(m[2] || m[4]);
  const pendente = pendentes.get(id);
  if (!pendente) return;

  pendentes.delete(id);

  if (aprovou) {
    await postarNoDestino(sock, pendente.textoFinal, pendente.imagemBuffer);
    logger.info(`Leitor de grupos: promocao #${id} aprovada e postada.`);
  } else {
    logger.info(`Leitor de grupos: promocao #${id} descartada.`);
  }
}

// Registra o listener de mensagens num socket especifico. Chamada de novo a
// cada conexao nova (via onConnect) - depois de uma reconexao, o Baileys cria
// um socket NOVO (o antigo morre), entao o listener precisa ser reanexado
// nele, senao o bot fica "surdo" silenciosamente apos qualquer queda de
// conexao.
async function configurarParaSocket(sock) {
  const { encontrados, naoEncontrados } = await resolveGroupJidsByName(
    sock,
    config.groupReader.sourceGroupNames
  );

  if (naoEncontrados.length > 0) {
    logger.warn(
      `Leitor de grupos: nao encontrei estes grupos (nome bate exatamente com o do WhatsApp?): ${naoEncontrados.join(', ')}`
    );
  }
  if (encontrados.length === 0) {
    logger.error('Leitor de grupos: nenhum grupo de origem valido - nada pra monitorar.');
    return;
  }

  const jidParaNome = new Map(encontrados.map((g) => [g.jid, g.name]));
  const selfJidBare = normalizeBareJid(sock.user?.id);
  // JID do seu numero de aprovacao (MEU_NUMERO). Pode ser o MESMO numero do
  // bot (aprovacao chega no "Mensagem para voce mesmo") OU um numero
  // diferente - tipo seu WhatsApp PESSOAL. Nos dois casos as respostas
  // "sim N"/"nao N" sao reconhecidas.
  const numeroAprovacao = config.groupReader.meuNumero.replace(/\D/g, '');
  const meuNumeroJidBare = numeroAprovacao ? `${numeroAprovacao}@s.whatsapp.net` : null;

  const destinos = [];
  if (config.groupReader.postaNoTelegram) destinos.push(`Telegram (${config.telegram.chatId})`);
  if (config.groupReader.postaNoWhatsapp) destinos.push('grupo do WhatsApp');

  logger.info(
    `Leitor de grupos ativo, monitorando em tempo real: ${encontrados.map((g) => g.name).join(', ')} ` +
      `(modo ${config.groupReader.aprovacaoManual ? 'com aprovacao manual' : 'automatico'}).`
  );
  logger.info(`Leitor de grupos: as promocoes vao ser postadas em ${destinos.join(' + ') || 'NENHUM destino (confira DESTINO_POSTAGEM no .env)'}.`);
  if (!config.groupReader.postaNoWhatsapp) {
    logger.info(
      'Modo SO LEITURA no WhatsApp: esse numero nao vai enviar NENHUMA mensagem por la (nem no ' +
        'grupo, nem no seu privado) - so escutar os grupos. E o jeito mais seguro de usar um ' +
        'numero secundario sem correr risco de suspensao.'
    );
  }
  if (config.mercadolivre.usarNavegador) {
    logger.info(
      'Mercado Livre: o link oficial "meli.la" e gerado via navegador (abre na primeira promocao ' +
        'do ML que chegar). Se for a primeira vez, uma janela do Chrome vai abrir - se pedir login, ' +
        'entre na sua conta do Mercado Livre nela (a sessao fica salva pras proximas vezes). Enquanto ' +
        'nao logar, esses links caem pro metodo alternativo automaticamente.'
    );
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid;

      if (jidParaNome.has(remoteJid)) {
        const nomeGrupo = jidParaNome.get(remoteJid);
        // Entra na fila global e segue pro proximo evento sem esperar aqui -
        // a fila garante um post por vez, na ordem de chegada, com o
        // espacamento anti-restricao entre eles.
        enfileirarPromocao(async () => {
          try {
            await processarMensagemDeGrupo(sock, msg, nomeGrupo);
          } catch (err) {
            logger.error(`Leitor de grupos: erro processando mensagem - ${describeError(err)}`);
          }
        });
        continue;
      }

      // Respostas de aprovacao ("sim N" / "nao N") - vindas do chat "Mensagem
      // para voce mesmo" (se o numero de aprovacao for o mesmo do bot) OU do
      // seu numero pessoal separado (MEU_NUMERO).
      const bareRemetente = normalizeBareJid(remoteJid);
      if (
        config.groupReader.aprovacaoManual &&
        (bareRemetente === selfJidBare || bareRemetente === meuNumeroJidBare)
      ) {
        try {
          await processarRespostaAprovacao(sock, msg);
        } catch (err) {
          logger.error(`Leitor de grupos: erro processando aprovacao - ${describeError(err)}`);
        }
      }
    }
  });
}

export function startGroupReader() {
  if (!config.groupReader.enabled) {
    logger.warn(
      'Leitor de grupos desativado: GRUPOS_ORIGEM/PY_GRUPOS_ORIGEM vazio no .env. ' +
        'Preencha com os nomes exatos dos grupos, separados por virgula.'
    );
    return;
  }

  onConnect((sock) => {
    configurarParaSocket(sock).catch((err) =>
      logger.error(`Leitor de grupos: erro ao configurar - ${describeError(err)}`)
    );
  });
}
