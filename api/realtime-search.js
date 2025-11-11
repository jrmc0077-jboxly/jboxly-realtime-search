// api/realtime-search.js
import * as cheerio from "cheerio";

/**
 * ==========================================================
 *  JBOXLY Realtime Search (Amazon + SHEIN) — Vercel Function
 *  - Requiere variables de entorno:
 *      NIMBLE_BASE          (p. ej. https://api.webit.live/api/v1/realtime/web)
 *      NIMBLE_AUTH_HEADER   (p. ej. "Basic dXNlcm5hbWU6cGFzc3dvcmQ=")
 *  - Health check:   ?health=1
 *  - Probe amazon:   ?probe=amazon&q=perfume
 *  - Probe shein:    ?probe=shein&q=perfume
 *  - Mock demo:      ?q=perfume&mock=1
 * ==========================================================
 */

// ---- CORS ----
const ALLOWED_ORIGINS = new Set([
  "https://www.jboxly.com",
  "https://jboxly.com",
  "https://jboxly.myshopify.com",
]);

// ---- Cache simple en memoria (5 min) ----
const cache = new Map();
const TTL = 5 * 60 * 1000;

// ---- Env para Realtime/Web ----
const NIMBLE_BASE = process.env.NIMBLE_BASE;              // ej: https://api.webit.live/api/v1/realtime/web
const NIMBLE_AUTH_HEADER = process.env.NIMBLE_AUTH_HEADER; // ej: "Basic xxxx"

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://www.jboxly.com";
  const cors = {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }

  const { q = "", probe = "", health = "", mock = "" } = req.query;
  const query = String(q || "").trim();

  // ---- Health ----
  if (health) {
    res.writeHead(200, { ...cors, "content-type": "application/json" })
       .end(JSON.stringify({
         ok: true,
         hasBase: Boolean(NIMBLE_BASE),
         hasAuth: Boolean(NIMBLE_AUTH_HEADER)
       }));
    return;
  }

  // ---- Mock demo para ver tarjetas ya en Shopify ----
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
          { render: true, country: "US", locale: "en" }
        );
        const out = inspectAmazon(html);
        res.writeHead(200, { ...cors, "content-type": "application/json" })
           .end(JSON.stringify({ probe, q: query, ...out }));
        return;
      }
      if (probe === "shein") {
        // PSE
        let html1 = "", html2 = "";
        let out1 = { count: 0, sample: [] }, out2 = { count: 0, sample: [] };

        try {
          html1 = await nimbleScrape(
            `https://us.shein.com/pse?keyword=${encodeURIComponent(query)}`,
            { render: true }
          );
          out1 = inspectShein(html1);
        } catch(e){ out1 = { error: String(e?.message || e) }; }

        // Fallback clásico si PSE trae poco
        if (!out1.count || out1.count < 5) {
          try {
            html2 = await nimbleScrape(
              `https://us.shein.com/search?keyword=${encodeURIComponent(query)}`,
              { render: true }
            );
            out2 = inspectShein(html2);
          } catch(e){ out2 = { error: String(e?.message || e) }; }
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
  const html = await nimbleScrape(url, { render: true, country: "US", locale: "en" });
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

/* ============ Nimble Realtime/Web (POST JSON) ============ */
async function nimbleScrape(url, { render = true, country = "US", locale = "en" } = {}) {
  if (!NIMBLE_BASE) throw new Error("Falta NIMBLE_BASE");
  if (!NIMBLE_AUTH_HEADER) throw new Error("Falta NIMBLE_AUTH_HEADER");

  console.log("[JBOXLY] REALTIME MODE ->", NIMBLE_BASE, "auth=Basic?", NIMBLE_AUTH_HEADER.startsWith("Basic"));

  const body = {
    parse: false,
    url,
    format: "html",           // Pedimos HTML crudo para parsearlo con cheerio
    render: Boolean(render),
    country,
    locale
  };

  const r = await fetch(NIMBLE_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": NIMBLE_AUTH_HEADER
    },
    body: JSON.stringify(body)
  });

  const text = await r.text();

  if (!r.ok) {
    console.error("[JBOXLY][NIMBLE_ERR]", r.status, text.slice(0, 300));
    throw new Error(`Realtime ${r.status}: ${text.slice(0,180)}`);
  }

  // Algunos tenants devuelven {html:"..."}, otros {content:"..."}, y a veces HTML plano
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
