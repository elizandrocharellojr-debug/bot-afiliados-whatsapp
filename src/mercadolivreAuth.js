import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { setEnvValues } from './envFile.js';

const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';

export function generatePkcePair() {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizationUrl({ clientId, redirectUri, codeChallenge }) {
  const url = new URL('https://auth.mercadolivre.com.br/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code, codeVerifier }) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.message || json.error || `resposta ${response.status}`);
  }
  return json;
}

// O access_token do Mercado Livre dura poucas horas. O refresh_token e de
// uso unico: toda vez que ele e usado, o Mercado Livre devolve um refresh_token
// NOVO, e o antigo para de funcionar. Por isso, salvamos o novo refresh_token
// no .env a cada renovacao.
let cachedAccessToken = null;
let cachedExpiresAt = 0;

export async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const { clientId, clientSecret, refreshToken } = config.mercadolivre;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.message || json.error || `resposta ${response.status}`);
  }

  cachedAccessToken = json.access_token;
  cachedExpiresAt = Date.now() + (json.expires_in || 21600) * 1000;

  if (json.refresh_token) {
    config.mercadolivre.refreshToken = json.refresh_token;
    setEnvValues({ ML_REFRESH_TOKEN: json.refresh_token });
    logger.info('Mercado Livre: token renovado.');
  }

  return cachedAccessToken;
}
