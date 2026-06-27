// /api/shein-product.js — DEBUG v2 (temporal)
// Buscar palabras clave nuevas para reviews

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" parameter' });
  }

  const user = process.env.OXYLABS_USER;
  const pass = process.env.OXYLABS_PASS;

  if (!user || !pass) {
    return res.status(500).json({ error: 'Oxylabs credentials not configured' });
  }

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
        url: url,
        render: 'html',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Oxylabs error', status: response.status, detail: text.slice(0, 500) });
    }

    const data = await response.json();
    const html = data.results?.[0]?.content || '';

    if (!html) return res.status(502).json({ error: 'Empty' });

    // Buscar palabras clave relacionadas con reviews
    const keywords = [
      '4.57',                    // El rating que el usuario vio
      '"4.5"',
      '"4.6"',
      'Customer Reviews',
      'View More',
      'Review Policy',
      '"average"',
      'comment_average',
      'product_score',
      'avgComment',
      'commentInfoBo',
      'reviewInfo',
      'commentRankAverage',
      'overall_rating',
      'productCommentInfo',
      'goods_score'
    ];

    const fragments = {};

    keywords.forEach(function(kw) {
      const idx = html.indexOf(kw);
      if (idx !== -1) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(html.length, idx + 600);
        fragments[kw] = html.slice(start, end);
      } else {
        fragments[kw] = null;
      }
    });

    return res.status(200).json({
      url,
      htmlLength: html.length,
      fragments,
    });

  } catch (error) {
    return res.status(500).json({ error: 'Internal error', message: error.message });
  }
}
