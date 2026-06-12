const fetch = require('node-fetch');

// ============================================================
// LISTA DE OFERTAS DE AMAZON (editar aqui)
// Agrega los ASINs de los productos en oferta que quieres
// mostrar en el home. Maximo recomendado: 15.
// El ASIN es el codigo del link: amazon.com/dp/B0XXXXXXXX
// ============================================================
const ASINS_OFERTAS = [
  'B08PP5MSVB',
  'B0BGQKY8S9'
  // 'B0XXXXXXXX',
  // 'B0YYYYYYYY',
];

function extraerListPrice(detail) {
  // Easyparser puede traer el precio anterior en distintos campos
  // segun el producto. Probamos todos los candidatos conocidos.
  const bb = detail.buybox_winner || {};
  const candidatos = [
    bb.rrp && bb.rrp.value,
    bb.list_price && bb.list_price.value,
    bb.was_price && bb.was_price.value,
    bb.price && bb.price.before_price,
    bb.price && bb.price.list_price,
    detail.rrp && detail.rrp.value,
    detail.list_price && (detail.list_price.value || detail.list_price),
    detail.original_price,
    bb.rrp,
    bb.list_price
  ];
  for (const c of candidatos) {
    const n = parseFloat(c);
    if (n && n > 0) return n;
  }
  return 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache en el CDN de Vercel: 6 horas. Todos los visitantes comparten
  // esta respuesta -> Easyparser solo se consulta ~4 veces al dia.
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const debug = req.query.debug === '1';
  const apiKey = process.env.EASYPARSER_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'EASYPARSER_API_KEY no configurada' });
  if (!ASINS_OFERTAS.length) return res.status(200).json({ ok: true, ofertas: [] });

  try {
    const resultados = await Promise.all(ASINS_OFERTAS.map(async (asin) => {
      try {
        const params = new URLSearchParams({
          api_key: apiKey,
          platform: 'AMZ',
          domain: '.com',
          operation: 'DETAIL',
          asin: asin
        });
        const r = await fetch('https://realtime.easyparser.com/v1/request?' + params);
        const data = await r.json();
        const detail = (data.result && data.result.detail) || {};
        const bb = detail.buybox_winner || {};
        const priceNum = parseFloat(bb.price && bb.price.value) || 0;
        if (!detail.title || !priceNum) return null;

        const oldNum = extraerListPrice(detail);
        const tieneDescuento = oldNum > priceNum;
        const item = {
          tienda: 'amazon',
          asin: asin,
          title: detail.title,
          price: '$' + priceNum,
          priceNum: priceNum,
          oldNum: tieneDescuento ? oldNum : 0,
          oldPrice: tieneDescuento ? '$' + oldNum : '',
          badge: tieneDescuento ? '-' + Math.round((1 - priceNum / oldNum) * 100) + '%' : '',
          image: (detail.main_image && detail.main_image.link) || '',
          link: 'https://www.amazon.com/dp/' + asin
        };
        if (debug) item._debug_buybox_keys = Object.keys(bb);
        return item;
      } catch (e) {
        return null;
      }
    }));

    const ofertas = resultados.filter(Boolean);
    return res.status(200).json({ ok: true, ofertas: ofertas, total: ofertas.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Error al consultar Easyparser' });
  }
};
