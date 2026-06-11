const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
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
        ? `https://serpapi.com/search?engine=ebay_product&item_id=${asin}&api_key=${serpKey}`
        : `https://serpapi.com/search?engine=ebay&_nkw=${encodeURIComponent(q)}&_pgn=${page || 1}&api_key=${serpKey}`;
    }
    if (tienda === 'walmart') {
      serpUrl = asin
        ? `https://serpapi.com/search?engine=walmart_product&product_id=${asin}&api_key=${serpKey}`
        : `https://serpapi.com/search?engine=walmart&query=${encodeURIComponent(q)}&page=${page || 1}&api_key=${serpKey}`;
    }

    try {
      const response = await fetch(serpUrl);
      const data = await response.json();
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
    const response = await fetch(`https://realtime.easyparser.com/v1/request?${params}`);
    const data = await response.json();
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Error al consultar Easyparser' });
  }
};
