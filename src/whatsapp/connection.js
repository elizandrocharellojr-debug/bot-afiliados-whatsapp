import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { logger } from '../logger.js';

// Configuravel via WHATSAPP_AUTH_DIR - em servidores na nuvem (Railway),
// isso aponta pro Volume persistente (senao a sessao do WhatsApp se perde a
// cada deploy e pediria QR code de novo toda vez).
const AUTH_FOLDER = process.env.WHATSAPP_AUTH_DIR || 'auth';

// O Baileys usa esse logger internamente pra registrar tudo, incluindo
// chaves de sessao - "silent" evita expor isso no terminal e corta o ruido.
const quietLogger = pino({ level: 'silent' });

let currentSocket = null;
let readyWaiters = [];
let connectListeners = [];

function notifyReady(sock) {
  currentSocket = sock;
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const resolve of waiters) resolve(sock);
  for (const cb of connectListeners) {
    try {
      cb(sock);
    } catch (err) {
      logger.error(`Erro num listener de conexao: ${err.message}`);
    }
  }
}

// Sempre pegue o socket "ao vivo" por aqui em vez de guardar uma referencia -
// depois de uma reconexao, um novo socket e criado e o antigo fica morto.
export function getSocket() {
  return currentSocket;
}

export function waitForConnection() {
  if (currentSocket) return Promise.resolve(currentSocket);
  return new Promise((resolve) => readyWaiters.push(resolve));
}

// Diferente de waitForConnection (resolve UMA vez): isso chama o callback a
// cada conexao nova, inclusive apos reconexoes - necessario pra quem precisa
// re-registrar listeners de evento (ex: sock.ev.on('messages.upsert', ...))
// num socket novo, ja que o antigo morre e o novo e um objeto diferente.
export function onConnect(callback) {
  if (currentSocket) callback(currentSocket);
  connectListeners.push(callback);
}

async function startSession({ onQr }) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Bot Afiliados', 'Chrome', '1.0'],
    logger: quietLogger,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && onQr) onQr(qr);

    if (connection === 'open') {
      logger.info('WhatsApp conectado.');
      notifyReady(sock);
    }

    if (connection === 'close') {
      currentSocket = null;

      // sock.end() sem erro (fechamento intencional, ex: depois de mandar
      // uma mensagem manual) nao deve tentar reconectar - so uma queda de
      // verdade (que sempre vem com um erro) deve.
      if (!lastDisconnect?.error) {
        logger.info('WhatsApp desconectado.');
        return;
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.error(
          'WhatsApp desconectado (sessao encerrada). Apague a pasta "auth" e rode ' +
            '"npm run setup-whatsapp" de novo para reconectar.'
        );
        return;
      }

      // 405 "Connection Failure": bloqueio TEMPORARIO do WhatsApp, quase
      // sempre por tentar conectar muitas vezes seguidas. Insistir so renova
      // o bloqueio - entao paramos e pedimos pra esperar.
      if (statusCode === 405) {
        logger.error(
          'WhatsApp recusou a conexao (codigo 405 - bloqueio temporario por excesso de tentativas). ' +
            'PARE tudo e espere pelo menos 30-60 minutos SEM tentar. Depois rode "npm run setup-whatsapp" ' +
            'UMA vez so. Ficar tentando de novo so aumenta o tempo do bloqueio.'
        );
        return;
      }

      // Mostra o motivo real da queda (codigo + mensagem) - ajuda a saber se
      // e' bloqueio temporario do WhatsApp (ex: 405/428/440), problema de
      // rede, ou versao recusada.
      logger.warn(
        `WhatsApp desconectado (codigo ${statusCode ?? '?'}: ${lastDisconnect?.error?.message || 'sem detalhe'}) - ` +
          'tentando reconectar em 15s...'
      );
      // Espera antes de reconectar: o loop rapido de reconexao pode piorar um
      // bloqueio temporario e impede o QR de aparecer.
      setTimeout(() => {
        startSession({ onQr }).catch((err) =>
          logger.error(`Falha ao tentar reconectar: ${err.message}`)
        );
      }, 15000);
    }
  });
}

export async function connectWhatsApp({ onQr } = {}) {
  await startSession({ onQr });
  return waitForConnection();
}
