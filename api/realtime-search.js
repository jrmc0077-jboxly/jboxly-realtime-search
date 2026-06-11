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
      const sdKey = process.env.SCRAPINGDOG_API_KEY;
      let sdUrl = '';

      if (tienda === 'ebay') {
  if (asin) {
    sdUrl = `https://api.scrapingdog.com/ebay/product?api_key=${sdKey}&url=https://www.ebay.com/itm/${asin}`;
  } else {
    sdUrl = `https://api.scrapingdog.com/ebay/search?api_key=${sdKey}&url=https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`;
  }
}

      if (tienda === 'walmart') {
        if (asin) {
          sdUrl = `https://api.scrapingdog.com/walmart/product?api_key=${sdKey}&itemId=${asin}`;
        } else {
          sdUrl = `https://api.scrapingdog.com/walmart?api_key=${sdKey}&searchQuery=${encodeURIComponent(q)}&page=${page || 1}`;
        }
      }

      const response = await fetch(sdUrl);
      const data = await response.json();
      return res.status(200).json({ ok: true, data, fuente: tienda });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'Error al consultar ScrapingDog' });
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
