export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SHOP = process.env.SHOPIFY_SHOP;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!SHOP || !TOKEN) {
    return res.status(500).json({ ok: false, error: 'Shopify not configured' });
  }

  const { customerId } = req.query;
  if (!customerId) return res.status(400).json({ ok: false, error: 'Falta customerId' });

  const url = `https://${SHOP}/admin/api/2024-01/customers/${customerId}/metafields.json`;

  // GET — leer carrito
  if (req.method === 'GET') {
    try {
      const r = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': TOKEN }
      });
      const data = await r.json();
      const meta = (data.metafields || []).find(m => m.namespace === 'custom' && m.key === 'carrito_amazon');
      return res.status(200).json({ ok: true, carrito: meta ? JSON.parse(meta.value || '[]') : [], metafieldId: meta ? meta.id : null });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message) });
    }
  }

  // POST — guardar carrito
  if (req.method === 'POST') {
    try {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data)));
      });

      const { carrito, metafieldId } = body;

      let metaUrl, metaBody;
      if (metafieldId) {
        metaUrl = `https://${SHOP}/admin/api/2024-01/metafields/${metafieldId}.json`;
        metaBody = { metafield: { id: metafieldId, value: JSON.stringify(carrito), type: 'json' } };
      } else {
        metaUrl = url;
        metaBody = { metafield: { namespace: 'custom', key: 'carrito_amazon', value: JSON.stringify(carrito), type: 'json' } };
      }

      const r = await fetch(metaUrl, {
        method: metafieldId ? 'PUT' : 'POST',
        headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(metaBody)
      });
      const data = await r.json();
      return res.status(200).json({ ok: true, metafieldId: data.metafield ? data.metafield.id : null });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err.message) });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
