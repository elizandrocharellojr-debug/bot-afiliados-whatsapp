// Confere se o bot do Telegram esta configurado certo e manda uma mensagem
// de teste pro canal. Nao depende do WhatsApp em nada.
//
// Uso: npm run testar-telegram
import { config } from '../src/config.js';
import { verificarTelegram, enviarPromocaoTelegram } from '../src/telegram.js';

async function main() {
  const faltando = [];
  if (!config.telegram.botToken) faltando.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegram.chatId) faltando.push('TELEGRAM_CANAL');

  if (faltando.length > 0) {
    console.log(`\nFalta preencher no .env: ${faltando.join(' e ')}\n`);
    console.log('Como pegar o token:');
    console.log('  1. No Telegram, procure por @BotFather e mande /newbot');
    console.log('  2. Escolha um nome e um @usuario pro bot');
    console.log('  3. Copie o token que ele responder e cole em TELEGRAM_BOT_TOKEN no .env');
    console.log('  4. No seu canal: Administradores > Adicionar > escolha o bot');
    console.log('     (deixe "Publicar mensagens" ligado)\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\nCanal configurado: ${config.telegram.chatId}`);

  let info;
  try {
    info = await verificarTelegram();
    console.log(`  1) bot OK: @${info.nomeBot}`);
    console.log(`  2) canal OK: ${info.nomeCanal}`);
  } catch (err) {
    console.log(`\n  X  ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await enviarPromocaoTelegram(
      'Teste do bot de afiliados 🥷\n\n' +
        'Se voce esta lendo isso no canal, esta tudo certo: o bot consegue postar aqui sozinho.'
    );
    console.log('  3) mensagem de teste ENVIADA - confira o canal.\n');
    console.log('Tudo pronto. Quando o leitor de grupos rodar, as promocoes caem aqui.\n');
  } catch (err) {
    console.log(`\n  X  consegui ver o canal mas nao consegui postar: ${err.message}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nErro inesperado: ${err.message}\n`);
  process.exitCode = 1;
});
