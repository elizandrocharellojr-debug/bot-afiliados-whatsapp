import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { createPrompt } from '../src/prompt.js';
import { extractAffiliateParams, buildAffiliateLink } from '../src/mercadolivreLink.js';
import { confirmAndSend } from '../src/manualSend.js';

async function main() {
  const sampleLink = config.mercadolivre.sampleAffiliateLink;
  if (!sampleLink) {
    console.log(
      'Preencha ML_SAMPLE_AFFILIATE_LINK no .env primeiro (o link de afiliado que voce gerou no portal do Mercado Livre).'
    );
    process.exitCode = 1;
    return;
  }

  const affiliateParams = extractAffiliateParams(sampleLink);
  if (!affiliateParams) {
    process.exitCode = 1;
    return;
  }

  const { ask, close } = createPrompt();

  const productUrl = await ask('Cole o link do produto no Mercado Livre: ');
  const title = await ask('Titulo do produto: ');
  const originalPrice = await ask('Preco original "De:" (opcional, deixe em branco se nao tiver desconto): ');
  const price = await ask('Preco atual "Por:" (ex: 99,90): ');
  const imageUrl = await ask(
    'Cole o link da imagem do produto (opcional - clique direito na foto no site > Copiar endereco da imagem): '
  );
  const coupon = await ask('Cupom disponivel (opcional, deixe em branco se nao tiver): ');

  let affiliateLink;
  try {
    affiliateLink = buildAffiliateLink(productUrl.trim(), affiliateParams);
  } catch {
    logger.error('Link invalido.');
    close();
    process.exitCode = 1;
    return;
  }

  const priceLine = originalPrice.trim()
    ? `De: R$ ${originalPrice.trim()} | Por: R$ ${price.trim()} 🥷`
    : `R$ ${price.trim()} 🥷`;
  const couponLine = coupon.trim() ? `⚠️ cupom: ${coupon.trim()}\n` : '';
  const message =
    `${title.trim()}\n\n` +
    `${priceLine}\n` +
    `${couponLine}\n` +
    `Link: ${affiliateLink}`;

  await confirmAndSend(ask, message, imageUrl.trim() || undefined);
  close();
}

main().catch((err) => {
  logger.error(`Erro: ${err.message}`);
  process.exitCode = 1;
});
