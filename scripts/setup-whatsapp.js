import qrcodeTerminal from 'qrcode-terminal';
import { connectWhatsApp } from '../src/whatsapp/connection.js';
import { listGroups } from '../src/whatsapp/groupResolver.js';
import { logger } from '../src/logger.js';
import { setEnvValues } from '../src/envFile.js';
import { createPrompt } from '../src/prompt.js';

async function main() {
  logger.info('Conectando ao WhatsApp... escaneie o QR code abaixo com o app do celular.');

  const sock = await connectWhatsApp({
    onQr: (qr) => qrcodeTerminal.generate(qr, { small: true }),
  });

  logger.info('Conectado! Buscando os grupos que voce participa...');
  const groups = await listGroups(sock);

  if (groups.length === 0) {
    logger.error('Nenhum grupo encontrado nessa conta do WhatsApp.');
    process.exitCode = 1;
    sock.end();
    return;
  }

  console.log('\nEscolha o(s) grupo(s) onde o bot vai postar as ofertas:\n');
  console.log('(⚠️ = voce nao e administrador desse grupo - cuidado ao escolher)\n');
  groups.forEach((g, i) => console.log(`${i + 1}. ${g.isAdmin ? '' : '⚠️  '}${g.name}`));

  const { ask, close } = createPrompt();
  const answer = await ask('\nDigite o(s) numero(s) do(s) grupo(s), separados por virgula (ex: 1,3,5): ');

  const indexes = answer
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10) - 1);

  let chosen = indexes.map((i) => groups[i]).filter(Boolean);

  if (chosen.length === 0) {
    logger.error('Nenhum numero valido.');
    close();
    process.exitCode = 1;
    sock.end();
    return;
  }

  const naoAdmin = chosen.filter((g) => !g.isAdmin);
  if (naoAdmin.length > 0) {
    console.log(
      `\n⚠️  Voce NAO e administrador ${naoAdmin.length === 1 ? 'deste grupo' : 'destes grupos'}: ` +
        naoAdmin.map((g) => g.name).join(', ')
    );
    console.log(
      'Postar links de afiliado automaticamente em grupo de outra pessoa pode ser considerado spam ' +
        'e te tirar do grupo (ou pior, o dono pode reportar seu numero). So continue se tiver certeza ' +
        'que tem autorizacao do administrador pra isso.'
    );
    const confirm = await ask('Continuar mesmo assim com esses grupos? (s/n): ');
    if (!/^s/i.test(confirm.trim())) {
      chosen = chosen.filter((g) => g.isAdmin);
      logger.info(
        chosen.length > 0
          ? `Ok, removi os grupos onde voce nao e admin. Mantendo: ${chosen.map((g) => g.name).join(', ')}`
          : 'Ok, nenhum grupo restante (voce nao e admin de nenhum dos escolhidos).'
      );
    }
  }

  close();

  if (chosen.length === 0) {
    logger.error('Nenhum grupo valido pra salvar.');
    process.exitCode = 1;
    sock.end();
    return;
  }

  setEnvValues({ WHATSAPP_GROUP_JIDS: chosen.map((g) => g.jid).join(',') });
  logger.info(
    `Grupo(s) salvo(s) no .env: ${chosen.map((g) => g.name).join(', ')}. Pode rodar "npm start" agora.`
  );
  // Fecha a conexao sem deslogar (a sessao salva em "auth/" continua valida).
  // Evitamos "process.exit()" logo apos atividade de rede/socket porque isso
  // pode disparar um crash nativo do Node no Windows (bug conhecido do
  // libuv/undici) - deixamos o processo terminar sozinho.
  sock.end();
  process.exitCode = 0;
}

main().catch((err) => {
  logger.error(`Erro na configuracao do WhatsApp: ${err.message}`);
  process.exitCode = 1;
});
