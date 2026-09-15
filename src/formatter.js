const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function formatDealMessage(deal) {
  const price = currencyFormatter.format(deal.price);
  const originalPrice = deal.discountPct
    ? currencyFormatter.format(deal.price / (1 - deal.discountPct / 100))
    : null;

  const priceLine = originalPrice ? `De: ${originalPrice} | Por: ${price} 🥷` : `${price} 🥷`;
  const couponLine = deal.coupon ? `⚠️ cupom: ${deal.coupon}\n` : '';

  return (
    `${deal.title}\n\n` +
    `${priceLine}\n` +
    `${couponLine}\n` +
    `Link: ${deal.affiliateLink}`
  );
}
