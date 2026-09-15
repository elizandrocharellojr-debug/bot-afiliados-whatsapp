import { config } from './config.js';
import { logger } from './logger.js';
import { connectWhatsApp } from './whatsapp/connection.js';
import { sendDealToGroups } from './whatsapp/sender.js';

// Usado pelas ferramentas manuais (link-mercadolivre, link-amazon): mostra a
// mensagem pronta e, se confirmado, envia direto pro(s) grupo(s) usando a
// sessao do WhatsApp ja conectada - sem precisar copiar/colar na mao.
export async function confirmAndSend(ask, message, imageUrl) {
  console.log('\n--- Mensagem pronta ---\n');
  console.log(message);
  if (imageUrl) console.log(`\n(com imagem: ${imageUrl})`);
  console.log('\n-----------------------\n');

  if (config.whatsapp.groupJids.length === 0) {
    logger.warn('Nenhum grupo do WhatsApp configurado - copie a mensagem acima manualmente.');
    return;
  }

  const answer = await ask('Enviar pro(s) grupo(s) agora? (s/n): ');
  if (!/^s/i.test(answer.trim())) {
    logger.info('Nao enviado. Copie a mensagem acima manualmente se quiser postar.');
    return;
  }

  logger.info('Conectando ao WhatsApp...');
  const sock = await connectWhatsApp();
  const ok = await sendDealToGroups(config.whatsapp.groupJids, { text: message, imageUrl });
  sock.end();

  if (ok) {
    logger.info('Enviado com sucesso!');
  } else {
    logger.error('Falha ao enviar - copie a mensagem acima manualmente.');
  }
}
