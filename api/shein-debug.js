// updated
// /api/shein-debug.js
// Version DEBUG: devuelve fragmentos del HTML para inspeccionar la estructura
// Uso: /api/shein-debug?q=vestido

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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

    // Información de diagnostico
    const diagnostic = {
      htmlLength: html.length,
      htmlFirst500: html.slice(0, 500),
      hasGoodsKeyword: html.includes('"goods"'),
      hasProductsKeyword: html.includes('"products"'),
      hasGoodsName: html.includes('"goods_name"'),
      hasProductName: html.includes('"productName"'),
      hasPriceUSD: (html.match(/\$\d+\.\d{2}/g) || []).slice(0, 10),
      hasProductCard: html.includes('product-card'),
      // Buscar bloques de script JSON
      scriptJsonBlocks: extractScriptBlocks(html),
    };

    return res.status(200).json(diagnostic);

  } catch (error) {
    return res.status(500).json({ error: 'Internal error', message: error.message });
  }
}

function extractScriptBlocks(html) {
  const blocks = [];
  // Buscar primeros 5 bloques que contengan productos
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  let count = 0;

  while ((match = scriptRegex.exec(html)) !== null && count < 10) {
    const content = match[1];
    if (content.includes('goods') || content.includes('product') || content.includes('$')) {
      blocks.push({
        index: count,
        length: content.length,
        first300chars: content.slice(0, 300),
        containsGoodsName: content.includes('goods_name'),
        containsProductName: content.includes('productName'),
      });
      count++;
    }
  }

  return blocks;
}
