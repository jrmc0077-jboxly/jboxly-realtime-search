const fetch = require('node-fetch');

// ============================================================
// Resuelve links acortados de Amazon/eBay/Walmart siguiendo el
// redirect HTTP. Esto es necesario porque la app de Amazon comparte
// links tipo "a.co/d/XXXX" y "amzn.to/XXXX" que NO contienen el ASIN.
// Tambien sirve para links acortados de eBay (ebay.us, ebay.to).
// ============================================================

const DOMINIOS_VALIDOS = [
  'a.co', 'www.a.co',
  'amzn.to', 'amzn.com', 'www.amzn.com',
  'amazon.com', 'www.amazon.com', 'm.amazon.com',
  'ebay.us', 'ebay.to', 'rover.ebay.com',
  'ebay.com', 'www.ebay.com', 'm.ebay.com',
  'walmart.com', 'www.walmart.com', 'm.walmart.com',
  'shein.top', 'api-shein.shein.com', 'shein.com', 'us.shein.com', 'www.shein.com'
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache 7 dias por URL resuelta (el redirect no cambia)
  res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'Falta url' });

  // Validar que sea un dominio que esperamos (anti-SSRF)
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'URL invalida' });
  }
  if (!DOMINIOS_VALIDOS.includes(parsed.hostname.toLowerCase())) {
    return res.status(400).json({ ok: false, error: 'Dominio no soportado' });
  }

  try {
    // Seguir redirects hasta 5 saltos, con timeout de 8 segundos
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      follow: 5,
      headers: {
        // User-Agent realista: si pides como bot, Amazon a veces no redirige
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const finalUrl = r.url || url;
    return res.status(200).json({ ok: true, url: finalUrl, status: r.status });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'No se pudo resolver el link', detail: String(err.message || err) });
  }
};
