// /api/shein-search.js
// Endpoint que scrapea Shein via Oxylabs Web Scraper API
// Uso: /api/shein-search?q=vestido

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter "q"' });
  }

  const user = process.env.OXYLABS_USER;
  const pass = process.env.OXYLABS_PASS;

  if (!user || !pass) {
    return res.status(500).json({ error: 'Oxylabs credentials not configured' });
  }

  const sheinUrl = `https://us.shein.com/pdsearch/${encodeURIComponent(q)}`;
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  try {
    const response = await fetch('https://realtime.oxylabs.io/v1/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: JSON.stringify({
        source: 'universal',
        url: sheinUrl,
        render: 'html',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Oxylabs error', status: response.status, detail: text.slice(0, 500) });
    }

    const data = await response.json();
    const html = data.results?.[0]?.content || '';

    if (!html) {
      return res.status(502).json({ error: 'Empty response from Oxylabs' });
    }

    const products = parseSheinHtml(html);

    return res.status(200).json({
      query: q,
      count: products.length,
      products,
    });

  } catch (error) {
    return res.status(500).json({ error: 'Internal error', message: error.message });
  }
}

function parseSheinHtml(html) {
  const products = [];
  const seen = new Set();

  try {
    // Estrategia 1: extraer cada objeto goods_name suelto del JSON embebido
    // Shein embebe productos en gbCommonInfo o similar
    const goodsBlocks = extractGoodsBlocks(html);

    for (const block of goodsBlocks) {
      const product = extractProductFromBlock(block);
      if (product && !seen.has(product.title)) {
        seen.add(product.title);
        products.push(product);
        if (products.length >= 20) break;
      }
    }

    // Estrategia 2: si no encontró nada, intentar parseo HTML directo
    if (products.length === 0) {
      const htmlProducts = extractFromHtmlDirect(html);
      for (const p of htmlProducts) {
        if (!seen.has(p.title)) {
          seen.add(p.title);
          products.push(p);
          if (products.length >= 20) break;
        }
      }
    }
  } catch (e) {
    console.error('Parse error:', e.message);
  }

  return products;
}

// Extrae bloques de texto alrededor de cada "goods_name"
function extractGoodsBlocks(html) {
  const blocks = [];
  const regex = /"goods_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;

  while ((match = regex.exec(html)) !== null && blocks.length < 40) {
    // Tomar 2500 caracteres alrededor del match para tener contexto
    const start = Math.max(0, match.index - 500);
    const end = Math.min(html.length, match.index + 2500);
    blocks.push({
      title: unescapeJson(match[1]),
      context: html.slice(start, end),
    });
  }

  return blocks;
}

function extractProductFromBlock(block) {
  const { title, context } = block;
  if (!title || title.length < 5) return null;

  // Buscar precio: "amount":"15.99" o "amountWithSymbol":"$15.99" o "usdAmount":"15.99"
  let price = '';
  const priceMatch = context.match(/"amountWithSymbol"\s*:\s*"([^"]+)"/) ||
                     context.match(/"amount"\s*:\s*"(\d+\.\d{2})"/) ||
                     context.match(/"usdAmount"\s*:\s*"(\d+\.\d{2})"/) ||
                     context.match(/\$(\d+\.\d{2})/);

  if (priceMatch) {
    price = priceMatch[1].startsWith('$') ? priceMatch[1] : `$${priceMatch[1]}`;
  }

  if (!price) return null;

  // Buscar imagen: "goods_img":"..."
  let image = '';
  const imgMatch = context.match(/"goods_img"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (imgMatch) {
    image = unescapeJson(imgMatch[1]);
    if (image.startsWith('//')) image = 'https:' + image;
  }

  // Buscar ID/sn: "goods_id":"123456" y "goods_sn":"sn"
  let goodsId = '';
  const idMatch = context.match(/"goods_id"\s*:\s*"?(\d+)"?/);
  if (idMatch) goodsId = idMatch[1];

  let goodsSn = '';
  const snMatch = context.match(/"goods_sn"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (snMatch) goodsSn = snMatch[1];

  // Construir URL
  const slug = title.trim().slice(0, 60).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-');
  const url = goodsId
    ? `https://us.shein.com/${encodeURIComponent(slug)}-p-${goodsId}.html`
    : `https://us.shein.com/search/${encodeURIComponent(title)}`;

  return {
    title: title.trim(),
    price,
    image,
    url,
    source: 'shein',
  };
}

// Fallback: extraer desde HTML directo
function extractFromHtmlDirect(html) {
  const products = [];
  const cardRegex = /<section[^>]*class="[^"]*product-card[^"]*"[\s\S]{0,4000}?<\/section>/gi;
  const matches = html.match(cardRegex) || [];

  for (const card of matches.slice(0, 20)) {
    const titleMatch = card.match(/title="([^"]+)"/) || card.match(/alt="([^"]+)"/);
    const priceMatch = card.match(/\$\s*(\d+\.\d{2})/);
    const imgMatch = card.match(/<img[^>]+(?:data-src|src)="([^"]+)"/);
    const linkMatch = card.match(/href="(\/[^"]+\.html)"/);

    if (titleMatch && priceMatch) {
      const title = titleMatch[1].trim();
      if (title.length < 5) continue;

      let image = imgMatch ? imgMatch[1] : '';
      if (image.startsWith('//')) image = 'https:' + image;

      let url = linkMatch ? linkMatch[1] : '';
      if (url.startsWith('/')) url = 'https://us.shein.com' + url;

      products.push({
        title,
        price: `$${priceMatch[1]}`,
        image,
        url,
        source: 'shein',
      });
    }
  }

  return products;
}

function unescapeJson(str) {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
  }
}
