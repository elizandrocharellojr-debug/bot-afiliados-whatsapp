import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from './logger.js';

export function ensureEnvFile() {
  if (!existsSync('.env')) {
    copyFileSync('.env.example', '.env');
    logger.info('Criei o arquivo .env a partir do .env.example.');
  }
}

// Atualiza (ou adiciona) uma ou mais chaves no arquivo .env, preservando o
// resto do conteudo e os comentarios.
export function setEnvValues(values) {
  ensureEnvFile();
  let content = readFileSync('.env', 'utf8');

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content) ? content.replace(pattern, line) : content.trimEnd() + `\n${line}\n`;
  }

  writeFileSync('.env', content);
}
