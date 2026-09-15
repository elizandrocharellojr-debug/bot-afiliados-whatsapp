// Preparacao automatica pra rodar em QUALQUER maquina/pasta.
//
// Confere e resolve, na ordem: versao do Node, dependencias (npm install),
// navegador do Playwright (usado pro link "meli.la"), arquivo .env e sessao
// do WhatsApp. Nao tem caminho fixo em lugar nenhum - tudo e' relativo a
// pasta do projeto, entao funciona em outro PC, outro usuario, outro disco.
//
// Uso: npm run preparar     (ou pelo INICIAR.bat, que chama isso sozinho)
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ehWindows = process.platform === 'win32';

function titulo(t) {
  console.log(`\n=== ${t} ===`);
}
function ok(m) {
  console.log(`  [ok] ${m}`);
}
function aviso(m) {
  console.log(`  [!] ${m}`);
}
function erro(m) {
  console.log(`  [X] ${m}`);
}

// Roda um comando mostrando a saida na tela. Devolve true se deu certo.
function rodar(cmd, args) {
  const r = spawnSync(ehWindows ? `${cmd}.cmd` : cmd, args, {
    cwd: RAIZ,
    stdio: 'inherit',
    shell: ehWindows,
  });
  return r.status === 0;
}

function versaoNodeOk() {
  const [maior, menor] = process.versions.node.split('.').map(Number);
  return maior > 22 || (maior === 22 && menor >= 5);
}

// O bot usa o Microsoft Edge ja instalado no Windows (channel "msedge") em
// vez do Chromium proprio do Playwright - evita precisar baixar ~200MB toda
// vez que muda de maquina. So confere se o Edge existe nos caminhos padrao.
function navegadorPlaywrightInstalado() {
  if (!ehWindows) return true; // fora do Windows, deixa o proprio Playwright avisar na hora de usar.
  const caminhosEdge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return caminhosEdge.some((c) => existsSync(c));
}

async function main() {
  console.log('\n############################################');
  console.log('#  Preparando o bot nesta maquina          #');
  console.log('############################################');
  console.log(`\nPasta do projeto: ${RAIZ}`);

  let pendencias = [];

  // 1) Node
  titulo('1. Versao do Node');
  if (versaoNodeOk()) {
    ok(`Node ${process.versions.node}`);
  } else {
    erro(
      `Node ${process.versions.node} e antigo demais. Precisa 22.5.0 ou maior ` +
        '(instale o LTS em https://nodejs.org e rode de novo).'
    );
    console.log('\nParando aqui: sem o Node certo, nada mais funciona.\n');
    process.exitCode = 1;
    return;
  }

  // 2) Dependencias
  titulo('2. Dependencias (node_modules)');
  const marcaDeps = path.join(RAIZ, 'node_modules', '@whiskeysockets', 'baileys', 'package.json');
  if (existsSync(marcaDeps)) {
    ok('dependencias ja instaladas');
  } else {
    aviso('faltando ou incompletas - rodando "npm install" (pode levar 1-2 min)...');
    if (rodar('npm', ['install'])) {
      ok('dependencias instaladas');
    } else {
      erro('"npm install" falhou. Confira sua internet e rode de novo.');
      pendencias.push('npm install');
    }
  }

  // 3) Navegador do Mercado Livre (usa o Edge do Windows, sem download)
  titulo('3. Navegador do Mercado Livre (Microsoft Edge)');
  if (navegadorPlaywrightInstalado()) {
    ok('Microsoft Edge encontrado nesta maquina - nada pra baixar');
  } else {
    aviso(
      'nao encontrei o Microsoft Edge nos caminhos padrao. Instale o Edge ' +
        '(https://www.microsoft.com/edge) ou, se preferir usar o Google Chrome, ' +
        'troque "channel: \'msedge\'" por "channel: \'chrome\'" em ' +
        'src/mercadolivreBrowser.js.'
    );
    pendencias.push('instalar o Microsoft Edge (ou ajustar o channel pro Chrome)');
  }

  // 4) .env
  titulo('4. Configuracao (.env)');
  const env = path.join(RAIZ, '.env');
  const exemplo = path.join(RAIZ, '.env.example');
  if (existsSync(env)) {
    const texto = readFileSync(env, 'utf8');
    const temChave = (nome) => new RegExp(`^${nome}=.+`, 'm').test(texto);
    ok('.env encontrado');
    const faltando = [];
    if (!temChave('TELEGRAM_BOT_TOKEN')) faltando.push('TELEGRAM_BOT_TOKEN');
    if (!temChave('PY_GRUPOS_ORIGEM')) faltando.push('PY_GRUPOS_ORIGEM (grupos de origem)');
    if (!temChave('PAINEL_TOKEN')) faltando.push('PAINEL_TOKEN (senha do painel)');
    if (faltando.length > 0) aviso(`vazio(s) no .env: ${faltando.join(', ')}`);
    else ok('as configuracoes principais estao preenchidas');
  } else if (existsSync(exemplo)) {
    copyFileSync(exemplo, env);
    aviso('.env nao existia - criei um a partir do .env.example, mas ele esta VAZIO.');
    aviso('Copie o .env da outra maquina, senao o bot nao tem suas credenciais.');
    pendencias.push('preencher o .env');
  } else {
    erro('nao achei .env nem .env.example. Copie o .env da outra maquina pra esta pasta.');
    pendencias.push('copiar o .env');
  }

  // 5) Sessao do WhatsApp
  titulo('5. Sessao do WhatsApp');
  const auth = path.join(RAIZ, 'auth');
  if (existsSync(auth)) {
    ok('sessao encontrada (pasta "auth")');
    aviso('NAO rode o bot em duas maquinas ao mesmo tempo com a mesma sessao -');
    aviso('elas se derrubam e isso aumenta o risco de suspensao do numero.');
  } else {
    aviso('sem sessao salva - na primeira vez o bot vai pedir o QR code.');
    aviso('Rode: npm run setup-whatsapp   (escaneie o QR e escolha o grupo de destino)');
    pendencias.push('npm run setup-whatsapp');
  }

  // Resumo
  console.log('\n############################################');
  if (pendencias.length === 0) {
    console.log('#  Tudo pronto! Rode: npm start            #');
    console.log('############################################\n');
  } else {
    console.log('#  Falta resolver:                         #');
    console.log('############################################');
    for (const p of pendencias) console.log(`  - ${p}`);
    console.log('');
  }
}

main().catch((err) => {
  erro(`erro inesperado: ${err.message}`);
  process.exitCode = 1;
});
