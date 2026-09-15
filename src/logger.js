import { appendFile } from 'node:fs/promises';
import { existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const LOG_FILE = join(process.cwd(), 'bot.log');
const TAMANHO_MAX_BYTES = 10 * 1024 * 1024; // 10MB

// Gira o log se ele cresceu demais (o bot.log real chegou a passar de 30MB).
// Um arquivo gigante nao ajuda ninguem a ler - guarda o anterior como
// ".old" (por seguranca, caso precise consultar) e comeca um novo, mais leve.
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > TAMANHO_MAX_BYTES) {
    renameSync(LOG_FILE, `${LOG_FILE}.old`);
  }
} catch {
  // se nao conseguir girar, so continua gravando no arquivo atual
}

// Gravacao ASSINCRONA e em fila (nunca "appendFileSync"): gravar no disco de
// forma sincrona bloqueia a thread unica do Node enquanto escreve - com um
// log linha-a-linha isso significa travar TODO o processamento (leitura dos
// grupos, navegador, etc.) por um instante a cada mensagem de log. Usar
// "appendFile" assincrono, encadeado numa fila (pra nao embaralhar a ordem
// das linhas), grava sem travar o resto do bot.
let filaEscrita = Promise.resolve();
function gravarNoArquivo(line) {
  filaEscrita = filaEscrita.then(() => appendFile(LOG_FILE, line + '\n')).catch(() => {
    // se nao conseguir gravar o arquivo de log, so segue com o console
  });
}

function write(level, msg) {
  const line = `[${new Date().toLocaleString('pt-BR')}] [${level}] ${msg}`;
  console.log(line);
  gravarNoArquivo(line);
}

export const logger = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('AVISO', msg),
  error: (msg) => write('ERRO', msg),
};

// fetch() do Node so diz "fetch failed" na mensagem principal - o motivo
// real (sem internet, DNS, certificado, timeout...) fica em err.cause.
export function describeError(err) {
  if (err?.cause) {
    const causeMsg = err.cause.message || String(err.cause);
    return `${err.message} (causa: ${causeMsg})`;
  }
  return err?.message || String(err);
}
