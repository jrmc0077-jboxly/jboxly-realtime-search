export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { asin, q, tienda, page } = req.query;

  if (!asin && !q) {
    return res.status(400).json({ ok: false, error: 'Falta asin o q' });
  }

  // EBAY y WALMART via ScrapingDog
  if (tienda === 'ebay' || tienda === 'walmart') {
    try {
      const serpKey = process.env.SERPAPI_KEY;
      let serpUrl = '';

      if (tienda === 'ebay') {
        const serpKey = process.env.SERPAPI_KEY;
        if (asin) {
          sdUrl = `https://serpapi.com/search.json?engine=ebay_item&item_id=${asin}&api_key=${serpKey}`;
        } else {
          sdUrl = `https://serpapi.com/search.json?engine=ebay&_nkw=${encodeURIComponent(q)}&api_key=${serpKey}`;
        }
      }

      if (tienda === 'walmart') {
        if (asin) {
          serpUrl = `https://serpapi.com/search.json?engine=walmart_product&product_id=${asin}&api_key=${serpKey}`;
        } else {
          serpUrl = `https://serpapi.com/search.json?engine=walmart&query=${encodeURIComponent(q)}&page=${page || 1}&api_key=${serpKey}`;
        }
      }

      const response = await fetch(serpUrl);
      const data = await response.json();
      return res.status(200).json({ ok: true, data, fuente: tienda });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Error al consultar SerpAPI' });
    }
  }

  // AMAZON via Easyparser (default)
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
}
