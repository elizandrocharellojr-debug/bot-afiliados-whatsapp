import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const DB_PATH = 'data/bot.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS posted_deals (
    source TEXT NOT NULL,
    product_id TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    PRIMARY KEY (source, product_id)
  )
`);

// Usado pelo leitor de grupos de origem (groupReader.js) - cada mensagem do
// WhatsApp tem um ID unico e estavel (message_id), bem mais confiavel do que
// comparar texto pra saber se ja foi vista.
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_group_messages (
    remote_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (remote_jid, message_id)
  )
`);

const selectMsgStmt = db.prepare(
  'SELECT 1 FROM processed_group_messages WHERE remote_jid = ? AND message_id = ?'
);
const insertMsgStmt = db.prepare(
  'INSERT OR REPLACE INTO processed_group_messages (remote_jid, message_id, processed_at) VALUES (?, ?, ?)'
);

export function wasMessageProcessed(remoteJid, messageId) {
  return Boolean(selectMsgStmt.get(remoteJid, messageId));
}

export function markMessageProcessed(remoteJid, messageId) {
  insertMsgStmt.run(remoteJid, messageId, new Date().toISOString());
}

const selectStmt = db.prepare(
  'SELECT posted_at FROM posted_deals WHERE source = ? AND product_id = ?'
);
const insertStmt = db.prepare(
  'INSERT OR REPLACE INTO posted_deals (source, product_id, posted_at) VALUES (?, ?, ?)'
);

export function wasRecentlyPosted(source, productId) {
  const row = selectStmt.get(source, productId);
  if (!row) return false;

  const postedAt = new Date(row.posted_at);
  const windowMs = config.behavior.dedupeWindowDays * 24 * 60 * 60 * 1000;
  return Date.now() - postedAt.getTime() < windowMs;
}

export function markAsPosted(source, productId) {
  insertStmt.run(source, productId, new Date().toISOString());
}
