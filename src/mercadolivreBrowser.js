// Gera o link OFICIAL "meli.la" pra um produto, usando um navegador de
// verdade logado na SUA conta do Mercado Livre - o mesmo caminho que voce
// usaria clicando em "Compartilhar" manualmente. Diferente do metodo
// alternativo em mercadolivreLink.js (que so cola matt_word/matt_tool na
// URL do produto), esse aqui tem certeza de comissao, porque e' literalmente
// o botao oficial sendo clicado.
//
// ATENCAO - primeira vez: uma janela do Chrome vai abrir e pedir login. Voce
// tem varios minutos pra digitar senha/SMS com calma - o bot NAO fecha nem
// recarrega essa janela enquanto espera (foi o bug da primeira versao: cada
// promocao nova abria uma aba nova e fechava a anterior no meio do login).
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import { logger, describeError } from './logger.js';

// Fora da Desktop de proposito - o Windows Defender protege pastas como
// Desktop/Documentos por padrao ("Controlled Folder Access"), e isso ja deu
// dor de cabeca antes com o Chrome do script Python (motivo de varios
// crashes ali). LOCALAPPDATA fica fora dessa protecao.
// Configuravel via ML_PERFIL_DIR - em servidores na nuvem (Railway), isso
// aponta pro Volume persistente (senao perderia o login salvo a cada deploy).
const PASTA_PERFIL =
  process.env.ML_PERFIL_DIR || path.join(os.homedir(), 'AppData', 'Local', 'bot-afiliados-ml-browser');

// No seu PC (Windows) usa o Edge que ja vem instalado - evita precisar
// baixar o Chromium do Playwright (~200MB, que falhava por bloqueio de
// rede/antivirus nesta maquina). Em servidor na nuvem (Linux, sem Edge nem
// Chrome instalado) deixe ML_NAVEGADOR_CHANNEL vazio - Playwright usa o
// Chromium proprio dele (baixado no build). Se um dia trocar de navegador,
// so mudar essa variavel no .env, sem mexer no codigo.
// IMPORTANTE: nao pode ser so "|| 'msedge'" - uma string vazia ("") tambem e'
// "falsy" em JS, e precisamos DISTINGUIR "variavel nao configurada" (seu PC -
// usa Edge, como sempre) de "configurada de proposito como vazia/chromium"
// (servidor Linux - usa o Chromium do proprio Playwright, sem canal nenhum).
const CANAL_NAVEGADOR_BRUTO = process.env.ML_NAVEGADOR_CHANNEL;
const CANAL_NAVEGADOR =
  CANAL_NAVEGADOR_BRUTO === undefined
    ? 'msedge'
    : ['', 'nenhum', 'none', 'chromium'].includes(CANAL_NAVEGADOR_BRUTO.trim().toLowerCase())
      ? undefined
      : CANAL_NAVEGADOR_BRUTO.trim();

// No seu PC, "headless: false" (janela visivel) e' necessario pra voce ver
// e fazer o login/SMS na primeira vez. Em servidor na nuvem nao tem tela
// nenhuma - "sim" aqui liga o modo headless (sem janela). So funciona sem
// precisar logar de novo se a pasta de perfil (ML_PERFIL_DIR) ja chegar la
// com o login que voce ja fez aqui no PC (ver DEPLOY_RAILWAY.txt).
const NAVEGADOR_HEADLESS = ['sim', 'true', '1'].includes(
  String(process.env.ML_NAVEGADOR_HEADLESS || 'nao').trim().toLowerCase()
);

// ATENCAO: a pagina do produto tem DOIS botoes escritos "Compartilhar":
//   1. ".generate_link_button" -> o da BARRA DE AFILIADO (so aparece quando
//      voce esta logado numa conta de afiliado). E' esse que gera o meli.la.
//   2. ".ui-pdp-share__link__label" -> o compartilhamento social comum
//      (WhatsApp, Facebook...). Esse NAO gera link de afiliado nenhum.
// O bot clicava no 2 por engano - por isso o campo do link nunca aparecia.
const SELETOR_BOTAO_COMPARTILHAR = '.generate_link_button';
const SELETOR_CAMPO_LINK = '[data-testid="text-field__label_link"]';
// Pedacos de URL que aparecem quando o Mercado Livre exige (re)login ou
// verificacao (senha, SMS, challenge de seguranca) no meio de uma acao.
const REGEX_URL_DE_LOGIN = /\/(lgz|login|phone-validation|challenges)(\/|\?|$)/i;

let contextoPromise = null;
let paginaPromise = null;

// So UMA operacao no navegador por vez (login ou geracao de link) - sem
// isso, duas promocoes chegando quase juntas abririam duas abas concorrentes,
// cada uma fechando/recarregando a outra no meio do caminho.
let fila = Promise.resolve();
function executarNaFila(tarefa) {
  const resultado = fila.then(tarefa, tarefa);
  // Independente de sucesso/erro, a fila segue pra proxima tarefa.
  fila = resultado.then(() => {}, () => {});
  return resultado;
}

async function obterContexto() {
  if (!contextoPromise) {
    contextoPromise = chromium
      .launchPersistentContext(PASTA_PERFIL, {
        // Ve os comentarios de CANAL_NAVEGADOR/NAVEGADOR_HEADLESS acima -
        // no seu PC isso continua abrindo o Edge com janela visivel, igual
        // sempre foi.
        channel: CANAL_NAVEGADOR,
        headless: NAVEGADOR_HEADLESS,
        viewport: { width: 1280, height: 900 },
        args: [
          '--disable-blink-features=AutomationControlled',
          // Necessario rodando como root dentro de um container (Railway) -
          // sem isso o Chromium recusa abrir. Nao faz diferenca no Windows.
          '--no-sandbox',
        ],
      })
      .catch((err) => {
        contextoPromise = null;
        throw err;
      });
  }
  return contextoPromise;
}

// UMA aba so, reaproveitada em toda chamada - login e geracao de link usam a
// MESMA pagina, nunca abrindo/fechando abas no meio de um login em andamento.
async function obterPagina() {
  const contexto = await obterContexto();
  if (!paginaPromise) {
    paginaPromise = contexto.newPage().catch((err) => {
      paginaPromise = null;
      throw err;
    });
  }
  return paginaPromise;
}

let avisouLoginPendente = false;

// Se uma navegacao trava (timeout), a ABA pode ter ficado num estado ruim
// (travada numa requisicao que nunca termina) - fecha ela e esquece a
// referencia, pra proxima chamada abrir uma aba NOVA. A sessao/login
// continua valendo (fica salva no PERFIL do navegador, nao na aba), entao
// isso nao pede login de novo - so evita que uma aba travada continue
// estourando o mesmo timeout de 60s em TODAS as promocoes seguintes.
async function reciclarPaginaComProblema() {
  const paginaAntiga = paginaPromise;
  paginaPromise = null;
  try {
    const pagina = await paginaAntiga;
    await pagina?.close();
  } catch {
    // Se nem fechar direito deu certo, tanto faz - a proxima obterPagina()
    // vai tentar abrir uma aba nova de qualquer jeito.
  }
}

// Tenta abrir o produto e clicar em "Compartilhar". Se o Mercado Livre
// exigir (re)login/verificacao nesse meio tempo, ele REDIRECIONA a mesma
// aba pra uma URL de login/challenge/SMS - em vez de adivinhar de antemao
// se esta logado (o que se mostrou pouco confiavel), a deteccao e reativa:
// depois do clique, olha pra onde a pagina foi. Se foi pra uma URL de
// login, espera (sem tocar na aba) ate voltar - ai tenta de novo.
async function tentarGerarLink(pagina, permalinkProduto, timeoutMs, jaEsperouLogin) {
  try {
    await pagina.goto(permalinkProduto, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    await reciclarPaginaComProblema();
    throw new Error(
      `a pagina do produto nao carregou a tempo (${describeError(err)}) - a aba travada foi fechada, a proxima promocao ja abre numa aba nova`
    );
  }

  const botao = pagina.locator(SELETOR_BOTAO_COMPARTILHAR).first();
  await botao.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {
    // Se caiu direto numa tela de login, a mensagem certa vem logo abaixo -
    // aqui so tratamos o caso de a pagina do produto nao ter o botao.
    if (REGEX_URL_DE_LOGIN.test(pagina.url())) return;
    throw new Error(
      'nao achei o botao "Compartilhar" da barra de afiliado nessa pagina. Isso quase sempre quer ' +
        'dizer que a janela nao esta logada na sua conta de AFILIADO do Mercado Livre (a barra so ' +
        'aparece quando esta), ou que o anuncio saiu do ar'
    );
  });
  await botao.click().catch(() => {});

  // Da um instante pro clique processar (abrir o modal OU redirecionar
  // pro login) antes de checar onde a aba parou.
  await pagina.waitForTimeout(1500);

  if (REGEX_URL_DE_LOGIN.test(pagina.url())) {
    if (jaEsperouLogin) {
      throw new Error('mesmo depois do login, o Mercado Livre continuou pedindo autenticacao');
    }

    if (!avisouLoginPendente) {
      avisouLoginPendente = true;
      logger.warn(
        'Mercado Livre pediu login/verificacao nessa janela do Chrome (senha e/ou codigo do SMS). ' +
          'Entre com calma - o bot vai esperar ate 5 minutos sem tocar na janela.'
      );
    }

    await pagina
      .waitForFunction(
        (regexFonte) => !new RegExp(regexFonte, 'i').test(location.href),
        REGEX_URL_DE_LOGIN.source,
        { timeout: 5 * 60 * 1000 }
      )
      .catch(() => {
        throw new Error('login no Mercado Livre nao foi concluido a tempo (esperei 5 minutos)');
      });

    avisouLoginPendente = false;
    logger.info('Mercado Livre: login concluido, gerando o link de novo.');
    return tentarGerarLink(pagina, permalinkProduto, timeoutMs, true);
  }

  const campo = pagina.locator(SELETOR_CAMPO_LINK).first();
  await campo.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {
    throw new Error(
      'o modal "Compartilhar" abriu mas o campo do link nao apareceu - o produto pode estar fora ' +
        'do programa de afiliados, ou a pagina mudou de layout'
    );
  });

  // O campo abre vazio e so preenche depois de uma chamada assincrona no
  // backend do Mercado Livre (levou uns 4-5s nos testes). Importante: ele
  // as vezes preenche PRIMEIRO com a URL longa do produto e so depois troca
  // pelo "meli.la" - por isso esperamos especificamente pelo meli.la, senao
  // acabariamos capturando o link errado (sem a comissao garantida).
  //
  // As vezes o 1o clique no botao acontece antes da barra de afiliado
  // terminar de carregar, e o campo fica vazio pra sempre. Pra cobrir isso,
  // esperamos o meli.la em janelas curtas e, se nao vier, clicamos de novo
  // no botao (ate 3 tentativas) - foi o que resolveu o "campo ficou vazio".
  let pegouMeliLa = false;
  for (let tentativa = 1; tentativa <= 3 && !pegouMeliLa; tentativa++) {
    pegouMeliLa = await pagina
      .waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return Boolean(el && el.value && el.value.includes('meli.la'));
        },
        SELETOR_CAMPO_LINK,
        { timeout: Math.max(6000, Math.floor(timeoutMs / 3)) }
      )
      .then(() => true)
      .catch(() => false);

    if (!pegouMeliLa && tentativa < 3) {
      await botao.click().catch(() => {});
    }
  }

  const link = (await campo.inputValue()) || '';

  if (!pegouMeliLa) {
    if (!link) {
      throw new Error(
        'o campo do link ficou vazio (o Mercado Livre nao gerou o link - pode ser produto fora do ' +
          'programa de afiliados, ou sua conta de afiliado nao esta ativa nessa sessao)'
      );
    }
    throw new Error(
      `o Mercado Livre devolveu um link que nao e "meli.la" (${link.slice(0, 80)}) - nao vou usar ` +
        'pra nao arriscar perder a comissao'
    );
  }

  return link;
}

// Abre uma pagina de produto QUALQUER (nao precisa ser Mercado Livre) no
// MESMO navegador ja aberto (reaproveitando a fila) e devolve a URL da foto
// de capa (tag "og:image"), ou null se nao achou/nao carregou. Usado como
// reforco pra buscar a foto de promocoes que chegaram sem imagem: um fetch
// simples (sem navegador) e mais rapido, mas alguns sites (a Amazon
// principalmente) bloqueiam pedidos que nao parecem vir de um navegador de
// verdade - abrindo com o navegador de verdade, esse bloqueio nao rola.
export function buscarImagemDeCapaNoNavegador(url, { timeoutMs = 20000 } = {}) {
  return executarNaFila(async () => {
    const pagina = await obterPagina();
    try {
      // "load" (nao so "domcontentloaded") + uma pausa curta: alguns links
      // curtos (Shopee principalmente) so montam a tag og:image via
      // JavaScript DEPOIS da pagina carregar - sem essa espera, a gente lia
      // o DOM cedo demais e achava a tag vazia.
      await pagina.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      await pagina.waitForTimeout(2000);
    } catch {
      await reciclarPaginaComProblema();
      return null;
    }
    try {
      return await pagina.evaluate(() => {
        const tag =
          document.querySelector('meta[property="og:image"]') ||
          document.querySelector('meta[name="twitter:image"]') ||
          document.querySelector('meta[property="og:image:secure_url"]');
        return tag ? tag.getAttribute('content') : null;
      });
    } catch {
      return null;
    }
  });
}

// Devolve o link "https://meli.la/..." ou lanca erro se nao conseguir (o
// chamador deve cair pro metodo alternativo nesse caso).
export function gerarLinkAfiliadoML(permalinkProduto, { timeoutMs = 60000 } = {}) {
  return executarNaFila(async () => {
    const pagina = await obterPagina();
    return tentarGerarLink(pagina, permalinkProduto, timeoutMs, false);
  });
}

// Busca um produto no Mercado Livre pelo NOME (usado quando o link original e'
// um perfil social de revendedor, que nao aponta pro produto especifico).
// Abre a busca na janela logada, pega o 1o resultado e devolve o permalink.
// ATENCAO: busca por nome pode trazer um produto PARECIDO (mesma marca, outro
// tamanho/sabor) - por isso o chamador deve marcar o resultado pra conferir.
async function buscarPermalinkPorTitulo(pagina, titulo, timeoutMs) {
  const urlBusca = `https://lista.mercadolivre.com.br/${encodeURIComponent(titulo)}`;
  try {
    await pagina.goto(urlBusca, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    await reciclarPaginaComProblema();
    throw new Error(
      `a pagina de busca nao carregou a tempo (${describeError(err)}) - a aba travada foi fechada, a proxima promocao ja abre numa aba nova`
    );
  }

  if (REGEX_URL_DE_LOGIN.test(pagina.url())) {
    throw new Error('a busca caiu numa tela de login - entre na conta na janela do Chrome');
  }

  // Os resultados carregam por JS depois da pagina (uns 4-6s), entao esperamos
  // ate aparecer um link de PRODUTO de verdade. Ignoramos os links de
  // rastreamento (click1.mercadolivre.com.br) e pegamos so o formato de
  // produto: ".../<slug>/p/MLB123..." ou ".../MLB-123...".
  const permalink = await pagina
    .waitForFunction(
      () => {
        const ehProduto = (h) =>
          /^https?:\/\/(www\.|produto\.)?mercadoli(vre|bre)\.com(\.br)?\/.*(\/p\/MLB\d+|MLB-\d+)/i.test(h);
        for (const a of document.querySelectorAll('a[href]')) {
          if (ehProduto(a.href)) return a.href;
        }
        return false;
      },
      undefined,
      { timeout: timeoutMs, polling: 500 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);

  if (!permalink) {
    throw new Error(`a busca por "${titulo.slice(0, 40)}" nao trouxe nenhum produto`);
  }
  return permalink.split(/[?#]/)[0];
}

const REGEX_URL_PRODUTO_ML = /^https?:\/\/(www\.|produto\.)?mercadoli(vre|bre)\.com(\.br)?\/.*(\/p\/MLB\d+|MLB-\d+)/i;

// Abre o link do revendedor (meli.la que aponta pra uma pagina "/social/...")
// no navegador LOGADO e pega o produto que o link destaca. Isso so funciona
// no navegador de verdade (com JavaScript): a pagina "/social" carrega os
// produtos por JS, e o produto do link vem em PRIMEIRO/destaque. Ler a pagina
// por fetch (sem JS) mostrava outro produto - foi a origem do produto errado.
//
// IMPORTANTE (descoberto depois que o metodo original parou de funcionar): o
// card do produto em destaque, no layout atual do Mercado Livre, NAO tem mais
// um <a href> estatico apontando pro produto - o botao "Ir para produto" navega
// via JavaScript (o href real so existe depois do clique, com tracking/matt_*
// novos a cada vez). Por isso o metodo antigo (so procurar <a href>) parou de
// achar qualquer coisa. A solucao confiavel e' CLICAR no botao e ler pra onde
// a pagina foi - exatamente o que um humano faria.
async function pegarProdutoDestaqueDoPerfil(pagina, urlRevendedor, timeoutMs) {
  try {
    await pagina.goto(urlRevendedor, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    await reciclarPaginaComProblema();
    throw new Error(
      `a pagina do revendedor nao carregou a tempo (${describeError(err)}) - a aba travada foi fechada, a proxima promocao ja abre numa aba nova`
    );
  }

  if (REGEX_URL_DE_LOGIN.test(pagina.url())) {
    throw new Error('o link do revendedor caiu numa tela de login - entre na conta na janela do Chrome');
  }

  // 1a tentativa (rapida, sem clicar em nada): as vezes o href estatico
  // existe mesmo - se achar, nem precisa clicar.
  const permalinkEstatico = await pagina
    .waitForFunction(
      (regexFonte) => {
        const regex = new RegExp(regexFonte, 'i');
        for (const a of document.querySelectorAll('a[href]')) {
          if (regex.test(a.href)) return a.href;
        }
        return false;
      },
      REGEX_URL_PRODUTO_ML.source,
      { timeout: 4000, polling: 500 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);

  if (permalinkEstatico) return permalinkEstatico.split(/[?#]/)[0];

  // 2a tentativa (a que realmente funciona no layout atual): clica no botao
  // "Ir para produto" do card em destaque (o primeiro/topo da pagina, que e'
  // sempre o produto que o link do revendedor aponta) e ve pra onde a aba foi.
  let botao = pagina.getByText('Ir para produto', { exact: true }).first();
  let apareceu = await botao
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);

  if (!apareceu) {
    // Alguns layouts usam outro texto no botao/card - tenta o card do
    // primeiro produto como um todo (link que envolve a foto+titulo).
    botao = pagina.locator('a, [role="link"]').filter({ hasText: /./ }).first();
    apareceu = await botao
      .waitFor({ state: 'visible', timeout: 4000 })
      .then(() => true)
      .catch(() => false);
  }

  if (!apareceu) {
    throw new Error('nao achei o produto em destaque na pagina do revendedor');
  }

  const urlAntes = pagina.url();
  await botao.click().catch(() => {});

  await pagina
    .waitForFunction(
      (urlAntesPagina) => location.href !== urlAntesPagina,
      urlAntes,
      { timeout: timeoutMs, polling: 300 }
    )
    .catch(() => {});

  const urlDepois = pagina.url();
  if (!REGEX_URL_PRODUTO_ML.test(urlDepois)) {
    throw new Error('nao achei o produto em destaque na pagina do revendedor');
  }
  return urlDepois.split(/[?#]/)[0];
}

// Resolve o produto destacado no link do revendedor E gera o seu meli.la.
// Devolve { link, permalink } pra o chamador registrar qual produto foi.
export function gerarLinkDePerfilSocial(urlRevendedor, { timeoutMs = 60000 } = {}) {
  return executarNaFila(async () => {
    const pagina = await obterPagina();
    const permalink = await pegarProdutoDestaqueDoPerfil(pagina, urlRevendedor, timeoutMs);
    let ultimoErro;
    for (let i = 1; i <= 2; i++) {
      try {
        const link = await tentarGerarLink(pagina, permalink, timeoutMs, false);
        return { link, permalink };
      } catch (err) {
        ultimoErro = err;
      }
    }
    throw ultimoErro;
  });
}

// Busca pelo nome E gera o meli.la do 1o resultado, tudo na mesma janela.
// Devolve { link, permalink } pra o chamador poder mostrar qual produto foi
// escolhido (ja que pode ser um parecido).
export function gerarLinkPorBusca(titulo, { timeoutMs = 60000 } = {}) {
  return executarNaFila(async () => {
    const pagina = await obterPagina();
    const permalink = await buscarPermalinkPorTitulo(pagina, titulo, timeoutMs);
    // A geracao do meli.la as vezes volta vazia na 1a vez (a barra de afiliado
    // demora a responder) - tenta ate 2 vezes antes de desistir.
    let ultimoErro;
    for (let i = 1; i <= 2; i++) {
      try {
        const link = await tentarGerarLink(pagina, permalink, timeoutMs, false);
        return { link, permalink };
      } catch (err) {
        ultimoErro = err;
      }
    }
    throw ultimoErro;
  });
}

export async function fecharNavegadorML() {
  if (contextoPromise) {
    try {
      const ctx = await contextoPromise;
      await ctx.close();
    } catch (err) {
      logger.warn(`Erro fechando navegador do Mercado Livre: ${describeError(err)}`);
    }
    contextoPromise = null;
    paginaPromise = null;
  }
}
