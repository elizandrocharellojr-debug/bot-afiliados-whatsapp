// Lista os grupos de WhatsApp que essa conta participa e deixa voce
// escolher quais ADICIONAR na lista de "grupos de origem" (PY_GRUPOS_ORIGEM)
// - os grupos que o bot fica escutando pra copiar promocao. Nao mexe em
// WHATSAPP_GROUP_JIDS (grupo de DESTINO) nem em nenhuma outra config.
//
// Reaproveita a sessao ja salva em "auth/" - nao pede QR code de novo se ela
// ja for valida.
//
// IMPORTANTE: pare o bot (Ctrl+C na janela do "npm start") antes de rodar
// isso - duas conexoes com a mesma sessao ao mesmo tempo derrubam uma a
// outra.
import { connectWhatsApp } from '../src/whatsapp/connection.js';
import { listGroups } from '../src/whatsapp/groupResolver.js';
import { logger } from '../src/logger.js';
import { setEnvValues } from '../src/envFile.js';
import { createPrompt } from '../src/prompt.js';
import { config } from '../src/config.js';

async function main() {
  logger.info('Conectando ao WhatsApp (reaproveitando a sessao salva)...');
  const sock = await connectWhatsApp();

  logger.info('Conectado! Buscando os grupos que voce participa...');
  const groups = await listGroups(sock);

  if (groups.length === 0) {
    logger.error('Nenhum grupo encontrado nessa conta do WhatsApp.');
    sock.end();
    process.exitCode = 1;
    return;
  }

  const jaMonitorados = new Set(
    config.groupReader.sourceGroupNames.map((n) => n.trim().toLowerCase())
  );

  console.log('\nGrupos de origem que voce JA monitora hoje:');
  if (config.groupReader.sourceGroupNames.length === 0) {
    console.log('  (nenhum ainda)');
  } else {
    config.groupReader.sourceGroupNames.forEach((n) => console.log(`  - ${n}`));
  }

  console.log('\nTodos os grupos dessa conta (✓ = ja monitorado):\n');
  groups.forEach((g, i) => {
    const marca = jaMonitorados.has((g.name || '').trim().toLowerCase()) ? '✓ ' : '  ';
    console.log(`${marca}${i + 1}. ${g.name}`);
  });

  const { ask, close } = createPrompt();
  const answer = await ask(
    '\nDigite o(s) numero(s) do(s) grupo(s) NOVO(s) pra ADICIONAR como origem, ' +
      'separados por virgula (ex: 2,4) - ou so ENTER pra nao adicionar nenhum: '
  );
  close();

  const indexes = answer
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10) - 1)
    .filter((i) => Number.isInteger(i));

  const escolhidos = indexes.map((i) => groups[i]).filter(Boolean);

  if (escolhidos.length === 0) {
    logger.info('Nenhum grupo novo escolhido - nada foi alterado.');
    sock.end();
    process.exitCode = 0;
    return;
  }

  const novosNomes = escolhidos
    .map((g) => g.name)
    .filter((nome) => !jaMonitorados.has(nome.trim().toLowerCase()));

  if (novosNomes.length === 0) {
    logger.info('Todos os grupos escolhidos ja estavam na lista - nada foi alterado.');
    sock.end();
    process.exitCode = 0;
    return;
  }

  const listaFinal = [...config.groupReader.sourceGroupNames, ...novosNomes];
  setEnvValues({ PY_GRUPOS_ORIGEM: `"${listaFinal.join(',')}"` });

  logger.info(`Adicionado(s) aos grupos de origem: ${novosNomes.join(', ')}`);
  logger.info(`Lista completa agora (${listaFinal.length} grupos): ${listaFinal.join(', ')}`);
  logger.info('Pronto - reinicie o bot ("npm start") pra valer.');

  // Fecha sem deslogar (a sessao salva em "auth/" continua valida). Sem
  // process.exit() logo apos atividade de rede - evita um crash nativo do
  // Node no Windows (bug conhecido do libuv/undici).
  sock.end();
  process.exitCode = 0;
}

main().catch((err) => {
  logger.error(`Erro ao listar/adicionar grupos: ${err.message}`);
  process.exitCode = 1;
});
