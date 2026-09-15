import { waitForConnection } from './connection.js';
import { logger } from '../logger.js';

export async function sendDealMessage(groupJid, { text, imageUrl }) {
  const sock = await waitForConnection();

  const payload = imageUrl
    ? { image: { url: imageUrl }, caption: text }
    : { text };

  try {
    await sock.sendMessage(groupJid, payload);
    return true;
  } catch (err) {
    logger.error(`Falha ao enviar mensagem pro WhatsApp: ${err.message}`);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Manda a mesma oferta pra todos os grupos configurados, com uma pequena
// pausa entre cada envio. Retorna true se pelo menos um grupo recebeu.
export async function sendDealToGroups(groupJids, { text, imageUrl }) {
  let anyOk = false;
  for (const groupJid of groupJids) {
    const ok = await sendDealMessage(groupJid, { text, imageUrl });
    if (ok) anyOk = true;
    if (groupJids.length > 1) await sleep(2000);
  }
  return anyOk;
}
