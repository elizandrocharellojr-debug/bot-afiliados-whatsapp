// Painel local (http://127.0.0.1:PORTA/painel) - lista as promocoes ja
// convertidas com o SEU link de afiliado, cada uma com botao de copiar
// texto e copiar imagem, pra colar no WhatsApp Web sem usar o celular.
//
// Roda dentro do mesmo servidor local que atende a extensao do navegador.
import { readFileSync, unlinkSync } from 'node:fs';
import {
  listarPromocoes,
  marcarComoEnviada,
  apagarPromocao,
  caminhoDaImagem,
  textoDaPromocao,
  definirImagem,
} from './promoStore.js';
import { config } from './config.js';
import { waitForConnection } from './whatsapp/connection.js';
import { logger, describeError } from './logger.js';
import { gerarLinkAfiliadoML } from './mercadolivreBrowser.js';

// Manifest do PWA - faz o "Adicionar a tela inicial" virar um app de verdade
// (icone proprio, abre em tela cheia, sem barra do navegador).
const MANIFEST_PWA = {
  name: 'Oferta Ninja - Promocoes',
  short_name: 'Oferta Ninja',
  description: 'Promocoes convertidas com seu link de afiliado, prontas pra postar.',
  // Caminhos ABSOLUTOS (comecando com "/") de proposito: o manifest.json e'
  // servido em "/painel/manifest.json", entao um caminho relativo tipo
  // "./painel/icone.svg" duplicava o pedaco "painel" (virava
  // "/painel/painel/icone.svg", que nao existe) - o atalho da tela inicial
  // do celular nunca abria certo por causa disso.
  start_url: '/painel',
  scope: '/painel/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#16181c',
  theme_color: '#1a73e8',
  icons: [
    { src: '/painel/icone.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/painel/icone.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
  ],
};

// Extensao do arquivo salvo -> Content-Type correto na hora de servir. Usado
// quando VOCE sobe uma foto pelo painel (pode vir PNG/WEBP da galeria do
// celular, nao so JPEG como as que o bot baixa do WhatsApp).
const TIPO_POR_EXTENSAO = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

// Icone em SVG (nao precisa de arquivo de imagem separado).
const ICONE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#16181c"/>
  <circle cx="256" cy="208" r="96" fill="#1a73e8"/>
  <rect x="128" y="196" width="256" height="34" rx="17" fill="#16181c"/>
  <circle cx="212" cy="213" r="13" fill="#fff"/>
  <circle cx="300" cy="213" r="13" fill="#fff"/>
  <path d="M144 360h224a24 24 0 0 1 0 48H144a24 24 0 0 1 0-48z" fill="#25d366"/>
</svg>`;

// Tela de senha - aparece quando o painel e' aberto sem a senha. Melhor que
// exigir a senha digitada na URL, principalmente no celular: aqui voce cola
// uma vez e o navegador guarda pras proximas.
function paginaSenha(errou) {
  return PAGINA_SENHA_BASE.replace('__ERROU__', errou ? 'true' : 'false');
}

const PAGINA_SENHA_BASE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar - Oferta Ninja</title>
<link rel="icon" href="/painel/icone.svg" type="image/svg+xml">
<meta name="theme-color" content="#1a73e8">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #1a1a1a;
  }
  .caixa {
    background: #fff; border-radius: 14px; padding: 26px 22px;
    width: 100%; max-width: 380px; box-shadow: 0 2px 10px rgba(0,0,0,.1);
  }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { color: #666; font-size: 14px; line-height: 1.5; margin: 0 0 18px; }
  input {
    width: 100%; padding: 14px; font-size: 16px; font-family: inherit;
    border: 1px solid #ccc; border-radius: 9px; margin-bottom: 12px;
    background: transparent; color: inherit;
  }
  button {
    width: 100%; padding: 14px; border: 0; border-radius: 9px;
    background: #1a73e8; color: #fff; font-size: 16px; font-weight: 600;
    font-family: inherit; cursor: pointer;
  }
  .erro { color: #c5221f; font-size: 13px; margin-top: 12px; display: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8e8e8; }
    .caixa { background: #22252a; box-shadow: none; }
    p { color: #9aa0a6; }
    input { border-color: #3a3d42; }
  }
</style>
</head>
<body>
  <form class="caixa" id="form">
    <h1>Oferta Ninja 🥷</h1>
    <p>Cole a senha do painel (ela aparece no terminal do PC, depois de <code>?t=</code>).</p>
    <input id="senha" type="password" placeholder="Senha do painel" autocomplete="current-password" autofocus>
    <button type="submit">Entrar</button>
    <div class="erro" id="erro">Senha incorreta - confira e tente de novo.</div>
  </form>
<script>
  const form = document.getElementById('form');
  const campo = document.getElementById('senha');
  const erro = document.getElementById('erro');
  // O servidor marca "true" aqui quando a senha enviada estava ERRADA.
  const ERROU = __ERROU__;

  if (ERROU) {
    // Apaga a senha guardada (era invalida) e mostra o aviso - sem isso a
    // pagina tentaria entrar de novo com a mesma senha errada, em loop.
    try { localStorage.removeItem('painelToken'); } catch {}
    erro.style.display = 'block';
  } else {
    // Sem erro: se a senha ja foi salva neste aparelho, entra sozinho.
    try {
      const salva = localStorage.getItem('painelToken');
      if (salva) location.replace('/painel?t=' + encodeURIComponent(salva));
    } catch {}
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const valor = campo.value.trim();
    if (!valor) return;
    try { localStorage.setItem('painelToken', valor); } catch {}
    location.href = '/painel?t=' + encodeURIComponent(valor);
  });
</script>
</body>
</html>`;

export const PAGINA_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Promocoes prontas - Oferta Ninja</title>
<link rel="manifest" href="/painel/manifest.json">
<link rel="icon" href="/painel/icone.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/painel/icone.svg">
<meta name="theme-color" content="#1a73e8">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Oferta Ninja">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #1a1a1a;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 20px; }
  .vazio {
    background: #fff; border-radius: 12px; padding: 40px 24px;
    text-align: center; color: #666; border: 1px dashed #d0d0d0;
  }
  .card {
    background: #fff; border-radius: 12px; padding: 16px;
    margin-bottom: 14px; display: flex; gap: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
  }
  .card.enviada { opacity: .5; }
  .foto {
    width: 110px; height: 110px; object-fit: cover;
    border-radius: 8px; background: #eee; flex-shrink: 0;
  }
  .sem-foto {
    width: 110px; height: 110px; border-radius: 8px; background: #eee;
    display: flex; align-items: center; justify-content: center;
    color: #aaa; font-size: 12px; flex-shrink: 0; text-align: center;
  }
  .sem-foto-clicavel {
    cursor: pointer; border: 2px dashed #bbb; white-space: pre-line;
    line-height: 1.4; padding: 6px;
  }
  .sem-foto-clicavel:hover { background: #e4e4e4; border-color: #1a73e8; color: #1a73e8; }
  .sem-foto-clicavel input { display: none; }
  .conteudo { flex: 1; min-width: 0; }
  .meta { font-size: 12px; color: #888; margin-bottom: 6px; }
  .texto {
    white-space: pre-wrap; word-break: break-word;
    font-size: 14px; line-height: 1.45; margin-bottom: 12px;
    max-height: 160px; overflow-y: auto;
  }
  .acoes { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    border: 0; border-radius: 8px; padding: 9px 14px;
    font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit;
  }
  .b-enviar { background: #25d366; color: #fff; }
  .b-texto { background: #1a73e8; color: #fff; }
  .b-foto  { background: #e8f0fe; color: #1a73e8; }
  .b-ok    { background: #e6f4ea; color: #137333; }
  .b-x     { background: #fce8e6; color: #c5221f; }
  button:disabled { opacity: .5; cursor: default; }
  .aviso { font-size: 12px; color: #137333; margin-left: 4px; }
  .tag-conferir {
    display: inline-block; background: #fef7e0; color: #b06000;
    font-size: 12px; font-weight: 600; padding: 3px 8px;
    border-radius: 6px; margin-bottom: 6px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8e8e8; }
    .card, .vazio { background: #22252a; box-shadow: none; }
    .vazio { border-color: #3a3d42; color: #999; }
  }
  /* Celular: card em coluna, foto maior e botoes grandes pro dedo. */
  @media (max-width: 620px) {
    body { padding: 14px 12px calc(20px + env(safe-area-inset-bottom)); }
    h1 { font-size: 18px; }
    .sub { font-size: 13px; margin-bottom: 14px; }
    .card { flex-direction: column; gap: 12px; padding: 14px; }
    .foto, .sem-foto { width: 100%; height: 190px; }
    .texto { max-height: 210px; font-size: 15px; }
    .acoes { gap: 10px; }
    button { padding: 13px 16px; font-size: 15px; flex: 1 1 auto; min-width: 46%; }
  }
</style>
</head>
<body>
  <h1>Promocoes prontas 🥷</h1>
  <div class="sub">Ja com o seu link de afiliado. Copie e cole no WhatsApp Web. A lista se atualiza sozinha.</div>
  <div id="lista"></div>

<script>
const lista = document.getElementById('lista');
let ultimoJson = '';

// Senha de acesso: vem na URL na primeira vez (?t=...) e fica guardada, pra
// quando o app for aberto pelo atalho da tela inicial (que abre sem a ?t=).
const TOKEN = (function () {
  const daUrl = new URLSearchParams(location.search).get('t');
  if (daUrl) {
    try { localStorage.setItem('painelToken', daUrl); } catch {}
    return daUrl;
  }
  try { return localStorage.getItem('painelToken') || ''; } catch { return ''; }
})();

// Poe a senha na URL de cada chamada.
function comToken(u) {
  if (!TOKEN) return u;
  return u + (u.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN);
}

function formatarHora(iso) {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function copiarTexto(id, texto, botao) {
  await navigator.clipboard.writeText(texto);
  avisar(botao, 'copiado!');
}

// Copia a imagem como PNG - e o unico formato que o clipboard do navegador
// aceita, e o WhatsApp Web cola numa boa.
async function copiarImagem(id, botao) {
  try {
    const resp = await fetch(comToken('/painel/imagem/' + id));
    const blobOriginal = await resp.blob();
    const bitmap = await createImageBitmap(blobOriginal);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    avisar(botao, 'imagem copiada!');
  } catch (err) {
    avisar(botao, 'falhou: ' + err.message);
  }
}

// Manda a foto escolhida pelo <input type="file"> pro servidor, crua no
// corpo da requisicao (sem FormData/base64 - mais simples e mais leve).
// "spanTexto" e' so o texto dentro do quadrado clicavel (nao o label inteiro
// - assim o <input> continua no lugar se der erro e voce quiser tentar de
// novo, em vez de sumir do DOM).
async function subirFoto(id, arquivo, spanTexto) {
  const textoOriginal = spanTexto.textContent;
  spanTexto.textContent = 'enviando foto...';
  try {
    const resp = await fetch(comToken('/painel/imagem/' + id), {
      method: 'POST',
      headers: { 'Content-Type': arquivo.type || 'image/jpeg' },
      body: arquivo,
    });
    const dados = await resp.json();
    if (!dados.ok) {
      spanTexto.textContent = 'falhou: ' + (dados.error || 'erro desconhecido');
      setTimeout(() => { spanTexto.textContent = textoOriginal; }, 2500);
      return;
    }
    carregar(true);
  } catch (err) {
    spanTexto.textContent = 'falhou: ' + err.message;
    setTimeout(() => { spanTexto.textContent = textoOriginal; }, 2500);
  }
}

function avisar(botao, msg) {
  const span = document.createElement('span');
  span.className = 'aviso';
  span.textContent = msg;
  botao.after(span);
  setTimeout(() => span.remove(), 2000);
}

// Manda a promocao pro grupo do WhatsApp - so acontece quando VOCE clica,
// nunca sozinho.
async function enviar(id, botao) {
  botao.disabled = true;
  const textoOriginal = botao.textContent;
  botao.textContent = 'Enviando...';
  try {
    const resp = await fetch(comToken('/painel/enviar'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const dados = await resp.json();
    if (dados.ok) {
      carregar(true);
      return;
    }
    botao.textContent = textoOriginal;
    botao.disabled = false;
    avisar(botao, 'erro: ' + dados.error);
  } catch (err) {
    botao.textContent = textoOriginal;
    botao.disabled = false;
    avisar(botao, 'erro: ' + err.message);
  }
}

async function marcar(id, enviada) {
  await fetch(comToken('/painel/marcar'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, enviada }),
  });
  carregar(true);
}

async function apagar(id) {
  await fetch(comToken('/painel/apagar'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  carregar(true);
}

function desenhar(promos) {
  if (promos.length === 0) {
    lista.innerHTML = '<div class="vazio">Nenhuma promocao ainda.<br>Assim que o bot achar uma nos grupos, ela aparece aqui.</div>';
    return;
  }

  lista.innerHTML = '';
  for (const p of promos) {
    const card = document.createElement('div');
    card.className = 'card' + (p.enviada ? ' enviada' : '');

    if (p.temImagem) {
      const img = document.createElement('img');
      img.className = 'foto';
      img.src = comToken('/painel/imagem/' + p.id);
      card.appendChild(img);
    } else {
      // Quadrado clicavel: toca/clica e abre o seletor de foto do aparelho
      // (galeria ou camera, no celular) pra anexar uma imagem manualmente
      // nessa promocao que chegou sem foto.
      const label = document.createElement('label');
      label.className = 'sem-foto sem-foto-clicavel';

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';

      const spanTexto = document.createElement('span');
      spanTexto.textContent = '📷 sem foto\\n(toque p/ enviar)';

      input.onchange = () => {
        const arquivo = input.files && input.files[0];
        if (arquivo) subirFoto(p.id, arquivo, spanTexto);
      };

      label.appendChild(input);
      label.appendChild(spanTexto);
      card.appendChild(label);
    }

    const conteudo = document.createElement('div');
    conteudo.className = 'conteudo';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatarHora(p.criadaEm) + (p.origem ? ' - ' + p.origem : '');
    conteudo.appendChild(meta);

    if (p.aviso) {
      const tag = document.createElement('div');
      tag.className = 'tag-conferir';
      tag.textContent = '⚠️ confira o link: ' + p.aviso;
      conteudo.appendChild(tag);
    }

    const texto = document.createElement('div');
    texto.className = 'texto';
    texto.textContent = p.texto;
    conteudo.appendChild(texto);

    const acoes = document.createElement('div');
    acoes.className = 'acoes';

    if (!p.enviada) {
      const bEnviar = document.createElement('button');
      bEnviar.className = 'b-enviar';
      bEnviar.textContent = 'Enviar pro WhatsApp';
      bEnviar.onclick = () => enviar(p.id, bEnviar);
      acoes.appendChild(bEnviar);
    }

    const bTexto = document.createElement('button');
    bTexto.className = 'b-texto';
    bTexto.textContent = 'Copiar texto';
    bTexto.onclick = () => copiarTexto(p.id, p.texto, bTexto);
    acoes.appendChild(bTexto);

    if (p.temImagem) {
      const bFoto = document.createElement('button');
      bFoto.className = 'b-foto';
      bFoto.textContent = 'Copiar imagem';
      bFoto.onclick = () => copiarImagem(p.id, bFoto);
      acoes.appendChild(bFoto);
    }

    const bOk = document.createElement('button');
    bOk.className = 'b-ok';
    bOk.textContent = p.enviada ? 'Desmarcar' : 'Marcar enviada';
    bOk.onclick = () => marcar(p.id, !p.enviada);
    acoes.appendChild(bOk);

    const bX = document.createElement('button');
    bX.className = 'b-x';
    bX.textContent = 'Apagar';
    bX.onclick = () => apagar(p.id);
    acoes.appendChild(bX);

    conteudo.appendChild(acoes);
    card.appendChild(conteudo);
    lista.appendChild(card);
  }
}

async function carregar(forcar) {
  try {
    const resp = await fetch(comToken('/painel/lista'));
    const dados = await resp.json();
    const json = JSON.stringify(dados);
    // So redesenha se algo mudou - senao o botao que voce acabou de clicar
    // sumiria do nada a cada atualizacao.
    if (forcar || json !== ultimoJson) {
      ultimoJson = json;
      desenhar(dados.promocoes);
    }
  } catch {}
}

carregar(true);
setInterval(carregar, 5000);
</script>
</body>
</html>`;

// Requisicao veio do proprio PC? (localhost dispensa senha)
//
// CUIDADO IMPORTANTE: quando o painel e' exposto por um tunel (Cloudflare,
// ngrok, localtunnel...), o tunel roda NO PROPRIO PC e repassa as chamadas
// pra 127.0.0.1 - ou seja, TODO acesso da internet chegaria "como local" e
// passaria sem senha, deixando o painel aberto pra qualquer um. Por isso: se
// a requisicao tem cabecalho de proxy/tunel, ela NAO conta como local.
const CABECALHOS_DE_TUNEL = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-host',
];

function ehLocal(req) {
  if (CABECALHOS_DE_TUNEL.some((h) => req.headers[h])) return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Senha de acesso: exigida quando a requisicao vem de OUTRO aparelho da rede
// (ex: seu celular). Aceita por "?t=SENHA" na URL ou pelo cabecalho
// "x-painel-token" (usado pelas chamadas internas da pagina).
function autorizado(req) {
  if (ehLocal(req)) return true;
  const esperado = config.painel.token;
  if (!esperado) return false; // sem senha configurada, nao libera a rede
  const url = new URL(req.url, 'http://x');
  const informado = url.searchParams.get('t') || req.headers['x-painel-token'] || '';
  return informado === esperado;
}

// Trata as rotas do painel. Devolve true se a requisicao era do painel (e ja
// foi respondida), false se e' de outra parte do servidor local.
export function tratarRotaDoPainel(req, res, sendJson, readJsonBody) {
  const url = req.url.split('?')[0];
  const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  // Abrir so o endereco (ex: https://xxx.trycloudflare.com) caia no painel
  // em vez de devolver "nao encontrado" - erro facil de cometer no celular.
  if (req.method === 'GET' && (url === '/' || url === '')) {
    res.writeHead(302, { Location: `/painel${queryString}` });
    res.end();
    return true;
  }

  // O manifest/icone do PWA nao expoem dado nenhum - ficam livres pra o
  // celular conseguir instalar o atalho.
  if (req.method === 'GET' && url === '/painel/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.end(JSON.stringify(MANIFEST_PWA));
    return true;
  }

  if (req.method === 'GET' && url === '/painel/icone.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=86400' });
    res.end(ICONE_SVG);
    return true;
  }

  if (url.startsWith('/painel') && !autorizado(req)) {
    // Registra a tentativa - se aparecer muita no log, alguem esta fuçando o
    // endereco do tunel (a senha longa continua protegendo).
    logger.warn(
      `Painel: acesso BLOQUEADO (senha ausente ou errada) em ${url} - origem ${
        req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?'
      }`
    );
    // Se veio senha (mas errada), mostra o aviso de erro. Se nao veio senha
    // nenhuma, mostra a tela limpa (e ela tenta a senha salva no aparelho).
    const veioSenha = Boolean(
      new URL(req.url, 'http://x').searchParams.get('t') || req.headers['x-painel-token']
    );
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(paginaSenha(veioSenha));
    return true;
  }

  if (req.method === 'GET' && (url === '/painel' || url === '/painel/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGINA_HTML);
    return true;
  }

  if (req.method === 'GET' && url === '/painel/lista') {
    sendJson(res, 200, { promocoes: listarPromocoes() });
    return true;
  }

  // Diagnostico temporario: testa se o navegador do Mercado Livre esta
  // REALMENTE logado na sua conta de afiliado, tentando gerar o link oficial
  // "meli.la" de um produto real e conhecido. Devolve o link se funcionou, ou
  // o erro exato (isso diz se e' problema de login ou outra coisa).
  if (req.method === 'GET' && url === '/painel/debug-ml-login') {
    (async () => {
      const produtoTeste =
        'https://www.mercadolivre.com.br/ar-condicionado-split-inverter-tcl-9000-btus-qf-220v-branco-220v/p/MLB75636287';
      try {
        const link = await gerarLinkAfiliadoML(produtoTeste, { timeoutMs: 45000 });
        sendJson(res, 200, { ok: true, logado: true, link });
      } catch (err) {
        sendJson(res, 200, { ok: true, logado: false, erro: describeError(err) });
      }
    })();
    return true;
  }

  // Diagnostico temporario: manda UMA mensagem de texto de teste pro numero
  // pessoal (PY_MEU_NUMERO), no privado (nao no grupo) - serve pra saber se o
  // problema de "enviei mas ninguem ve" e' especifico do grupo (chave de
  // criptografia desatualizada so' daquele grupo) ou da sessao toda.
  if (req.method === 'GET' && url === '/painel/debug-teste-privado') {
    (async () => {
      try {
        const sock = await waitForConnection();
        const numero = (config.groupReader.meuNumero || '').replace(/\D/g, '');
        if (!numero) {
          sendJson(res, 400, { ok: false, error: 'PY_MEU_NUMERO nao configurado' });
          return;
        }
        const jid = `${numero}@s.whatsapp.net`;
        const resultado = await sock.sendMessage(jid, {
          text:
            '🤖 Teste do bot Oferta Ninja - se voce recebeu esta mensagem, ' +
            'a conexao/criptografia com esse numero esta OK. (mensagem de diagnostico, pode ignorar)',
        });
        sendJson(res, 200, { ok: true, jid, messageId: resultado?.key?.id || null });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: describeError(err) });
      }
    })();
    return true;
  }

  // Diagnostico temporario: confere se o(s) WHATSAPP_GROUP_JIDS configurado(s)
  // realmente correspondem a grupo(s) de verdade e mostra o nome de cada um -
  // usa o socket JA conectado (nao abre conexao nova, entao nao arrisca cair).
  if (req.method === 'GET' && url === '/painel/debug-grupo') {
    (async () => {
      try {
        const sock = await waitForConnection();
        const meuJidBare = (sock.user?.id || '').split(':')[0];
        const meuLidBare = (sock.user?.lid || '').split(':')[0];
        const resultado = [];
        for (const jid of config.whatsapp.groupJids) {
          try {
            const meta = await sock.groupMetadata(jid);
            const eu = meta.participants?.find((p) => {
              const idBare = (p.id || '').split(':')[0];
              const lidBare = (p.lid || '').split(':')[0];
              return (
                (meuJidBare && (idBare === meuJidBare || lidBare === meuJidBare)) ||
                (meuLidBare && (idBare === meuLidBare || lidBare === meuLidBare))
              );
            });
            resultado.push({
              jid,
              nome: meta.subject,
              participantes: meta.participants?.length ?? null,
              soAdminPodePostar: meta.announce === true,
              grupoTravado: meta.restrict === true,
              meuStatusNoGrupo: eu ? eu.admin || 'membro comum' : 'NAO ENCONTRADO NA LISTA',
              // Dados crus, so pra debug manual se a comparacao acima falhar
              // por causa de LID vs numero de telefone:
              _debug_meuUser: { id: sock.user?.id, lid: sock.user?.lid, name: sock.user?.name },
              _debug_participantes: meta.participants?.map((p) => ({
                id: p.id,
                lid: p.lid,
                admin: p.admin,
              })),
            });
          } catch (err) {
            resultado.push({ jid, erro: describeError(err) });
          }
        }
        sendJson(res, 200, { ok: true, grupos: resultado });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: describeError(err) });
      }
    })();
    return true;
  }

  if (req.method === 'GET' && url.startsWith('/painel/imagem/')) {
    const id = url.slice('/painel/imagem/'.length);
    const caminho = caminhoDaImagem(id);
    if (!caminho) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const extensao = caminho.split('.').pop().toLowerCase();
    const tipo = TIPO_POR_EXTENSAO[extensao] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'max-age=86400' });
    res.end(readFileSync(caminho));
    return true;
  }

  // Voce mandando uma foto pelo painel (pra uma promocao que chegou sem
  // imagem) - manda os bytes crus no corpo, com o Content-Type do arquivo.
  if (req.method === 'POST' && url.startsWith('/painel/imagem/')) {
    const id = url.slice('/painel/imagem/'.length);
    const LIMITE_BYTES = 10 * 1024 * 1024; // 10MB - generoso pra foto de celular, sem deixar mandar arquivo gigante
    const pedacos = [];
    let total = 0;
    let estourou = false;

    req.on('data', (pedaco) => {
      total += pedaco.length;
      if (total > LIMITE_BYTES) {
        estourou = true;
        req.destroy();
        return;
      }
      pedacos.push(pedaco);
    });

    req.on('end', () => {
      if (estourou) return; // 'error' cuida de responder
      const buffer = Buffer.concat(pedacos);
      if (!buffer.length) {
        sendJson(res, 400, { ok: false, error: 'imagem vazia' });
        return;
      }

      const tipoEnviado = (req.headers['content-type'] || '').toLowerCase();
      const extensao = tipoEnviado.includes('png')
        ? 'png'
        : tipoEnviado.includes('webp')
          ? 'webp'
          : tipoEnviado.includes('gif')
            ? 'gif'
            : 'jpg';

      try {
        // Se ja tinha uma foto com OUTRA extensao (ex: trocando de .png pra
        // .jpg), apaga a antiga - senao ficava arquivo orfao ocupando espaco.
        const caminhoAntigo = caminhoDaImagem(id);
        const salvo = definirImagem(id, buffer, extensao);
        if (!salvo) {
          sendJson(res, 404, { ok: false, error: 'promocao nao encontrada' });
          return;
        }
        if (caminhoAntigo && !caminhoAntigo.endsWith(`.${extensao}`)) {
          try {
            unlinkSync(caminhoAntigo);
          } catch {
            // Nao trava por causa disso - o arquivo antigo so fica orfao.
          }
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
    });

    req.on('error', () => {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'falha recebendo a imagem' });
    });
    return true;
  }

  if (req.method === 'POST' && url === '/painel/enviar') {
    readJsonBody(req)
      .then(async ({ id }) => {
        const texto = textoDaPromocao(id);
        if (!texto) {
          sendJson(res, 404, { ok: false, error: 'promocao nao encontrada' });
          return;
        }
        if (config.whatsapp.groupJids.length === 0) {
          sendJson(res, 400, {
            ok: false,
            error: 'nenhum grupo configurado - rode "npm run setup-whatsapp" e escolha o Oferta Ninja',
          });
          return;
        }

        const caminho = caminhoDaImagem(id);
        const sock = await waitForConnection();
        let algumOk = false;

        for (const jid of config.whatsapp.groupJids) {
          try {
            // Le a imagem do disco na hora do envio (nao guardamos buffer em
            // memoria - o painel pode ficar aberto por horas).
            const payload = caminho
              ? { image: readFileSync(caminho), caption: texto }
              : { text: texto };
            await sock.sendMessage(jid, payload);
            algumOk = true;
          } catch (err) {
            logger.error(`Painel: falha ao enviar pro WhatsApp - ${describeError(err)}`);
          }
        }

        if (algumOk) {
          marcarComoEnviada(id, true);
          logger.info('Painel: promocao enviada pro grupo do WhatsApp (a seu comando).');
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 500, {
            ok: false,
            error: 'nao consegui enviar (WhatsApp conectado? confira o terminal)',
          });
        }
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return true;
  }

  if (req.method === 'POST' && url === '/painel/marcar') {
    readJsonBody(req)
      .then(({ id, enviada }) => {
        marcarComoEnviada(id, Boolean(enviada));
        sendJson(res, 200, { ok: true });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return true;
  }

  if (req.method === 'POST' && url === '/painel/apagar') {
    readJsonBody(req)
      .then(({ id }) => {
        apagarPromocao(id);
        sendJson(res, 200, { ok: true });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
    return true;
  }

  return false;
}
