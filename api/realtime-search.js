import fetch from "node-fetch";
import * as cheerio from "cheerio";

const cache = new Map();
const TTL = 5 * 60 * 1000; // 5 min
const NIMBLE = "https://api.nimbleway.com/scrape";
const KEY = process.env.NIMBLEWAY_KEY;

export default async function handler(req, res) {
  try {
    const { q = "" } = req.query;
    const query = String(q || "").trim();
    if (!query) return res.status(200).json({ items: [] });

    const key = `search:${query.toLowerCase()}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.t < TTL) return res.status(200).json(hit.data);

    const [amazon, shein] = await Promise.allSettled([
      searchAmazonNimble(query),
      searchSheinNimble(query)
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

// --- AMAZON vía Nimbleway (búsqueda) ---
async function searchAmazonNimble(q) {
  const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(q)}`;
  const html = await nimbleScrape(searchUrl, { country: "US" });
  const $ = cheerio.load(html);
  const items = [];
  $("div.s-main-slot div[data-component-type='s-search-result']").each((_, el) => {
    const title = $(el).find("h2 a span").text().trim();
    let href = $(el).find("h2 a").attr("href") || "";
    if (href && !href.startsWith("http")) href = "https://www.amazon.com" + href;
    const priceWhole = $(el).find(".a-price-whole").first().text().replace(/[^\d]/g, "");
    const priceFrac = $(el).find(".a-price-fraction").first().text().replace(/[^\d]/g, "");
    const price = priceWhole ? `${priceWhole}.${priceFrac || "00"}` : "";
    const img = $(el).find("img.s-image").attr("src");
    if (title && href) items.push({ source: "amazon", title, price, currency: "USD", image: img, url: href });
  });
  return items.slice(0, 12);
}

// --- SHEIN vía Nimbleway (búsqueda) ---
async function searchSheinNimble(q) {
  const target = `https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`;
  const html = await nimbleScrape(target, { render: true });
  const $ = cheerio.load(html);
  const items = [];
  $("[data-test='product-card'], .S-product-item, .product-card").each((_, el) => {
    const title = $(el).find(".S-product-item__name, .product-title, .S-product-item__info a").first().text().trim();
    const price = $(el).find(".S-product-item__price, .price, .original").first().text().trim();
    let href = $(el).find("a").attr("href") || "";
    let img = $(el).find("img").attr("src") || "";
    if (href && !href.startsWith("http")) href = `https://us.shein.com${href}`;
    if (img && img.startsWith("//")) img = "https:" + img;
    if (title && href) items.push({ source: "shein", title, price, currency: "USD", image: img, url: href });
  });
  return items.slice(0, 12);
}

// --- Helper común con Nimbleway ---
async function nimbleScrape(url, { render = false, country = "US" } = {}) {
  if (!KEY) throw new Error("Falta NIMBLEWAY_KEY");
  const u = `${NIMBLE}?url=${encodeURIComponent(url)}&render=${String(render)}&country=${country}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`Nimbleway error ${r.status}`);
  const data = await r.json().catch(() => ({}));
  return data.html || data.content || "";
}
