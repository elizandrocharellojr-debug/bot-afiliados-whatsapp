// Testa a geracao do link oficial "meli.la" SEM depender do WhatsApp.
//
// Uso:
//   npm run testar-ml -- https://meli.la/2Kr5zwc
//   npm run testar-ml -- <link1> <link2> <link3>
//
// Mostra, pra cada link: o permalink do produto que foi resolvido e o
// "meli.la" gerado (ou o motivo exato da falha). Serve pra validar a parte
// mais importante do bot com calma, sem risco nenhum de restricao.
import { resolverPermalinkProduto } from '../src/mercadolivreLink.js';
import {
  gerarLinkAfiliadoML,
  gerarLinkDePerfilSocial,
  fecharNavegadorML,
} from '../src/mercadolivreBrowser.js';

function ehLinkDoMercadoLivre(url) {
  try {
    const dominio = new URL(url).hostname.toLowerCase();
    return (
      dominio.includes('mercadolivre.') || dominio.includes('mercadolibre.') || dominio === 'meli.la'
    );
  } catch {
    return false;
  }
}

async function main() {
  const links = process.argv.slice(2).filter((a) => a.startsWith('http'));

  if (links.length === 0) {
    console.log('\nComo usar:\n');
    console.log('  npm run testar-ml -- https://meli.la/2Kr5zwc');
    console.log('  npm run testar-ml -- <link1> <link2>\n');
    console.log('Cole um ou mais links do Mercado Livre (meli.la, /p/MLB... ou MLB-...).\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\nTestando ${links.length} link(s). Uma janela do Chrome vai abrir.`);
  console.log('Se ela pedir login, entre na sua conta do Mercado Livre com calma - o teste espera.\n');

  let sucessos = 0;
  const falhas = [];

  for (const [i, link] of links.entries()) {
    console.log(`\n--- [${i + 1}/${links.length}] ${link}`);

    if (!ehLinkDoMercadoLivre(link)) {
      console.log('  X  nao e um link do Mercado Livre - pulando.');
      falhas.push({ link, motivo: 'nao e link do Mercado Livre' });
      continue;
    }

    let permalink;
    try {
      permalink = await resolverPermalinkProduto(link);
      console.log(`  1) produto encontrado: ${permalink}`);
    } catch (err) {
      // Link de revendedor (pagina "/social/..."): abre no navegador logado e
      // pega o produto em destaque - o mesmo caminho do bot de verdade.
      if (/perfil de outro afiliado/i.test(err.message)) {
        try {
          const { link: meliLa, permalink: prod } = await gerarLinkDePerfilSocial(link);
          console.log(`  1) link de revendedor - produto em destaque: ${prod}`);
          console.log(`  2) LINK PRONTO: ${meliLa}`);
          sucessos++;
        } catch (errPerfil) {
          console.log(`  X  link de revendedor, nao consegui o produto: ${errPerfil.message}`);
          falhas.push({ link, motivo: `revendedor - ${errPerfil.message}` });
        }
        continue;
      }
      console.log(`  X  nao consegui achar o produto: ${err.message}`);
      falhas.push({ link, motivo: `resolver produto - ${err.message}` });
      continue;
    }

    try {
      const meliLa = await gerarLinkAfiliadoML(permalink);
      console.log(`  2) LINK PRONTO: ${meliLa}`);
      sucessos++;
    } catch (err) {
      console.log(`  X  nao consegui gerar o meli.la: ${err.message}`);
      falhas.push({ link, motivo: `gerar meli.la - ${err.message}` });
    }
  }

  console.log('\n==============================');
  console.log(`Resultado: ${sucessos} de ${links.length} link(s) gerado(s) com sucesso.`);
  if (falhas.length > 0) {
    console.log('\nFalhas (mande isso pro Claude se quiser que eu corrija):');
    for (const f of falhas) console.log(`  - ${f.link}\n    motivo: ${f.motivo}`);
  }
  console.log('==============================\n');

  await fecharNavegadorML().catch(() => {});
}

main()
  .catch(async (err) => {
    console.error(`\nErro inesperado: ${err.message}\n`);
    await fecharNavegadorML().catch(() => {});
    process.exitCode = 1;
  })
  .then(() => {
    // Playwright deixa handles abertos; encerra explicitamente pra o comando
    // nao ficar pendurado no terminal depois de terminar o teste.
    setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
  });
