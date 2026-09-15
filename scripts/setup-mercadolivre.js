import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { setEnvValues } from '../src/envFile.js';
import { createPrompt } from '../src/prompt.js';
import {
  generatePkcePair,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
} from '../src/mercadolivreAuth.js';

function extractCode(pasted) {
  const trimmed = pasted.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (code) return code;
  } catch {
    // nao era uma URL, talvez o usuario tenha colado so o codigo mesmo
  }
  return trimmed;
}

async function main() {
  const { clientId, clientSecret, redirectUri } = config.mercadolivre;

  if (!clientId || !clientSecret || !redirectUri) {
    console.log(`
Antes de rodar este script, preencha no .env:

  ML_CLIENT_ID       -> "App ID" do seu aplicativo
  ML_CLIENT_SECRET   -> "Secret Key" do seu aplicativo
  ML_REDIRECT_URI    -> a mesma "URL de redirect" que voce cadastrou no app

Para criar o aplicativo (gratis, sem precisar de vendas):
  1. Entre em https://developers.mercadolivre.com.br/apps/new (logado com sua conta do Mercado Livre)
  2. De um nome qualquer pro app
  3. Em "URL de redirect", coloque uma pagina qualquer sua (ex: um link fixo que voce controla)
  4. Salve e copie o "App ID" e a "Secret Key" para o .env
`);
    logger.error('Configuracao incompleta. Preencha o .env e rode de novo.');
    process.exitCode = 1;
    return;
  }

  const { codeVerifier, codeChallenge } = generatePkcePair();
  const authUrl = buildAuthorizationUrl({ clientId, redirectUri, codeChallenge });

  console.log(`
1. Abra este link no navegador e faca login/autorize o app:

${authUrl}

2. Depois de autorizar, o Mercado Livre vai te redirecionar para a sua
   URL de redirect com "?code=..." no final do endereco.
3. Copie o endereco COMPLETO da barra do navegador (ou so o valor depois de "code=") e cole aqui.
`);

  const { ask, close } = createPrompt();
  const pasted = await ask('Cole aqui: ');
  close();

  const code = extractCode(pasted);

  try {
    const tokens = await exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code, codeVerifier });
    setEnvValues({ ML_REFRESH_TOKEN: tokens.refresh_token });
    logger.info('Mercado Livre autorizado com sucesso! Token salvo no .env.');
    process.exitCode = 0;
  } catch (err) {
    logger.error(`Falha ao trocar o codigo por um token: ${err.message}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error(`Erro na configuracao do Mercado Livre: ${err.message}`);
  process.exitCode = 1;
});
