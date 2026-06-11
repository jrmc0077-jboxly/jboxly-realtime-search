const https = require('https');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { asin, q, tienda, page } = req.query;

  if (!asin && !q) {
    return res.status(400).json({ ok: false, error: 'Falta asin o q' });
  }

  if (tienda === 'ebay' || tienda === 'walmart') {
    const serpKey = process.env.SERPAPI_KEY;
    if (!serpKey) return res.status(500).json({ ok: false, error: 'SERPAPI_KEY no configurada' });

    let serpUrl = '';
    if (tienda === 'ebay') {
      serpUrl = asin
        ? `https://serpapi.com/search.json?engine=ebay_item&item_id=${asin}&api_key=${serpKey}`
        : `https://serpapi.com/search.json?engine=ebay&_nkw=${encodeURIComponent(q)}&_pgn=${page || 1}&api_key=${serpKey}`;
    }
    if (tienda === 'walmart') {
      serpUrl = asin
        ? `https://serpapi.com/search.json?engine=walmart_product&product_id=${asin}&api_key=${serpKey}`
        : `https://serpapi.com/search.json?engine=walmart&query=${encodeURIComponent(q)}&page=${page || 1}&api_key=${serpKey}`;
    }

    try {
      const result = await httpGet(serpUrl);
      if (result.status !== 200) {
        return res.status(500).json({ ok: false, error: 'SerpAPI error', status: result.status, body: result.body.substring(0, 300) });
      }
      const data = JSON.parse(result.body);
      return res.status(200).json({ ok: true, data, fuente: tienda });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  const params = new URLSearchParams({
    api_key: process.env.EASYPARSER_API_KEY,
    platform: 'AMZ',
    domain: '.com',
    operation: asin ? 'DETAIL' : 'SEARCH',
  });
  if (asin) params.append('asin', asin);
  if (q) params.append('keyword', q);
  if (page) params.append('page', page);

  try {
    const result = await httpGet(`https://realtime.easyparser.com/v1/request?${params}`);
    const data = JSON.parse(result.body);
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Error al consultar Easyparser' });
  }
}
