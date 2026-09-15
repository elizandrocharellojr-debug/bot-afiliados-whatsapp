// Guarda as promocoes ja convertidas (com o SEU link de afiliado) pra
// alimentar o painel local - de onde voce copia e cola no WhatsApp Web.
//
// A imagem fica em arquivo (data/imagens/) e nao dentro do banco: assim o
// banco continua leve e o navegador consegue carregar a foto direto.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Configuravel via DADOS_DIR - em servidores na nuvem (Railway), isso aponta
// pra dentro do Volume persistente (senao os dados somem a cada deploy).
const PASTA_DADOS = process.env.DADOS_DIR || 'data';
const PASTA_IMAGENS = path.join(PASTA_DADOS, 'imagens');
mkdirSync(PASTA_IMAGENS, { recursive: true });

const db = new DatabaseSync(path.join(PASTA_DADOS, 'bot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS promocoes (
    id TEXT PRIMARY KEY,
    texto TEXT NOT NULL,
    imagem_arquivo TEXT,
    origem TEXT,
    criada_em TEXT NOT NULL,
    enviada INTEGER NOT NULL DEFAULT 0
  )
`);

// Coluna "aviso" adicionada depois - guarda o motivo quando o link NAO pode
// ser convertido pro afiliado (ex: site sem afiliado, meli.la que nao
// resolveu). Fica null quando a conversao deu certo. "ADD COLUMN" so roda se
// a coluna ainda nao existir (bancos ja criados antes dessa mudanca).
const colunas = db.prepare('PRAGMA table_info(promocoes)').all().map((c) => c.name);
if (!colunas.includes('aviso')) {
  db.exec('ALTER TABLE promocoes ADD COLUMN aviso TEXT');
}

const inserirStmt = db.prepare(
  'INSERT INTO promocoes (id, texto, imagem_arquivo, origem, criada_em, enviada, aviso) VALUES (?, ?, ?, ?, ?, 0, ?)'
);
const listarStmt = db.prepare(
  'SELECT id, texto, imagem_arquivo, origem, criada_em, enviada, aviso FROM promocoes ORDER BY criada_em DESC LIMIT ?'
);
const marcarStmt = db.prepare('UPDATE promocoes SET enviada = ? WHERE id = ?');
const apagarStmt = db.prepare('DELETE FROM promocoes WHERE id = ?');
const buscarStmt = db.prepare('SELECT imagem_arquivo FROM promocoes WHERE id = ?');
const textoStmt = db.prepare('SELECT texto FROM promocoes WHERE id = ?');
const existeStmt = db.prepare('SELECT 1 FROM promocoes WHERE id = ?');
const definirImagemStmt = db.prepare('UPDATE promocoes SET imagem_arquivo = ? WHERE id = ?');

export function salvarPromocao({ texto, imagemBuffer, origem, aviso }) {
  const id = randomUUID();
  let nomeArquivo = null;

  if (imagemBuffer) {
    nomeArquivo = `${id}.jpg`;
    writeFileSync(path.join(PASTA_IMAGENS, nomeArquivo), imagemBuffer);
  }

  inserirStmt.run(id, texto, nomeArquivo, origem || '', new Date().toISOString(), aviso || null);
  return id;
}

export function listarPromocoes(limite = 60) {
  return listarStmt.all(limite).map((r) => ({
    id: r.id,
    texto: r.texto,
    temImagem: Boolean(r.imagem_arquivo),
    origem: r.origem,
    criadaEm: r.criada_em,
    enviada: Boolean(r.enviada),
    aviso: r.aviso || null,
  }));
}

export function marcarComoEnviada(id, enviada = true) {
  marcarStmt.run(enviada ? 1 : 0, id);
}

export function apagarPromocao(id) {
  apagarStmt.run(id);
}

export function textoDaPromocao(id) {
  return textoStmt.get(id)?.texto || null;
}

// Caminho da imagem no disco, ou null se a promocao nao tiver foto (ou o
// arquivo tiver sido apagado na mao).
export function caminhoDaImagem(id) {
  const row = buscarStmt.get(id);
  if (!row?.imagem_arquivo) return null;
  const caminho = path.join(PASTA_IMAGENS, row.imagem_arquivo);
  return existsSync(caminho) ? caminho : null;
}

export function promocaoExiste(id) {
  return Boolean(existeStmt.get(id));
}

// Anexa (ou troca) a foto de uma promocao ja salva - usado quando voce
// mesmo sobe uma foto pelo painel pra uma promocao que chegou sem imagem.
// Devolve o nome do arquivo salvo, ou null se o id nao existe.
export function definirImagem(id, buffer, extensao = 'jpg') {
  if (!promocaoExiste(id)) return null;
  const nomeArquivo = `${id}.${extensao}`;
  writeFileSync(path.join(PASTA_IMAGENS, nomeArquivo), buffer);
  definirImagemStmt.run(nomeArquivo, id);
  return nomeArquivo;
}
