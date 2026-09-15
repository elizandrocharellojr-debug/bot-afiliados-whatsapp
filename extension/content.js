function detectSource() {
  const host = location.hostname;
  if (host.includes('mercadolivre')) return 'mercadolivre';
  if (host.includes('amazon')) return 'amazon';
  return null;
}

function parsePriceText(text) {
  if (!text) return '';
  return text.replace(/[^\d,.]/g, '').trim();
}

// Quando o titulo do produto nao e achado na pagina, o extrator cai pra
// document.title (o nome da aba do navegador) como ultimo recurso - e esse
// costuma vir com o preco e o nome do site colados no final, tipo
// "Produto X - R$ 60 | Mercado Livre". Isso tira essas sobras.
function cleanTitle(text) {
  if (!text) return text;
  return text
    .replace(/\s*[-|]\s*R\$\s*[\d.,]+\s*$/i, '')
    .replace(/\s*\|\s*Mercado Livre\s*$/i, '')
    .replace(/\s*\|\s*Amazon\.com\.br\s*$/i, '')
    .trim();
}

function computeDiscount(priceText, originalPriceText) {
  const p = Number(String(priceText).replace(/\./g, '').replace(',', '.'));
  const op = Number(String(originalPriceText).replace(/\./g, '').replace(',', '.'));
  if (op > p && p > 0) return Math.round(((op - p) / op) * 100);
  return '';
}

// Busca generica por qualquer texto na pagina mencionando cupom - tanto o
// Mercado Livre ("R$ 148,42 com Cupom") quanto a Amazon (checkbox de cupom
// perto do preco) costumam mostrar isso quando tem um cupom aplicavel.
function findCouponText() {
  const candidates = Array.from(document.querySelectorAll('body *'))
    .filter((el) => el.children.length === 0 && /cupom|coupon/i.test(el.textContent || ''))
    .map((el) => el.textContent.trim())
    .filter((t) => t.length > 0 && t.length < 120);
  return candidates[0] || '';
}

// Seletores do Mercado Livre nao foram verificados ao vivo (a plataforma
// bloqueia navegacao automatizada de teste) - por isso varias tentativas em
// cascata, e o painel sempre deixa os campos editaveis antes de enviar.
function extractMoneyFromContainer(container) {
  if (!container) return '';
  const fraction = container.querySelector('.andes-money-amount__fraction')?.textContent?.trim();
  const cents = container.querySelector('.andes-money-amount__cents')?.textContent?.trim();
  if (!fraction) return '';
  return cents ? `${fraction},${cents}` : fraction;
}

function extractMercadoLivre() {
  const title = cleanTitle(
    document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('.ui-pdp-title')?.textContent?.trim() ||
      document.title
  );

  const imageUrl =
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('.ui-pdp-gallery__figure img, .ui-pdp-image')?.src ||
    '';

  const priceContainer = document.querySelector('.ui-pdp-price__second-line .andes-money-amount');
  const originalPriceContainer = document.querySelector(
    '.ui-pdp-price__original-value .andes-money-amount, s .andes-money-amount'
  );

  const price = extractMoneyFromContainer(priceContainer);
  const originalPrice = extractMoneyFromContainer(originalPriceContainer);

  return {
    title,
    price,
    originalPrice,
    discountPct: price && originalPrice ? computeDiscount(price, originalPrice) : '',
    imageUrl,
    coupon: findCouponText(),
  };
}

function extractAmazon() {
  const title = cleanTitle(
    document.getElementById('productTitle')?.textContent?.trim() ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title
  );

  const imageUrl =
    document.getElementById('landingImage')?.src ||
    document.querySelector('meta[property="og:image"]')?.content ||
    '';

  const priceText = document.querySelector('.a-price .a-offscreen')?.textContent?.trim() || '';
  const originalPriceText =
    document.querySelector('.basisPrice .a-offscreen, [data-a-strike="true"] .a-offscreen')?.textContent?.trim() ||
    '';

  const price = parsePriceText(priceText);
  const originalPrice = parsePriceText(originalPriceText);

  return {
    title,
    price,
    originalPrice,
    discountPct: price && originalPrice ? computeDiscount(price, originalPrice) : '',
    imageUrl,
    coupon: findCouponText(),
  };
}

function extractData(source) {
  return source === 'mercadolivre' ? extractMercadoLivre() : extractAmazon();
}

function createUI(source) {
  const host = document.createElement('div');
  host.id = 'bot-afiliados-host';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
    .btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
      background: #25D366; color: white; border: none; border-radius: 50px;
      padding: 14px 20px; font-size: 15px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .btn:hover { background: #1ebe57; }
    .panel {
      position: fixed; bottom: 90px; right: 24px; z-index: 2147483647;
      width: 320px; background: white; border-radius: 12px; padding: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3); display: none;
    }
    .panel.open { display: block; }
    .panel label { display: block; font-size: 12px; color: #333; margin-top: 8px; font-weight: 600; }
    .panel input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; margin-top: 2px; }
    .row { display: flex; gap: 8px; margin-top: 12px; }
    .row button { flex: 1; padding: 10px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .send { background: #25D366; color: white; }
    .cancel { background: #eee; color: #333; }
    .status { margin-top: 8px; font-size: 13px; min-height: 16px; }
    .status.ok { color: #1a7f37; }
    .status.err { color: #c0392b; }
  `;
  shadow.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = '📢 Enviar oferta';
  shadow.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <label>Link do "Compartilhar" (opcional - cole aqui pra usar a vitrine bonita do ML)</label>
    <input type="text" id="f-share-link" placeholder="https://meli.la/...">
    <label>Titulo</label>
    <input type="text" id="f-title">
    <label>Preco original (De: - deixe em branco se nao tiver desconto)</label>
    <input type="text" id="f-original-price">
    <label>Preco atual (Por:)</label>
    <input type="text" id="f-price">
    <label>Desconto %</label>
    <input type="text" id="f-discount">
    <label>Link da imagem</label>
    <input type="text" id="f-image">
    <label>Cupom disponivel (opcional)</label>
    <input type="text" id="f-coupon" placeholder="ex: CUPOM10">
    <div class="row">
      <button class="send">Enviar</button>
      <button class="cancel">Cancelar</button>
    </div>
    <div class="status"></div>
  `;
  shadow.appendChild(panel);

  const fShareLink = panel.querySelector('#f-share-link');
  const fTitle = panel.querySelector('#f-title');
  const fOriginalPrice = panel.querySelector('#f-original-price');
  const fPrice = panel.querySelector('#f-price');
  const fDiscount = panel.querySelector('#f-discount');
  const fImage = panel.querySelector('#f-image');
  const fCoupon = panel.querySelector('#f-coupon');
  const statusEl = panel.querySelector('.status');

  function recomputeDiscount() {
    if (fOriginalPrice.value.trim() && fPrice.value.trim()) {
      const d = computeDiscount(fPrice.value.trim(), fOriginalPrice.value.trim());
      if (d !== '') fDiscount.value = d;
    }
  }
  fOriginalPrice.addEventListener('input', recomputeDiscount);
  fPrice.addEventListener('input', recomputeDiscount);

  btn.addEventListener('click', () => {
    if (!panel.classList.contains('open')) {
      const data = extractData(source);
      fShareLink.value = '';
      fTitle.value = data.title || '';
      fOriginalPrice.value = data.originalPrice || '';
      fPrice.value = data.price || '';
      fDiscount.value = data.discountPct || '';
      fImage.value = data.imageUrl || '';
      fCoupon.value = data.coupon || '';
      statusEl.textContent = '';
      statusEl.className = 'status';
    }
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      // Foca no preco (o campo que mais precisa de conferencia) - assim da
      // pra so apertar Enter direto se tudo ja veio certo.
      fPrice.focus();
    }
  });

  panel.querySelector('.cancel').addEventListener('click', () => {
    panel.classList.remove('open');
  });

  function sendDeal() {
    const payload = {
      source,
      productUrl: fShareLink.value.trim() || location.href,
      title: fTitle.value.trim(),
      originalPrice: fOriginalPrice.value.trim() || null,
      price: fPrice.value.trim(),
      discountPct: fDiscount.value.trim() ? Number(fDiscount.value.trim()) : null,
      imageUrl: fImage.value.trim() || null,
      coupon: fCoupon.value.trim() || null,
    };

    if (!payload.title || !payload.price) {
      statusEl.textContent = 'Preencha pelo menos titulo e preco.';
      statusEl.className = 'status err';
      return;
    }

    statusEl.textContent = 'Enviando...';
    statusEl.className = 'status';

    chrome.runtime.sendMessage({ type: 'POST_DEAL', payload }, (response) => {
      if (response?.ok) {
        statusEl.textContent = 'Enviado pro grupo!';
        statusEl.className = 'status ok';
      } else {
        statusEl.textContent = response?.error || 'Falha ao enviar.';
        statusEl.className = 'status err';
      }
    });
  }

  panel.querySelector('.send').addEventListener('click', sendDeal);

  // Aperta Enter em qualquer campo do painel pra enviar direto, sem precisar
  // clicar no botao - agiliza bastante quando os dados ja vieram certos.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendDeal();
    }
  });
}

const source = detectSource();
if (source) createUI(source);
