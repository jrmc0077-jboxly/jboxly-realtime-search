import fetch from "node-fetch";
import * as cheerio from "cheerio";

// Cache en memoria (demo). En producción usa Redis.
const cache = new Map();
const TTL = 60 * 5 * 1000; // 5 min

export default async function handler(req, res) {
  try {
    const { q = "" } = req.query;
    const query = String(q || "").trim();
    if (!query) return res.status(200).json({ items: [] });

    const key = `search:${query.toLowerCase()}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.t < TTL) return res.status(200).json(hit.data);

    // Ejecuta en paralelo
    const [amazon, shein] = await Promise.allSettled([
      searchAmazon(query),
      searchShein(query)
    ]);

    const items = [
      ...(amazon.status === "fulfilled" ? amazon.value : []),
      ...(shein.status === "fulfilled" ? shein.value : [])
    ].slice(0, 24);

    const payload = { items };
    cache.set(key, { t: now, data: payload });
    res.status(200).json(payload);
  } catch (e) {
    res.status(200).json({ items: [] });
  }
}

/** AMAZON: usa PA-API si tienes credenciales; si no, fallback scraping demo */
async function searchAmazon(q) {
  const usePaapi = !!(process.env.AMAZON_ACCESS_KEY && process.env.AMAZON_SECRET_KEY && process.env.AMAZON_PARTNER_TAG);
  if (usePaapi) {
    // Aquí deberías integrar PA-API v5 con una lib oficial.
    // Para la demo, devolvemos vacío si no implementas aún.
    return [];
  } else {
    // Fallback demo scraping (búsqueda pública). Ajusta selectores si Amazon cambia.
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(q)}`;
    const html = await simpleScrape(url); // sin JS render
    const $ = cheerio.load(html);
    const items = [];
    $("div.s-main-slot div[data-component-type='s-search-result']").slice(0, 8).each((_, el) => {
      const title = $(el).find("h2 a span").text().trim();
      const href = "https://www.amazon.com" + ($(el).find("h2 a").attr("href") || "");
      const priceWhole = $(el).find(".a-price-whole").first().text().replace(/[^\d]/g, "");
      const priceFrac = $(el).find(".a-price-fraction").first().text().replace(/[^\d]/g, "");
      const price = priceWhole ? `${priceWhole}.${priceFrac || "00"}` : "";
      const img = $(el).find("img.s-image").attr("src");
      if (title && href) {
        items.push({ source: "amazon", title, price, currency: "USD", image: img, url: href });
      }
    });
    return items;
  }
}

/** SHEIN: usando Nimbleway con render JS */
async function searchShein(q) {
  const base = "https://api.nimbleway.com/scrape";
  const target = `https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`;
  const r = await fetch(`${base}?url=${encodeURIComponent(target)}&render=true`, {
    headers: { Authorization: `Bearer ${process.env.NIMBLEWAY_KEY}` }
  });
  const data = await r.json().catch(() => ({}));
  const html = data.html || data.content || "";
  const $ = cheerio.load(html);
  const items = [];
  // Ajusta selectores reales de SHEIN:
  $("[data-test='product-card'], .S-product-item, .product-card").slice(0, 12).each((_, el) => {
    const title = $(el).find(".S-product-item__name, .product-title, .S-product-item__info a").first().text().trim();
    const price = $(el).find(".S-product-item__price, .price, .original").first().text().trim();
    let href = $(el).find("a").attr("href") || "";
    let img = $(el).find("img").attr("src") || "";
    if (href && !href.startsWith("http")) href = `https://us.shein.com${href}`;
    if (img && img.startsWith("//")) img = "https:" + img;
    if (title && href) items.push({ source: "shein", title, price, currency: "USD", image: img, url: href });
  });
  return items;
}

// Scraping simple (sin render) para páginas ligeras
async function simpleScrape(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  return await r.text();
}
