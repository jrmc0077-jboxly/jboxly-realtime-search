// /api/shein-search.js
// Endpoint que scrapea Shein via Oxylabs Web Scraper API
// Uso: /api/shein-search?q=vestido
// Devuelve listado con rating + imagen + URL directa de producto

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
    // Estrategia: extraer cada bloque de producto a partir de "goods_id"
    // Cada producto en el listado tiene goods_id en su JSON.
    const blocks = extractGoodsBlocks(html);

    for (const block of blocks) {
      const product = extractProductFromBlock(block);
      if (product && !seen.has(product.title)) {
        // Filtrar productos sin URL directa de producto
        if (product.url && product.url.indexOf('-p-') !== -1) {
          seen.add(product.title);
          products.push(product);
          if (products.length >= 30) break;
        }
      }
    }
  } catch (e) {
    console.error('Parse error:', e.message);
  }

  return products;
}

// Extrae bloques de texto alrededor de cada "goods_id":"NUMERO"
function extractGoodsBlocks(html) {
  const blocks = [];
  // Buscar el patrón "goods_id":"12345678" o "goods_id":12345678
  const regex = /"goods_id"\s*:\s*"?(\d{7,12})"?/g;
  let match;

  while ((match = regex.exec(html)) !== null && blocks.length < 60) {
    // Tomar 3000 caracteres alrededor del match para tener contexto
    const start = Math.max(0, match.index - 500);
    const end = Math.min(html.length, match.index + 3000);
    blocks.push({
      goods_id: match[1],
      context: html.slice(start, end),
    });
  }

  return blocks;
}

function extractProductFromBlock(block) {
  const { goods_id, context } = block;

  // Título
  const titleMatch = context.match(/"goods_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!titleMatch) return null;
  const title = unescapeJson(titleMatch[1]);
  if (!title || title.length < 5) return null;

  // Precio
  let price = '';
  const priceMatch = context.match(/"salePrice"\s*:\s*\{[^}]*"amountWithSymbol"\s*:\s*"([^"]+)"/) ||
                     context.match(/"amountWithSymbol"\s*:\s*"(\$\d+\.\d{2})"/) ||
                     context.match(/"amount"\s*:\s*"(\d+\.\d{2})"/);
  if (priceMatch) {
    price = priceMatch[1].startsWith('$') ? priceMatch[1] : `$${priceMatch[1]}`;
  }

  // Precio original (tachado)
  let originalPrice = '';
  const oldPriceMatch = context.match(/"retailPrice"\s*:\s*\{[^}]*"amountWithSymbol"\s*:\s*"([^"]+)"/);
  if (oldPriceMatch) originalPrice = oldPriceMatch[1];

  if (!price) return null;

  // Imagen
  let image = '';
  const imgMatch = context.match(/"goods_img"\s*:\s*"((?:[^"\\]|\\.)*)"/) ||
                   context.match(/"origin_image"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (imgMatch) {
    image = unescapeJson(imgMatch[1]);
    if (image.startsWith('//')) image = 'https:' + image;
  }

  // Rating (en el listado usualmente como "comment_rank_average" o "score")
  let rating = 0;
  const ratingMatch = context.match(/"comment_rank_average"\s*:\s*"?([\d.]+)"?/) ||
                      context.match(/"score"\s*:\s*"?([\d.]+)"?/) ||
                      context.match(/"productRelationID"[^}]*"score"\s*:\s*"?([\d.]+)"?/);
  if (ratingMatch) {
    const r = parseFloat(ratingMatch[1]);
    if (r > 0 && r <= 5) rating = r;
  }

  // Reviews count
  let reviewsCount = 0;
  const reviewsMatch = context.match(/"comment_num"\s*:\s*"?(\d+)"?/) ||
                       context.match(/"comment_num_show"\s*:\s*"?(\d+)"?/);
  if (reviewsMatch) {
    reviewsCount = parseInt(reviewsMatch[1]) || 0;
  }

  // goods_sn (para construir URL bonita)
  const snMatch = context.match(/"goods_sn"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const goodsSn = snMatch ? unescapeJson(snMatch[1]) : '';

  // Construir URL directa al producto usando goods_id
  // Formato: https://us.shein.com/SLUG-p-GOODSID.html
  const slug = title.trim().slice(0, 80).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-');
  const url = `https://us.shein.com/${encodeURIComponent(slug)}-p-${goods_id}.html`;

  return {
    title: title.trim(),
    price,
    originalPrice,
    image,
    url,
    goods_id,
    goods_sn: goodsSn,
    rating,
    reviewsCount,
    source: 'shein',
  };
}

function unescapeJson(str) {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
  }
}
