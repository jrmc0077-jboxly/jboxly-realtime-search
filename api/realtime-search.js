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

  // Construye la URL a scrapear
  let target = "";
  let source = "";
  if (probe === "shein") {
    target = `https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`;
    source = "shein";
  } else if (probe === "amazon") {
    target = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
    source = "amazon";
  } else {
    // por defecto Amazon
    target = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
    source = "amazon";
  }

  // Timeout de 9s para no colgarnos si el upstream se demora
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  // Para Shein muchas veces conviene render=true; Amazon mejor render=false
  const render = source === "shein";

  const payload = {
    parse: false,
    url: target,
    format: "json",
    country: "US",
    locale: "en",
    render
  };

  try {
    console.log("[JBOXLY] REALTIME MODE ->", NIMBLE_BASE, "auth=Basic?", !!NIMBLE_AUTH, "target:", target, "render:", render);
    const r = await fetch(NIMBLE_BASE, {
      method: "POST",
      headers: {
        "Authorization": NIMBLE_AUTH,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await r.text();
    clearTimeout(timer);

    if (!r.ok) {
      console.log("[JBOXLY][NIMBLE_ERR]", r.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Nimble ${r.status}`, body: text.slice(0, 500) });
    }

    console.log("[JBOXLY] fetched OK len:", text.length);

    // Parseo según origen
    let items = [];
    if (source === "amazon") {
      items = inspectAmazon(text);
    } else if (source === "shein") {
      items = inspectShein(text);
    }

    return res.status(200).json({
      ok: true,
      source,
      target,
      rawLen: text.length,
      count: items.length,
      items
    });

  } catch (err) {
    clearTimeout(timer);
    console.log("[JBOXLY][TIMEOUT/ERR]", String(err?.message || err));
    return res.status(504).json({ ok: false, error: "Upstream timeout or error" });
  }
}

/* ------------------ Parsers ------------------ */

// Amazon HTML: usa selectores s-result-item
function inspectAmazon(html) {
  const $ = cheerio.load(html);
  const out = [];
  $("div.s-result-item[data-component-type='s-search-result']").each((_, el) => {
    const $el = $(el);
    const title = $el.find("h2 a span").first().text().trim();
    let url = $el.find("h2 a").attr("href") || "";
    if (url && url.startsWith("/")) url = "https://www.amazon.com" + url;
    const image = $el.find("img.s-image").attr("src") || "";

    // precio (no siempre está)
    const whole = $el.find("span.a-price-whole").first().text().replace(/[^\d.,]/g, "");
    const frac  = $el.find("span.a-price-fraction").first().text().replace(/[^\d]/g, "");
    const price = whole ? (whole + (frac ? "." + frac : "")) : "";
    const currency = whole ? "$" : "";

    if (title && url) {
      out.push({ title, url, image, price, currency, source: "amazon" });
    }
  });
  return out;
}

// SHEIN (PSE + clásico): extrae goods_list JSON embebido
function inspectShein(html) {
  // intenta encontrar "goods_list" en el HTML
  const goods = extractJSONArray(html, /"goods_list"\s*:\s*(\[[\s\S]*?\])/)
             || extractJSONArray(html, /"goodsList"\s*:\s*(\[[\s\S]*?\])/);

  const out = [];
  if (Array.isArray(goods)) {
    for (const g of goods) {
      const title = (g.goods_name || g.goodsName || "").toString().trim();
      const goodsId = g.goods_id || g.goodsId;
      let url = "";
      if (g.detail_url) url = g.detail_url;
      else if (goodsId) url = `https://us.shein.com/item/${goodsId}.html`;
      else if (g.goods_url) url = g.goods_url;

      const image = g.goods_img || g.goodsImg || g.goods_thumb || "";
      let price = "";
      let currency = "$";
      if (g.sale_price || g.salePrice) price = String(g.sale_price || g.salePrice);
      if (g.currency) currency = g.currency;

      if (title && (url || goodsId)) {
        out.push({ title, url, image, price, currency, source: "shein" });
      }
    }
  } else {
    // fallback simple: intentar leer tarjetas básicas si existieran
    const $ = cheerio.load(html);
    $(".product-list .S-product-item, .S-product-item").each((_, el) => {
      const $el = $(el);
      const title = $el.find(".S-product-item__name, .product-name").first().text().trim();
      let url = $el.find("a").attr("href") || "";
      const image = $el.find("img").attr("src") || "";
      const price = $el.find(".S-product-item__price-current, .price-current").first().text().replace(/[^\d.,]/g, "");
      const currency = price ? "$" : "";
      if (url && url.startsWith("/")) url = "https://us.shein.com" + url;
      if (title && url) out.push({ title, url, image, price, currency, source: "shein" });
    });
  }

  return out;
}

// helper: captura un array JSON por regex y lo parsea seguro
function extractJSONArray(html, regex) {
  try {
    const m = html.match(regex);
    if (!m) return null;
    const raw = m[1];
    // balanceo simple de brackets por si hay nested
    const arr = JSON.parse(balanceBrackets(raw));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// intenta cerrar bien brackets en caso de cortes
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
