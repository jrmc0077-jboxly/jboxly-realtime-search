const fetch = require('node-fetch');

// ============================================================
// OFERTAS DE AMAZON - 100% AUTOMATICO
// Como funciona:
// 1. Busca keywords de categorias populares (rotan cada hora)
// 2. Toma los mejores ASINs de cada busqueda
// 3. Consulta el DETAIL de cada uno (el DETAIL trae el rrp =
//    precio de lista, que las busquedas no traen)
// 4. Filtra solo productos con descuento real >= 10%
// 5. Devuelve ordenado por mayor descuento
// Con cache CDN de 6h: ~4 ejecuciones/dia sin importar trafico.
// Costo aprox: (2 busquedas + 16 detalles) x 4/dia = ~72 creditos/dia
// ============================================================

// Categorias que rotan (orientadas a tu publico LATAM)
const KEYWORDS = [
  'wireless headphones', 'smart watch', 'air fryer', 'bluetooth speaker',
  'tablet android', 'gaming keyboard', 'robot vacuum', 'power bank',
  'security camera', 'electric scooter', 'hair dryer', 'blender'
];
const KEYWORDS_POR_REFRESH = 2;   // busquedas por ejecucion
const DETALLES_POR_KEYWORD = 8;   // productos a verificar por busqueda
const DESCUENTO_MINIMO = 10;      // % minimo para considerarse oferta

// OPCIONAL: ASINs fijos que siempre quieres mostrar (ej. Prime Day).
// Dejar vacio para modo 100% automatico.
const ASINS_FIJOS = [];

function aNumero(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') return parseFloat(x.replace(/[^0-9.]/g, '')) || 0;
  if (typeof x === 'object') return aNumero(x.value) || aNumero(x.amount) || aNumero(x.raw);
  return 0;
}

function extraerListPrice(detail) {
  const bb = detail.buybox_winner || {};
  const candidatos = [
    bb.rrp, bb.list_price, bb.was_price,
    bb.price && bb.price.before_price,
    bb.price && bb.price.list_price,
    detail.rrp, detail.list_price, detail.original_price
  ];
  for (const c of candidatos) {
    const n = aNumero(c);
    if (n > 0) return n;
  }
  return 0;
}

async function easyparser(extraParams) {
  const params = new URLSearchParams({
    api_key: process.env.EASYPARSER_API_KEY,
    platform: 'AMZ',
    domain: '.com'
  });
  Object.keys(extraParams).forEach(k => params.append(k, extraParams[k]));
  const r = await fetch('https://realtime.easyparser.com/v1/request?' + params);
  return r.json();
}

async function buscarConReintento(keyword) {
  // Easyparser a veces devuelve 504 intermitente: reintentamos una vez
  for (let intento = 0; intento < 2; intento++) {
    try {
      const data = await easyparser({ operation: 'SEARCH', keyword: keyword });
      const items = (data && data.result && data.result.search_results) || [];
      if (items.length > 0) return items;
    } catch (e) { /* reintentar */ }
  }
  return [];
}

async function detalleAOferta(asin, debug) {
  try {
    const data = await easyparser({ operation: 'DETAIL', asin: asin });
    const detail = (data.result && data.result.detail) || {};
    const bb = detail.buybox_winner || {};
    const priceNum = aNumero(bb.price);
    if (!detail.title || !priceNum) return null;
    const oldNum = extraerListPrice(detail);
    if (oldNum <= priceNum) return null;
    const pct = Math.round((1 - priceNum / oldNum) * 100);
    if (pct < DESCUENTO_MINIMO) return null;
    const item = {
      tienda: 'amazon',
      asin: asin,
      title: detail.title,
      price: '$' + priceNum,
      priceNum: priceNum,
      oldNum: oldNum,
      oldPrice: '$' + oldNum,
      badge: '-' + pct + '%',
      pct: pct,
      image: (detail.main_image && detail.main_image.link) || '',
      link: 'https://www.amazon.com/dp/' + asin
    };
    if (debug) item._debug_buybox_keys = Object.keys(bb);
    return item;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache CDN de Vercel: 6 horas compartidas entre todos los visitantes
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const debug = req.query.debug === '1';
  const todas = req.query.todas === '1';
  if (!process.env.EASYPARSER_API_KEY) {
    return res.status(500).json({ ok: false, error: 'EASYPARSER_API_KEY no configurada' });
  }

  try {
    let seleccionadas;
    if (todas) {
      // Modo "todas las ofertas": usar TODAS las keywords
      seleccionadas = KEYWORDS.slice();
    } else {
      // Modo home: 2 keywords que rotan cada 6 horas
      const horaBloque = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
      seleccionadas = [];
      for (let i = 0; i < KEYWORDS_POR_REFRESH; i++) {
        seleccionadas.push(KEYWORDS[(horaBloque * KEYWORDS_POR_REFRESH + i) % KEYWORDS.length]);
      }
    }

    // 2) Buscar y recolectar ASINs candidatos (sin patrocinados)
    const busquedas = await Promise.all(seleccionadas.map(kw => buscarConReintento(kw)));
    let asins = [];
    busquedas.forEach(items => {
      items
        .filter(p => p.asin && !p.is_sponsored)
        .slice(0, DETALLES_POR_KEYWORD)
        .forEach(p => { if (asins.indexOf(p.asin) === -1) asins.push(p.asin); });
    });
    ASINS_FIJOS.forEach(a => { if (asins.indexOf(a) === -1) asins.unshift(a); });

    // 3) Verificar cada uno con DETAIL (en paralelo) y quedarnos con las ofertas
    const resultados = await Promise.all(asins.map(a => detalleAOferta(a, debug)));
    const ofertas = resultados.filter(Boolean).sort((a, b) => b.pct - a.pct);

    return res.status(200).json({
      ok: true,
      ofertas: ofertas,
      total: ofertas.length,
      keywords_usadas: debug ? seleccionadas : undefined,
      asins_verificados: debug ? asins.length : undefined
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Error al generar ofertas' });
  }
};
