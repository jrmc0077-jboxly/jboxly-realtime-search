// api/realtime-search.js
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = (req.query.q || "").toString().trim();
  const probe = (req.query.probe || "").toString().trim().toLowerCase();
  const HEALTH = "health" in req.query;

  const NIMBLE_BASE = process.env.NIMBLE_BASE || "";
  const NIMBLE_AUTH = process.env.NIMBLE_AUTH_HEADER || "";

  if (HEALTH) {
    return res.status(200).json({
      ok: true,
      hasBase: !!NIMBLE_BASE,
      hasAuth: !!NIMBLE_AUTH,
    });
  }

  if (!q) return res.status(400).json({ ok: false, error: "Missing q" });
  if (!NIMBLE_BASE || !NIMBLE_AUTH) {
    return res.status(500).json({ ok: false, error: "Nimble not configured" });
  }

  // Seleccionar destino
  let target = "";
  let source = "";
  if (probe === "shein") {
    target = `https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`;
    source = "shein";
  } else if (probe === "amazon") {
    target = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
    source = "amazon";
  } else {
    target = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
    source = "amazon";
  }

  try {
    let items = [];
    if (source === "amazon") {
      const html = await nimbleFetch(target, { render: true, country: "US", locale: "en" });
      items = parseAmazon(html);
      // Fallback: si no encontró nada, reintenta con render otra vez (a veces llega layout alterno)
      if (items.length === 0) {
        const html2 = await nimbleFetch(target, { render: true, country: "US", locale: "en" });
        items = parseAmazon(html2);
      }
      return res.status(200).json({ ok: true, source, target, count: items.length, items });
    }

    if (source === "shein") {
      // 1) PSE
      let html = "", list = [];
      try {
        html = await nimbleFetch(`https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`, { render: true });
        list = parseShein(html);
      } catch {}
      // 2) Fallback clásico si muy pocos o timeout
      if (list.length < 6) {
        try {
          const html2 = await nimbleFetch(`https://us.shein.com/search?keyword=${encodeURIComponent(q)}`, { render: true });
          list = list.concat(parseShein(html2));
        } catch {}
      }
      // Dedup + limitar
      const seen = new Set();
      const out = [];
      for (const it of list) {
        const key = it.url || it.title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(it);
        if (out.length >= 24) break;
      }
      return res.status(200).json({ ok: true, source, target, count: out.length, items: out });
    }

    return res.status(400).json({ ok: false, error: "Invalid source" });

  } catch (err) {
    console.log("[JBOXLY][ERR]", String(err?.message || err));
    return res.status(504).json({ ok: false, error: "Upstream timeout or error" });
  }
}

/* ================= Nimble helper (Realtime/Web) ================= */

async function nimbleFetch(url, { render = true, country = "US", locale = "en" } = {}) {
  const BASE = process.env.NIMBLE_BASE;
  const AUTH = process.env.NIMBLE_AUTH_HEADER;

  // Timeout 15s + 1 reintento rápido
  const fetchOnce = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(BASE, {
        method: "POST",
        headers: {
          "Authorization": AUTH,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          parse: false,
          url,
          format: "html",
          render,
          country,
          locale
        }),
        signal: controller.signal
      });
      const text = await r.text();
      clearTimeout(timer);
      if (!r.ok) throw new Error(`Nimble ${r.status}: ${text.slice(0,200)}`);
      // Puede venir {html:"..."} o HTML plano
      let data; try { data = JSON.parse(text); } catch { data = { html: text }; }
      const html = typeof data === "string" ? data : (data.html || data.content || "");
      if (!html || html.length < 400) throw new Error("Empty HTML");
      console.log("[JBOXLY] fetched OK len:", html.length);
      return html;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  };

  try {
    return await fetchOnce();
  } catch (e) {
    console.log("[JBOXLY] retrying after error:", String(e?.message || e));
    return await fetchOnce();
  }
}

/* ======================== Parsers ======================== */

// AMAZON — múltiples selectores + fallback desde JSON embebido
function parseAmazon(html) {
  const $ = cheerio.load(html);
  const out = [];

  // Variante principal
  $("div.s-main-slot div.s-result-item[data-asin]").each((_, el) => {
    const $el = $(el);
    const asin = $el.attr("data-asin");
    const title = $el.find("h2 a span").first().text().trim();
    let href = $el.find("h2 a").attr("href") || "";
    if (href && href.startsWith("/")) href = "https://www.amazon.com" + href;
    const img = $el.find("img.s-image").attr("src") || "";

    // precio: hay varias estructuras
    let price = $el.find(".a-price .a-offscreen").first().text().trim();
    if (!price) {
      const whole = $el.find(".a-price-whole").first().text().replace(/[^\d]/g,"");
      const frac  = $el.find(".a-price-fraction").first().text().replace(/[^\d]/g,"");
      if (whole) price = `${whole}.${frac || "00"}`;
    }
    const currency = price ? "$" : "";

    if (title && href) out.push({ source: "amazon", title, url: href, image: img, price, currency, asin });
  });

  // Variante secundaria (tarjeta compacta)
  if (out.length === 0) {
    $("div.s-card-container, div.s-result-card").each((_, el) => {
      const $el = $(el);
      const title = $el.find("h2 a span, a.a-text-normal span").first().text().trim();
      let href = $el.find("h2 a, a.a-link-normal").attr("href") || "";
      if (href && href.startsWith("/")) href = "https://www.amazon.com" + href;
      const img = $el.find("img.s-image, img").attr("src") || "";
      let price = $el.find(".a-price .a-offscreen").first().text().trim();
      if (!price) {
        const whole = $el.find(".a-price-whole").first().text().replace(/[^\d]/g,"");
        const frac  = $el.find(".a-price-fraction").first().text().replace(/[^\d]/g,"");
        if (whole) price = `${whole}.${frac || "00"}`;
      }
      const currency = price ? "$" : "";
      if (title && href) out.push({ source: "amazon", title, url: href, image: img, price, currency });
    });
  }

  // Fallback desde JSON embebido (cuando hay un descriptor)
  if (out.length === 0) {
    const scriptJSON = $("script[type='application/ld+json']").map((_, el) => $(el).html() || "").get().join("\n");
    try {
      const blocks = scriptJSON.split("\n").map(s => s.trim()).filter(Boolean);
      for (const b of blocks) {
        try {
          const data = JSON.parse(b);
          if (Array.isArray(data)) {
            for (const d of data) {
              if (d && d.name && d.url) {
                out.push({
                  source: "amazon",
                  title: d.name,
                  url: d.url,
                  image: d.image || "",
                  price: d.offers?.price || "",
                  currency: d.offers?.priceCurrency || "$"
                });
              }
            }
          } else if (data && data.name && data.url) {
            out.push({
              source: "amazon",
              title: data.name,
              url: data.url,
              image: data.image || "",
              price: data.offers?.price || "",
              currency: data.offers?.priceCurrency || "$"
            });
          }
        } catch {}
      }
    } catch {}
  }

  return out.slice(0, 24);
}

// SHEIN — intenta JSON embebido (goods_list) y fallback DOM
function parseShein(html) {
  const out = [];

  // JSON embebido
  const jsonArr = extractJSONArray(html, /"goods_list"\s*:\s*(\[[\s\S]*?\])/)
               || extractJSONArray(html, /"goodsList"\s*:\s*(\[[\s\S]*?\])/);
  if (Array.isArray(jsonArr)) {
    for (const g of jsonArr) {
      const title = (g.goods_name || g.goodsName || "").toString().trim();
      const goodsId = g.goods_id || g.goodsId;
      let url = g.detail_url || g.goods_url || (goodsId ? `https://us.shein.com/item/${goodsId}.html` : "");
      let image = g.goods_img || g.goodsImg || g.goods_thumb || "";
      let price = String(g.sale_price || g.salePrice || "");
      const currency = g.currency || (price ? "$" : "");
      if (image && image.startsWith("//")) image = "https:" + image;
      if (title && url) out.push({ source: "shein", title, url, image, price, currency });
    }
  }

  // Fallback DOM si no hubo JSON
  if (out.length === 0) {
    const $ = cheerio.load(html);
    $(".S-product-item, .product-card, .c-product-card").each((_, el) => {
      const $el = $(el);
      const title = $el.find(".S-product-item__name, .product-title, .c-product-card__name").first().text().trim();
      let url = $el.find("a").attr("href") || "";
      if (url && url.startsWith("/")) url = "https://us.shein.com" + url;
      let image = $el.find("img").attr("src") || "";
      if (image && image.startsWith("//")) image = "https:" + image;
      const priceText = $el.find(".S-product-item__price, .price, .sale-price, .c-product-card__price").first().text().trim();
      const price = priceText.replace(/[^\d.,]/g, "");
      const currency = price ? "$" : "";
      if (title && url) out.push({ source: "shein", title, url, image, price, currency });
    });
  }

  return out.slice(0, 24);
}

/* ============== JSON array extractor helpers ============== */
function extractJSONArray(html, regex) {
  try {
    const m = html.match(regex);
    if (!m) return null;
    const raw = balanceBrackets(m[1]);
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
function balanceBrackets(str) {
  let open = 0, out = "";
  for (const ch of str) {
    if (ch === "[") open++;
    if (ch === "]") open--;
    out += ch;
    if (open === 0) break;
  }
  return out;
}
