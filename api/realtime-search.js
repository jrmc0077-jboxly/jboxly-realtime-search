import * as cheerio from "cheerio";

// ====== Config ======
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

  const { q = "", probe = "", health = "", mock = "" } = req.query;
  const query = String(q || "").trim();

  // ---- Health: verifica que la KEY está en runtime ----
  if (health) {
    res.writeHead(200, { ...cors, "content-type": "application/json" })
       .end(JSON.stringify({ ok: true, hasKey: Boolean(KEY) }));
    return;
  }

  // ---- Modo demo para probar el front YA ----
  if (mock === "1") {
    const items = Array.from({ length: 8 }).map((_, i) => ({
      source: "mock",
      title: `Producto demo ${i + 1}`,
      price: (19.99 + i).toFixed(2),
      currency: "USD",
      image: "https://via.placeholder.com/400x300?text=Demo",
      url: "https://example.com"
    }));
    res.writeHead(200, cors).end(JSON.stringify({ items }));
    return;
  }

  // ---- Probes de diagnóstico (no deben crashear) ----
  if (probe) {
    if (!query) { res.writeHead(200, cors).end(JSON.stringify({ ok: true, note: "faltó q" })); return; }
    try {
      if (probe === "amazon") {
        const html = await nimbleScrape(
          `https://www.amazon.com/s?k=${encodeURIComponent(query)}&ref=nb_sb_noss`,
          { render: true, country: "US" }
        );
        const out = inspectAmazon(html);
        res.writeHead(200, { ...cors, "content-type": "application/json" })
           .end(JSON.stringify({ probe, q: query, ...out }));
        return;
      }
      if (probe === "shein") {
        const html1 = await nimbleScrape(
          `https://us.shein.com/pse?keyword=${encodeURIComponent(query)}`,
          { render: true }
        );
        const out1 = inspectShein(html1);
        let out2 = {};
        if (out1.count < 6) {
          const html2 = await nimbleScrape(
            `https://us.shein.com/search?keyword=${encodeURIComponent(query)}`,
            { render: true }
          );
          out2 = inspectShein(html2);
        }
        res.writeHead(200, { ...cors, "content-type": "application/json" })
           .end(JSON.stringify({ probe, q: query, pse: out1, classic: out2 }));
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

  // ---- Endpoint normal ----
  try {
    if (!query) { res.writeHead(200, cors).end(JSON.stringify({ items: [] })); return; }

    const key = `search:${query.toLowerCase()}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.t < TTL) {
      res.writeHead(200, cors).end(JSON.stringify(hit.data));
      return;
    }

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

/* =================== AMAZON =================== */
async function searchAmazon(q) {
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

  console.log("[JBOXLY] amazon nodes:", out.length);
  return out.slice(0, 12);
}
function inspectAmazon(html){
  const $ = cheerio.load(html);
  const nodes = $('div.s-main-slot [data-component-type="s-search-result"]');
  const sample = [];
  nodes.slice(0,3).each((_,el)=> sample.push( $(el).find("h2 a span").text().trim().slice(0,80) ));
  return { count: nodes.length, sample };
}

/* =================== SHEIN =================== */
async function searchShein(q){
  const list = [];

  try {
    const html1 = await nimbleScrape(
      `https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`,
      { render: true }
    );
    list.push(...parseShein(html1));
  } catch(e){ console.warn("[JBOXLY] shein pse fail", e?.message); }

  if (list.length < 8) {
    try {
      const html2 = await nimbleScrape(
        `https://us.shein.com/search?keyword=${encodeURIComponent(q)}`,
        { render: true }
      );
      list.push(...parseShein(html2));
    } catch(e){ console.warn("[JBOXLY] shein classic fail", e?.message); }
  }

  // dedup
  const seen = new Set(), out = [];
  for (const it of list) {
    const k = it.url || it.title;
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
    if (out.length >= 12) break;
  }
  console.log("[JBOXLY] shein total dedup:", out.length);
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

/* ============ Helper Nimble (residencial + rotación) ============ */
async function nimbleScrape(url, { render = true, country = "US", locale = "en" } = {}) {
  const BASE = process.env.NIMBLE_BASE;            // ej: https://api.webit.live/api/v1/realtime/web
  const AUTH = process.env.NIMBLE_AUTH_HEADER;     // ej: "Basic abc123..."

  if (!BASE) throw new Error("Falta NIMBLE_BASE");
  if (!AUTH) throw new Error("Falta NIMBLE_AUTH_HEADER");

  // Log seguro (no imprime secretos)
  console.log("[JBOXLY] REALTIME MODE ->", BASE, "auth=Basic?", AUTH.startsWith("Basic"));

  const body = {
    parse: false,
    url,
    format: "html",          // pedimos HTML crudo
    render: Boolean(render),
    country,
    locale
  };

  const r = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": AUTH
    },
    body: JSON.stringify(body)
  });

  const text = await r.text();

  if (!r.ok) {
    console.error("[JBOXLY][NIMBLE_ERR]", r.status, text.slice(0, 300));
    throw new Error(`Realtime ${r.status}: ${text.slice(0,180)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch { data = { html: text }; }

  const html =
    typeof data === "string" ? data :
    data.html || data.content || "";

  if (!html || html.length < 400) {
    console.warn("[JBOXLY] Realtime HTML corto. len=", (html||"").length, "rawHead=", text.slice(0,120));
    throw new Error("Realtime devolvió HTML vacío o muy corto");
  }

  console.log("[JBOXLY] fetched OK (realtime/web) len:", html.length);
  return html;
}
