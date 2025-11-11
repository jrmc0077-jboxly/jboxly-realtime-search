import fetch from "node-fetch";
import * as cheerio from "cheerio";

const cache = new Map();
const TTL = 5 * 60 * 1000;
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

  const { q = "", probe = "", health = "" } = req.query;
  const query = String(q || "").trim();

  // --- Health check ---
  if (health) {
    res.writeHead(200, { ...cors, "content-type": "application/json" })
       .end(JSON.stringify({ ok: true, hasKey: Boolean(KEY) }));
    return;
  }

  // --- Probes con try/catch para no crashear ---
  if (probe) {
    if (!query) { res.writeHead(200, cors).end(JSON.stringify({ ok: true, note: "faltó q" })); return; }
    try {
      if (probe === "amazon") {
        const html = await nimbleScrape(`https://www.amazon.com/s?k=${encodeURIComponent(query)}&ref=nb_sb_noss`, { render: true, country: "US" });
        const out = inspectAmazon(html);
        res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ probe, q: query, ...out }));
        return;
      }
      if (probe === "shein") {
        const html1 = await nimbleScrape(`https://us.shein.com/pse?keyword=${encodeURIComponent(query)}`, { render: true });
        const out1 = inspectShein(html1);
        let out2 = {};
        if (out1.count < 6) {
          const html2 = await nimbleScrape(`https://us.shein.com/search?keyword=${encodeURIComponent(query)}`, { render: true });
          out2 = inspectShein(html2);
        }
        res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ probe, q: query, pse: out1, classic: out2 }));
        return;
      }
      res.writeHead(400, cors).end(JSON.stringify({ error: "probe inválido" }));
    } catch (e) {
      console.error("[JBOXLY][PROBE] error:", e?.message || e);
      res.writeHead(200, { ...cors, "content-type": "application/json" })
         .end(JSON.stringify({ probe, q: query, error: String(e?.message || e) }));
    }
    return;
  }

  try {
    // ... (tu bloque normal que hace searchAmazon/searchShein y responde items)
  } catch (e) {
    console.error("[JBOXLY] ERROR", e);
    res.writeHead(200, cors).end(JSON.stringify({ items: [] }));
  }
}


/* ------------ AMAZON ------------ */
async function searchAmazon(q){
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
  const html = await nimbleScrape(url, { render: true, country: "US" });
  const $ = cheerio.load(html);
  const out = [];
  $('div.s-main-slot [data-component-type="s-search-result"]').each((_, el) => {
    const title = $(el).find("h2 a span").text().trim();
    let href = $(el).find("h2 a").attr("href") || "";
    if (href && !href.startsWith("http")) href = "https://www.amazon.com" + href;

    let price = $(el).find(".a-price .a-offscreen").first().text().trim();
    if (!price) {
      const pW = $(el).find(".a-price-whole").first().text().replace(/[^\d]/g, "");
      const pF = $(el).find(".a-price-fraction").first().text().replace(/[^\d]/g, "");
      if (pW) price = `${pW}.${pF || "00"}`;
    }
    const img = $(el).find("img.s-image").attr("src");
    if (title && href) out.push({ source: "amazon", title, price, currency: "USD", image: img, url: href });
  });
  return out.slice(0, 12);
}
function inspectAmazon(html){
  const $ = cheerio.load(html);
  const nodes = $('div.s-main-slot [data-component-type="s-search-result"]');
  const sample = [];
  nodes.slice(0,3).each((_,el)=> sample.push( $(el).find("h2 a span").text().trim().slice(0,80) ));
  return { count: nodes.length, sample };
}

/* ------------ SHEIN ------------ */
async function searchShein(q){
  const list = [];
  try {
    const html1 = await nimbleScrape(`https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`, { render: true });
    list.push(...parseShein(html1));
  } catch(e){ console.warn("[JBOXLY] shein pse fail", e?.message); }
  if (list.length < 8) {
    try {
      const html2 = await nimbleScrape(`https://us.shein.com/search?keyword=${encodeURIComponent(q)}`, { render: true });
      list.push(...parseShein(html2));
    } catch(e){ console.warn("[JBOXLY] shein classic fail", e?.message); }
  }
  const seen = new Set(), out = [];
  for (const it of list) {
    const k = it.url || it.title;
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
    if (out.length >= 12) break;
  }
  return out;
}
function parseShein(html){
  const $ = cheerio.load(html);
  const items = [];
  $("[data-test='product-card'], .S-product-item, .product-card").each((_, el) => {
    const title = $(el).find(".S-product-item__name, .product-title, .S-product-item__info a").first().text().trim();
    const price = $(el).find(".S-product-item__price, .price, .original, .sale-price").first().text().trim();
    let href = $(el).find("a").attr("href") || "";
    let img = $(el).find("img").attr("src") || "";
    if (href && !href.startsWith("http")) href = `https://us.shein.com${href}`;
    if (img && img.startsWith("//")) img = "https:" + img;
    if (title && href) items.push({ source: "shein", title, price, currency: "USD", image: img, url: href });
  });
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

/* ------------ Helper Nimble (residencial + rotación) ------------ */
async function nimbleScrape(url, { render = false, country = "US" } = {}) {
  if (!KEY) throw new Error("Falta NIMBLEWAY_KEY");
  const params = new URLSearchParams({
    url,
    render: String(render),
    country,
    proxy_type: "residential",
    rotate: "true"
  });
  const r = await fetch(`${NIMBLE}?${params}`, { headers: { Authorization: `Bearer ${KEY}` } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { html: text }; }
  if (!r.ok) throw new Error(`Nimbleway error ${r.status} ${data?.error || ""}`);
  return data.html || data.content || "";
}
