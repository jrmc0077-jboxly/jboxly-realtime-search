// api/realtime-search.js
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = (req.query.q || "").toString().trim();
  const probe = (req.query.probe || "").toString().trim().toLowerCase();
  const HEALTH = "health" in req.query;

  const NIMBLE_BASE = process.env.NIMBLE_BASE || "";
  const NIMBLE_AUTH = process.env.NIMBLE_AUTH_HEADER || "";

  // --- Health ---
  if (HEALTH) {
    return res.status(200).json({ ok: true, hasBase: !!NIMBLE_BASE, hasAuth: !!NIMBLE_AUTH });
  }

  // --- DEMO INSTANTÁNEO (mock) ---
  if (req.query.mock === "1") {
    const kw = q || "demo";
    const sources = ["amazon","shein"];
    const items = Array.from({length: 12}).map((_, i) => ({
      source: sources[i % sources.length],
      title: `${kw} — Producto demo ${i + 1}`,
      price: (19.99 + i).toFixed(2),
      currency: "USD",
      image: "https://via.placeholder.com/600x450?text=JBOXLY",
      url: "https://example.com"
    }));
    return res.status(200).json({ ok: true, mock: true, count: items.length, items });
  }

  if (!NIMBLE_BASE || !NIMBLE_AUTH) {
    return res.status(500).json({ ok: false, error: "Nimble not configured" });
  }

  // -------- PROBES útiles --------
  if (probe === "echo") {
    try {
      const html = await nimbleFetch("https://example.com/", { render: true });
      return res.status(200).json({ ok: true, source: "echo", len: html.length, head: html.slice(0,120) });
    } catch (e) {
      return res.status(502).json({ ok: false, source: "echo", error: String(e?.message || e) });
    }
  }

  if (probe === "amazon") {
    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });
    try {
      const url = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
      // Amazon MÁS ESTABLE: sin render
      const html = await nimbleFetch(url, { render: false, country: "US", locale: "en" });
      let items = parseAmazon(html);
      if (items.length === 0) {
        // reintento con render por si tocó layout raro
        const html2 = await nimbleFetch(url, { render: true, country: "US", locale: "en" });
        items = parseAmazon(html2);
      }
      return res.status(200).json({ ok: true, source: "amazon", target: url, count: items.length, items });
    } catch (e) {
      return res.status(504).json({ ok: false, source: "amazon", error: String(e?.message || e) });
    }
  }

  if (probe === "shein") {
    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });
    try {
      let list = [];
      // PSE (render true)
      try {
        const html1 = await nimbleFetch(`https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`, { render: true });
        list = list.concat(parseShein(html1));
      } catch {}
      // clásico si poco/timeout
      if (list.length < 6) {
        try {
          const html2 = await nimbleFetch(`https://us.shein.com/search?keyword=${encodeURIComponent(q)}`, { render: true });
          list = list.concat(parseShein(html2));
        } catch {}
      }
      // dedup + top 24
      const seen = new Set(), out = [];
      for (const it of list) {
        const k = it.url || it.title;
        if (!k || seen.has(k)) continue;
        seen.add(k); out.push(it);
        if (out.length >= 24) break;
      }
      return res.status(200).json({ ok: true, source: "shein", count: out.length, items: out });
    } catch (e) {
      return res.status(504).json({ ok: false, source: "shein", error: String(e?.message || e) });
    }
  }

  // -------- ENDPOINT NORMAL: mezcla Amazon + Shein --------
  if (!q) return res.status(400).json({ ok: false, error: "Missing q" });
  try {
    const urlA = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&ref=nb_sb_noss`;
    const [htmlA, htmlS] = await Promise.allSettled([
      nimbleFetch(urlA, { render: false, country: "US", locale: "en" }), // Amazon sin render = más estable
      nimbleFetch(`https://us.shein.com/pse?keyword=${encodeURIComponent(q)}`, { render: true })
    ]);

    let items = [];
    if (htmlA.status === "fulfilled") items = items.concat(parseAmazon(htmlA.value));
    if (htmlS.status === "fulfilled") items = items.concat(parseShein(htmlS.value));

    // Fallback SHEIN clásico si sigue bajo
    if (items.filter(x=>x.source==="shein").length < 6) {
      try {
        const html2 = await nimbleFetch(`https://us.shein.com/search?keyword=${encodeURIComponent(q)}`, { render: true });
        items = items.concat(parseShein(html2));
      } catch {}
    }

    // dedup + top 24
    const seen = new Set(), out = [];
    for (const it of items) {
      const k = it.url || it.title;
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(it);
      if (out.length >= 24) break;
    }
    return res.status(200).json({ ok: true, count: out.length, items: out });
  } catch (e) {
    return res.status(504).json({ ok: false, error: "Upstream timeout or error" });
  }
}

/* ================= Nimble helper (Realtime/Web) ================= */

async function nimbleFetch(url, { render = true, country = "US", locale = "en" } = {}) {
  const BASE = process.env.NIMBLE_BASE;
  const AUTH = process.env.NIMBLE_AUTH_HEADER;

  const once = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000); // 35s
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
      let data; try { data = JSON.parse(text); } catch { data = { html: text }; }
      const html = typeof data === "string" ? data : (data.html || data.content || "");
      if (!html || html.length < 400) throw new Error("Empty HTML");
      console.log("[JBOXLY] fetched OK len:", html.length, "url:", url.slice(0,120), "render:", render);
      return html;
    } catch (e) {
      clearTimeout(timer);
      console.log("[JBOXLY] fetch error:", String(e?.message || e));
      throw e;
    }
  };

  let attempt = 0;
  let last;
  while (attempt < 3) { // 3 intentos con backoff
    try {
      return await once();
    } catch (e) {
      last = e;
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, backoff));
      attempt++;
    }
  }
  throw last || new Error("Nimble upstream error");
}

/* ======================== Parsers ======================== */

// AMAZON — selectores + ld+json + fallback /dp/
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

    let price = $el.find(".a-price .a-offscreen").first().text().trim();
    if (!price) {
      const whole = $el.find(".a-price-whole").first().text().replace(/[^\d]/g,"");
      const frac  = $el.find(".a-price-fraction").first().text().replace(/[^\d]/g,"");
      if (whole) price = `${whole}.${frac || "00"}`;
    }
    const currency = price ? "$" : "";

    if (title && href) out.push({ source: "amazon", title, url: href, image: img, price, currency, asin });
  });

  // Variante secundaria
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

  // Fallback desde ld+json
  if (out.length === 0) {
    const scripts = $("script[type='application/ld+json']").map((_, el) => $(el).html() || "").get();
    for (const s of scripts) {
      try {
        const data = JSON.parse(s);
        const push = (d) => {
          if (d && d.name && d.url) out.push({
            source: "amazon",
            title: d.name,
            url: d.url.startsWith("http") ? d.url : `https://www.amazon.com${d.url}`,
            image: Array.isArray(d.image) ? d.image[0] : (d.image || ""),
            price: d.offers?.price || "",
            currency: d.offers?.priceCurrency || "$"
          });
        };
        if (Array.isArray(data)) data.forEach(push); else push(data);
      } catch {}
    }
  }

  // Fallback genérico /dp/
  if (out.length === 0) {
    const seen = new Set();
    $("a[href*='/dp/']").each((_, a) => {
      let href = $(a).attr("href") || "";
      if (!href) return;
      if (href.startsWith("/")) href = "https://www.amazon.com" + href;
      if (!href.includes("/dp/")) return;
      if (seen.has(href)) return;
      seen.add(href);

      const title = ($(a).text() || "").trim();
      if (!title) return;

      let $box = $(a).closest("div");
      let img = $box.find("img").attr("src") || "";
      const nearText = ($box.text() || "");
      const m = nearText.match(/\$[0-9]+(?:\.[0-9]{2})?/);
      const price = m ? m[0] : "";
      const currency = price ? "$" : "";

      out.push({ source: "amazon", title, url: href, image: img, price, currency });
    });
  }

  return out.slice(0, 24);
}

// SHEIN — JSON (goods_list) + DOM + fallback /item/
function parseShein(html) {
  const $ = cheerio.load(html);
  const out = [];

  const jsonArr = extractJSONArray(html, /"goods_list"\s*:\s*(\[[\s\S]*?\])/)
               || extractJSONArray(html, /"goodsList"\s*:\s*(\[[\s\S]*?\])/);
  if (Array.isArray(jsonArr)) {
    for (const g of jsonArr) {
      const title = (g.goods_name || g.goodsName || "").toString().trim();
      const goodsId = g.goods_id || g.goodsId;
      let url = g.detail_url || g.goods_url || (goodsId ? `https://us.shein.com/item/${goodsId}.html` : "");
      let image = g.goods_img || g.goodsImg || g.goods_thumb || "";
      if (image && image.startsWith("//")) image = "https:" + image;
      let price = String(g.sale_price || g.salePrice || "");
      const currency = g.currency || (price ? "$" : "");
      if (title && url) out.push({ source: "shein", title, url, image, price, currency });
    }
  }

  if (out.length === 0) {
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

  if (out.length === 0) {
    const seen = new Set();
    $("a[href*='/item/']").each((_, a) => {
      let href = $(a).attr("href") || "";
      if (href.startsWith("/")) href = "https://us.shein.com" + href;
      if (!href.includes("/item/")) return;
      if (seen.has(href)) return;
      seen.add(href);

      const title = ($(a).text() || "").trim();
      if (!title) return;

      let $box = $(a).closest("div");
      let image = $box.find("img").attr("src") || "";
      if (image && image.startsWith("//")) image = "https:" + image;

      const nearText = $box.text() || "";
      const m = nearText.match(/\$[0-9]+(?:\.[0-9]{2})?/);
      const price = m ? m[0].replace(/^\$/, "") : "";
      const currency = price ? "$" : "";

      out.push({ source: "shein", title, url: href, image, price, currency });
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
