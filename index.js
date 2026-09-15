import dns from 'node:dns';
import qrcodeTerminal from 'qrcode-terminal';
import { config, validateConfig } from './src/config.js';
import { logger } from './src/logger.js';
import { connectWhatsApp } from './src/whatsapp/connection.js';
import { runPollCycle, startScheduler } from './src/scheduler.js';
import { startLocalServer, pararTunel } from './src/localServer.js';
import { startGroupReader } from './src/groupReader.js';
import { fecharNavegadorML } from './src/mercadolivreBrowser.js';
import { semearArmazenamentoPersistente } from './src/bootstrapStorage.js';

// Corrige o "fetch failed" que aparecia toda hora no log (Telegram, busca de
// foto, redirecionamento de link curto - qualquer fetch()) mesmo com a
// internet funcionando normal: em alguns provedores/roteadores (comum no
// Brasil) o Windows anuncia suporte a IPv6, mas a rota de verdade nao
// funciona - o Node tenta IPv6 primeiro por padrao, falha na hora, e so
// funciona na tentativa seguinte (por isso os varios "tentativa 1/2/3...
// falhou" no log, gastando ate 30s so em espera por promocao). Preferir
// IPv4 evita cair nessa rota quebrada.
dns.setDefaultResultOrder('ipv4first');

// Fecha o navegador do Mercado Livre (se estiver aberto) ao encerrar o
// script com Ctrl+C - evita deixar um chrome.exe zumbi rodando sozinho.
process.on('SIGINT', async () => {
  pararTunel();
  await fecharNavegadorML().catch(() => {});
  process.exit(0);
});

async function main() {
  // So faz algo se existir uma pasta "seed/" no projeto (servidor novo,
  // ex: Railway) - no seu PC normal isso nao muda nada. Ver bootstrapStorage.js.
  semearArmazenamentoPersistente();

  validateConfig();

  if (config.dryRun) {
    logger.info('Modo TESTE ativo: nada sera enviado de verdade pro WhatsApp.');
  } else {
    // Se a sessao salva em "auth/" nao for mais valida (ex: desconectada no
    // celular), o Baileys pede um QR code novo aqui - sem isso, o QR seria
    // gerado mas nunca mostrado, e o programa ficaria parado sem nenhum
    // aviso (foi o que aconteceu antes de adicionar esse "onQr").
    await connectWhatsApp({
      onQr: (qr) => {
        logger.warn('Sessao do WhatsApp expirada/invalida - escaneie o QR code abaixo com o celular:');
        qrcodeTerminal.generate(qr, { small: true });
      },
    });
    // Liga o servidor da extensao logo apos conectar, antes do primeiro
    // ciclo de busca (que pode levar um tempo) - assim a extensao ja
    // funciona imediatamente, sem depender do agendador.
    startLocalServer();
    // Le os grupos de origem em tempo real (substitui o script Python
    // separado) - baseado em evento, nao precisa esperar ciclo nenhum.
    startGroupReader();
  }

  if (!config.behavior.buscaAutomaticaAtiva) {
    logger.info(
      'Busca automatica de ofertas desativada (so copiando promocao dos grupos de origem). ' +
        'Ponha BUSCAR_OFERTAS_AUTOMATICO=sim no .env pra religar.'
    );
    return;
  }

  // roda um ciclo assim que liga, sem esperar o primeiro intervalo
  await runPollCycle();

  if (config.dryRun) {
    logger.info('Teste concluido. Rode "npm start" (sem --dry-run) para ligar de verdade.');
    // Evita "process.exit()" logo apos chamadas de rede: no Windows isso
    // pode disparar um crash nativo do Node (bug conhecido do libuv/undici).
    // Deixando o processo terminar sozinho evita o problema.
    process.exitCode = 0;
    return;
  }

  startScheduler();
}

main().catch((err) => {
  logger.error(`Erro fatal: ${err.message}`);
  process.exitCode = 1;
});
