// api/auctions.js
// Lee un CSV público (Google Sheets publicado) y responde JSON con paginación + filtros.

const SHEET_CSV = process.env.AUCTIONS_CSV_URL; // pega aquí tu URL CSV publicada
const PAGE_SIZE_DEFAULT = 24;

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',').map(h => h.trim());
  return lines.map(line => {
    // soporte rudimentario de comas; si tu CSV tiene comillas, conviene un parser tipo papaparse
    const parts = line.split(',').map(v => v.trim());
    const obj = {};
    header.forEach((k, i) => obj[k] = parts[i] || '');
    return obj;
  });
}

export default async function handler(req, res) {
  // CORS para Shopify
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = Math.max(1, parseInt(url.searchParams.get('pageSize') || PAGE_SIZE_DEFAULT, 10));
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const category = (url.searchParams.get('category') || '').toLowerCase();
    const seller = (url.searchParams.get('seller') || '').toLowerCase();

    if (!SHEET_CSV) {
      return res.status(500).json({ ok:false, error:'Missing AUCTIONS_CSV_URL env var' });
    }

    const resp = await fetch(SHEET_CSV);
    const text = await resp.text();
    let items = parseCSV(text).map(x => ({
      id: x.id,
      title: x.title,
      url: x.url,
      image: x.image,
      location: x.location,
      current_bid: x.current_bid,
      msrp: x.msrp,
      ends_at: x.ends_at,
      quantity: x.quantity,
      condition: x.condition,
      category: x.category,
      seller: x.seller
    }));

    // filtros
    if (q) items = items.filter(i => (i.title || '').toLowerCase().includes(q));
    if (category) items = items.filter(i => (i.category || '').toLowerCase().includes(category));
    if (seller) items = items.filter(i => (i.seller || '').toLowerCase().includes(seller));

    // ordenar por cierre más cercano (opcional)
    items.sort((a,b) => new Date(a.ends_at) - new Date(b.ends_at));

    const total = items.length;
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    res.status(200).json({
      ok: true,
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
      items: pageItems
    });
  } catch (e) {
    console.error('[AUCTIONS] error', e);
    res.status(500).json({ ok:false, error: e.message });
  }
}
