// /api/shein-search.js
// Endpoint que scrapea Shein via Oxylabs Web Unblocker
// Uso: /api/shein-search?q=vestido

export default async function handler(req, res) {
  // CORS para que jboxly.com pueda llamarlo
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate'); // cache 24h

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

    // Parsear productos del HTML
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

// Parser de productos Shein
// Shein embebe datos en un <script> con JSON. Extraemos eso.
function parseSheinHtml(html) {
  const products = [];

  try {
    // Patrón 1: extraer goods array de productionDataApi
    const goodsRegex = /"goods":\s*(\[[\s\S]*?\])\s*,\s*"goodsCateInfo"/;
    let match = html.match(goodsRegex);

    if (!match) {
      // Patrón fallback: buscar "products":[...]
      const productsRegex = /"products":\s*(\[[\s\S]*?\])\s*,/;
      match = html.match(productsRegex);
    }

    if (match) {
      const goodsArray = JSON.parse(match[1]);
      for (const item of goodsArray.slice(0, 20)) {
        const product = extractProduct(item);
        if (product) products.push(product);
      }
    }

    // Fallback: extraer desde HTML directo si el JSON falló
    if (products.length === 0) {
      const htmlProducts = extractFromHtml(html);
      products.push(...htmlProducts);
    }
  } catch (e) {
    console.error('Parse error:', e.message);
  }

  return products;
}

function extractProduct(item) {
  try {
    const title = item.goods_name || item.productName || item.title || '';
    const priceObj = item.salePrice || item.retailPrice || item.price || {};
    const price = priceObj.amount || priceObj.amountWithSymbol || priceObj.usdAmount || '';
    const image = item.goods_img || item.image || item.productImg || '';
    const goodsId = item.goods_id || item.id || item.productId || '';
    const goodsSn = item.goods_sn || item.productSn || '';

    if (!title || !price) return null;

    const url = goodsSn && goodsId
      ? `https://us.shein.com/${encodeURIComponent(title.replace(/\s+/g, '-'))}-p-${goodsId}.html`
      : `https://us.shein.com/${goodsSn || goodsId}.html`;

    return {
      title: title.trim(),
      price: typeof price === 'number' ? `$${price.toFixed(2)}` : String(price),
      image: image.startsWith('//') ? `https:${image}` : image,
      url,
      source: 'shein',
    };
  } catch (e) {
    return null;
  }
}

// Fallback: extraer productos desde HTML si JSON falla
function extractFromHtml(html) {
  const products = [];
  // Buscar tarjetas de productos
  const cardRegex = /<section[^>]*class="[^"]*product-card[^"]*"[\s\S]*?<\/section>/gi;
  const matches = html.match(cardRegex) || [];

  for (const card of matches.slice(0, 20)) {
    const titleMatch = card.match(/title="([^"]+)"|alt="([^"]+)"/);
    const priceMatch = card.match(/\$\s*(\d+\.\d{2})/);
    const imgMatch = card.match(/<img[^>]+src="([^"]+)"/);
    const linkMatch = card.match(/href="([^"]+)"/);

    if (titleMatch && priceMatch) {
      const title = (titleMatch[1] || titleMatch[2] || '').trim();
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
