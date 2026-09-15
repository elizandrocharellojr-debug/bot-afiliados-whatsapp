// Na 1a vez que o bot sobe num servidor NOVO (ex: Railway), a pasta
// persistente (o "Volume") esta vazia - sem a sessao do WhatsApp nem o login
// do navegador do Mercado Livre, o bot pediria pra fazer tudo de novo la.
//
// Se o projeto tiver uma pasta "seed/" (com copias de auth/, data/ e/ou
// ml-browser-perfil/ tiradas do seu PC, onde ja esta tudo logado), essa
// funcao copia isso pro lugar certo automaticamente - SO na 1a vez (nao
// sobrescreve nada se o destino ja tiver dado, entao rodar isso de novo em
// deploys seguintes nao faz nada). Assim voce pode apagar a "seed" do
// projeto depois do 1o deploy funcionar, sem perder nada.
//
// No seu PC (sem pasta "seed/") isso nao faz nada - e' seguro, nao muda o
// funcionamento de hoje.
import { existsSync, mkdirSync, readdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const SEED_DIR = process.env.SEED_DIR || 'seed';

function pastaVaziaOuInexistente(pasta) {
  if (!existsSync(pasta)) return true;
  try {
    return readdirSync(pasta).length === 0;
  } catch {
    return true;
  }
}

function semear(nomePasta, destino) {
  if (!destino) return;
  const origem = path.join(SEED_DIR, nomePasta);
  if (!existsSync(origem)) return;
  if (!pastaVaziaOuInexistente(destino)) return; // ja tem dado - nao mexe

  try {
    mkdirSync(path.dirname(destino), { recursive: true });
    cpSync(origem, destino, { recursive: true });
    logger.info(`Preparando servidor novo: copiei "${nomePasta}" da pasta seed pra ${destino}.`);
  } catch (err) {
    logger.warn(`Nao consegui copiar a seed "${nomePasta}" pra ${destino}: ${err.message}`);
  }
}

export function semearArmazenamentoPersistente() {
  if (!existsSync(SEED_DIR)) return; // rodando no seu PC normal - nada a fazer

  semear('auth', process.env.WHATSAPP_AUTH_DIR || 'auth');
  semear('ml-browser-perfil', process.env.ML_PERFIL_DIR);
  semear('data', process.env.DADOS_DIR);
}
