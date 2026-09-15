function normalizeJid(jid) {
  if (!jid) return null;
  const [user] = jid.split(':');
  const domain = jid.split('@')[1];
  return domain ? `${user.split('@')[0]}@${domain}` : user;
}

// Resolve nomes de grupo (como aparecem no WhatsApp) pros seus JIDs, pra
// poder escutar mensagens desses grupos "de origem". Nao precisa ser
// administrador desses grupos - so participante, pra receber as mensagens.
export async function resolveGroupJidsByName(sock, nomes) {
  const grupos = await listGroups(sock);
  const encontrados = [];
  const naoEncontrados = [];

  for (const nome of nomes) {
    const alvo = nome.trim().toLowerCase();
    const grupo = grupos.find((g) => (g.name || '').trim().toLowerCase() === alvo);
    if (grupo) {
      encontrados.push(grupo);
    } else {
      naoEncontrados.push(nome);
    }
  }

  return { encontrados, naoEncontrados };
}

export async function listGroups(sock) {
  const groups = await sock.groupFetchAllParticipating();

  // O WhatsApp identifica "voce" de formas diferentes dependendo do grupo
  // (numero de telefone ou "lid") - juntamos todas as formas conhecidas pra
  // nao errar quem e admin.
  const selfIds = new Set(
    [sock.user?.id, sock.user?.lid, sock.user?.phoneNumber]
      .map(normalizeJid)
      .filter(Boolean)
  );

  return Object.values(groups).map((g) => {
    const me = g.participants?.find((p) => selfIds.has(normalizeJid(p.id)));
    const isAdmin = me?.admin === 'admin' || me?.admin === 'superadmin';
    return { jid: g.id, name: g.subject, isAdmin };
  });
}
