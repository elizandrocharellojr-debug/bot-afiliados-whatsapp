// Envio pro Telegram via Bot API oficial (https://core.telegram.org/bots/api).
//
// Diferente do WhatsApp (que so tem biblioteca nao-oficial e por isso da
// risco de suspensao), aqui e' tudo suportado pelo proprio Telegram: bot
// criado no @BotFather, API publica e documentada, sem risco de ban.
import { config } from './config.js';
import { logger, describeError } from './logger.js';

function urlApi(metodo) {
  return `https://api.telegram.org/bot${config.telegram.botToken}/${metodo}`;
}

// A Bot API responde sempre {ok: true/false, ...}. Quando da erro, o campo
// "description" traz o motivo em ingles - traduzimos os mais comuns pra
// mensagem util em vez de repassar o texto cru.
function explicarErro(descricao) {
  const d = String(descricao || '').toLowerCase();
  if (d.includes('chat not found')) {
    return (
      `canal "${config.telegram.chatId}" nao encontrado. Confira o @ no .env e, principalmente, ` +
      'se o seu bot foi ADICIONADO como administrador do canal (sem isso o Telegram age como se o ' +
      'canal nao existisse)'
    );
  }
  if (d.includes('not enough rights') || d.includes('need administrator')) {
    return 'o bot esta no canal mas nao tem permissao pra publicar - deixe ele administrador com "Publicar mensagens" ligado';
  }
  if (d.includes('unauthorized')) {
    return 'token do bot invalido - confira TELEGRAM_BOT_TOKEN no .env (o token que o @BotFather te deu)';
  }
  return descricao || 'erro desconhecido';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chamar(metodo, corpo) {
  let resp;
  try {
    resp = await fetch(urlApi(metodo), {
      method: 'POST',
      body: corpo,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // Guarda o erro original em "cause" - describeError() usa isso pra
    // mostrar o motivo real (DNS, timeout, conexao resetada...) em vez de
    // so "fetch failed", que nao diz nada sozinho.
    throw new Error(`nao consegui falar com o Telegram (${err.message})`, { cause: err });
  }

  let dados;
  try {
    dados = await resp.json();
  } catch {
    throw new Error(`resposta inesperada do Telegram (HTTP ${resp.status})`);
  }

  if (!dados.ok) {
    throw new Error(explicarErro(dados.description));
  }
  return dados.result;
}

// FormData/URLSearchParams com Blob so podem ser enviados UMA vez (o corpo e'
// consumido no fetch). Como a gente re-tenta, precisa remontar o corpo a cada
// tentativa - por isso "montarCorpo" e' uma funcao, nao um valor pronto.
async function chamarComRetry(metodo, montarCorpo, tentativas = 6) {
  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await chamar(metodo, montarCorpo());
    } catch (err) {
      ultimoErro = err;
      // Erro de configuracao (token/canal/permissao) nao melhora tentando de
      // novo - so re-tenta as falhas de REDE ("fetch failed"), que sao
      // passageiras.
      const ehRede = /nao consegui falar com o Telegram/i.test(err.message);
      if (!ehRede || i === tentativas) break;
      logger.warn(`Telegram: tentativa ${i} falhou (${describeError(err)}) - tentando de novo em ${i * 2}s.`);
      await sleep(i * 2000);
    }
  }
  throw ultimoErro;
}

// Confere se o token e o canal estao certos ANTES de tentar postar - usado
// pelo comando de teste e na largada do bot.
export async function verificarTelegram() {
  const bot = await chamar('getMe', new URLSearchParams());
  const chat = await chamar('getChat', new URLSearchParams({ chat_id: config.telegram.chatId }));
  return { nomeBot: bot.username, nomeCanal: chat.title || chat.username || config.telegram.chatId };
}

// Manda a promocao pro canal. Se tiver imagem, vai como foto com legenda -
// igualzinho ao formato que ja era postado no WhatsApp.
export async function enviarPromocaoTelegram(texto, imagemBuffer) {
  // O Telegram corta legenda de foto em 1024 caracteres. Promocao quase
  // nunca passa disso, mas se passar, manda como texto pra nao perder nada.
  if (imagemBuffer && texto.length <= 1024) {
    await chamarComRetry('sendPhoto', () => {
      const form = new FormData();
      form.append('chat_id', config.telegram.chatId);
      form.append('caption', texto);
      form.append('photo', new Blob([imagemBuffer]), 'oferta.jpg');
      return form;
    });
    return;
  }

  await chamarComRetry('sendMessage', () =>
    new URLSearchParams({
      chat_id: config.telegram.chatId,
      text: texto,
      // Sem preview de link: a promocao ja vai com a foto do produto, e o
      // preview automatico deixava a mensagem gigante e feia.
      disable_web_page_preview: 'true',
    })
  );
}

// Igual a acima, mas nao deixa o erro estourar - devolve true/false. Usado
// pelo leitor de grupos, que nao pode parar por causa de uma falha isolada.
export async function tentarEnviarPromocaoTelegram(texto, imagemBuffer) {
  try {
    await enviarPromocaoTelegram(texto, imagemBuffer);
    return true;
  } catch (err) {
    logger.error(`Telegram: falha ao postar - ${describeError(err)}`);
    return false;
  }
}
