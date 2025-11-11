// api/jboxly/import.js

export default async function handler(req, res) {
  // --- CORS (imprescindible) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const {
      source,
      id,
      title,
      url,
      price,
      compare_at_price,
      images = []
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ ok: false, error: 'Missing title' });
    }

    // ====== ENV VARS ======
    const store = process.env.SHOPIFY_STORE;               // ej: pillar.myshopify.com
    const token = process.env.SHOPIFY_ADMIN_API_TOKEN;     // Admin API access token
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';

    if (!store || !token) {
      return res.status(500).json({ ok: false, error: 'Missing SHOPIFY_STORE or SHOPIFY_ADMIN_API_TOKEN env vars' });
    }

    // Handle sugerido a partir del título
    const handle = (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // Armamos el payload del producto
    const productPayload = {
      product: {
        title,
        handle,                // Shopify ajustará si ya existe
        status: 'draft',       // borrador
        body_html: url
          ? `<p>Importado desde ${source || 'externo'}: <a href="${url}" target="_blank" rel="nofollow noopener">ver origen</a></p>`
          : '',
        images: images.slice(0, 8).map(src => ({ src })),
        variants: [
          {
            price: (price != null && price !== '') ? String(price) : undefined,
            compare_at_price: (compare_at_price != null && compare_at_price !== '') ? String(compare_at_price) : undefined
          }
        ].filter(Boolean)
      }
    };

    // Llamada REST Admin API
    const resp = await fetch(`https://${store}/admin/api/${apiVersion}/products.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(productPayload)
    });

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: data?.errors || data });
    }

    const product = data.product;
    return res.status(200).json({
      ok: true,
      product_id: product.id,
      product_handle: product.handle
    });

  } catch (e) {
    console.error('[IMPORT] error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
feat: add /api/jboxly/import with CORS + Shopify create product
