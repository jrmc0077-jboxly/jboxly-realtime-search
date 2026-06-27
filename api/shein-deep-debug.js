// /api/shein-deep-debug.js
// Devuelve fragmentos del HTML alrededor de palabras clave
// Uso: /api/shein-deep-debug?url=https://us.shein.com/PRODUCTO.html

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

    if (!html) {
      return res.status(502).json({ error: 'Empty response' });
    }

    // Buscar fragmentos alrededor de palabras clave
    const keywords = [
      'rating',
      'comment_rank',
      'comment_num',
      'review',
      'star',
      'attribute',
      'specifications',
      'attr_value',
      'attr_name',
      'color_name',
      'goods_color',
      'related_color',
      'goods_desc',
      'fit_size'
    ];

    const fragments = {};

    keywords.forEach(function(kw) {
      const idx = html.indexOf('"' + kw);
      if (idx !== -1) {
        // Extraer 400 caracteres alrededor del primer match
        const start = Math.max(0, idx - 50);
        const end = Math.min(html.length, idx + 400);
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
