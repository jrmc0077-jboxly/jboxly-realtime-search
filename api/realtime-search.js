import fetch from "node-fetch";
import * as cheerio from "cheerio";

const cache = new Map();
const TTL = 5 * 60 * 1000; // 5 min
const NIMBLE = "https://api.nimbleway.com/scrape";
const KEY = process.env.NIMBLEWAY_KEY;

const ALLOWED_ORIGINS = new Set([
  "https://www.jboxly.com",
  "https://jboxly.com",
  "https://jboxly.myshopify.com"
]);

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://www.jboxly.com";
  const cors = {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }

  try {
    const { q = "" } = req.query;
    const query = String(q || "").trim();
    if (!query) { res.writeHead(200, cors).end(JSON.stringify({ items: [] })); return; }

    const key = `search:${query.toLowerCase()}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.t < TTL) { res.writeHead(200, cors).end(JSON.stringify(hit.data)); return; }

    const [amazon, shein] = await Promise.allSettled([
      searchAmazon(query),
      searchShein(query)
    ]);

    const a = amazon.status === "fulfilled" ? amazon.value : [];
    const s = shein.status === "fulfilled" ? shein.value : [];
    console.log(`[JBOXLY] q="${query}" -> amazon:${a.length} shein:${s.length}`);

    const items = [...a, ...s].slice(0, 24);
    const payload = { items };
    cache.set(key, { t: now, data: payload });
    res.writeHead(200, cors).end(JSON.stringify(payload));
  } catch (e) {
    console.error("[JBOXLY] ERROR", e);
    res.writeHead(200, cors).end(JSON.stringify({ items: [] }));
  }
}

/* ---------- AMAZON (más robusto) ---------- */
async function searchAmazon(q){
  // usar render=true para que aparezcan más tarjetas
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
  const html = await nimbleScrape(url, { render: true, country: "US" });
  const $ = cheerio.load(html);
  const items = [];

  $('div.s-main-slot [data-component-type="s-search-result"]').each((_, el) => {
    const title = $(el).find("h2 a span").text().trim();
    let href = $(el).find("h2 a").attr("href") || "";
    if (href && !href.startsWith("http")) href = "https://www.amazon.com" + href;

    // distintos layouts de precio
    let price = "";
    const p1 = $(el).find(".a-price .a-offscreen").first().text().trim();
    const pWhole = $(el).find(".a-price-whole").first().text().replace(/[^\d]/g, "");
    const pFrac  = $(el).find(".a-price-fraction").first().text().replace(/[^\d]/g, "");
    if (p1) price = p1.replace(/[^\d.,]/g,"");
    else if (pWhole) price = `${pWhole}.${pFrac || "00"}`;

    const img = $(el).find("img.s-image").attr("src");
    if (title && href) items.push({ source: "amazon", title, price, currency: "USD", image: img, url: href });
  });

  return items.slice(0, 12);
}

/* ---------- SHEIN (dos rutas + más selectores) ---------- */
async function searchShein(q){
  const items = [];

  // Ruta 1: pse (render=true)
  try {
    const url1 = `https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`;
    const html1 = await nimbleScrape(url1, { render: true });
    items.push(...parseShein(html1));
  } catch(e){ console.warn("[JBOXLY] SHEIN pse fail", e?.message); }

  // Ruta 2: búsqueda clásica (algunas keywords solo aparecen aquí)
  if (items.length < 8) {
    try {
      const url2 = `https://us.shein.com/search?keyword=${encodeURIComponent(q)}`;
      const html2 = await nimbleScrape(url2, { render: true });
      items.push(...parseShein(html2));
    } catch(e){ console.warn("[JBOXLY] SHEIN classic fail", e?.message); }
  }

  // dedup
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = it.url || it.title;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= 12) break;
  }
  return out;
}

function parseShein(html){
  const $ = cheerio.load(html);
  const items = [];

  // Intento 1: cards nuevas
  $("[data-test='product-card'], .S-product-item, .product-card").each((_, el) => {
    const title = $(el).find(".S-product-item__name, .product-title, .S-product-item__info a").first().text().trim();
    const price = $(el).find(".S-product-item__price, .price, .original, .sale-price").first().text().trim();
    let href = $(el).find("a").attr("href") || "";
    let img = $(el).find("img").attr("src") || "";
    if (href && !href.startsWith("http")) href = `https://us.shein.com${href}`;
    if (img && img.startsWith("//")) img = "https:" + img;
    if (title && href) items.push({ source: "shein", title, price, currency: "USD", image: img, url: href });
  });

  // Intento 2: rejillas antiguas
  if (items.length === 0) {
    $(".c-product-card, .j-expose__product-item").each((_, el) => {
      const title = $(el).find(".c-product-card__name, .goods-title, a[title]").first().text().trim();
      const price = $(el).find(".c-product-card__price, .sale-price, .price").first().text().trim();
      let href = $(el).find("a").attr("href") || "";
      let img = $(el).find("img").attr("src") || "";
      if (href && !href.startsWith("http")) href = `https://us.shein.com${href}`;
      if (img && img.startsWith("//")) img = "https:" + img;
      if (title && href) items.push({ source: "shein", title, price, currency: "USD", image: img, url: href });
    });
  }

  return items;
}

/* ---------- Helper Nimbleway ---------- */
async function nimbleScrape(url, { render = false, country = "US" } = {}) {
  if (!KEY) throw new Error("Falta NIMBLEWAY_KEY");
  const u = `${NIMBLE}?url=${encodeURIComponent(url)}&render=${String(render)}&country=${country}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`Nimbleway error ${r.status}`);
  const data = await r.json().catch(() => ({}));
  return data.html || data.content || "";
}
