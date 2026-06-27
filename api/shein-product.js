// /api/shein-product.js
// Endpoint para obtener detalle de un producto Shein
// Uso: /api/shein-product?url=https://us.shein.com/PRODUCTO.html
// O:   /api/shein-product?goods_id=12345678

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  const { url, goods_id, debug } = req.query;

  if (!url && !goods_id) {
    return res.status(400).json({ error: 'Missing "url" or "goods_id" parameter' });
  }

  const user = process.env.OXYLABS_USER;
  const pass = process.env.OXYLABS_PASS;

  if (!user || !pass) {
    return res.status(500).json({ error: 'Oxylabs credentials not configured' });
  }

  // Construir URL del producto
  let productUrl = url;
  if (!productUrl && goods_id) {
    productUrl = `https://us.shein.com/p-${goods_id}.html`;
  }

  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  try {
    const response = await fetch('https://realtime.oxylabs.io/v1/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: JSON.stringify({
        source: 'universal',
        url: productUrl,
        render: 'html',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Oxylabs error', status: response.status, detail: text.slice(0, 500) });
    }

    const data = await response.json();
    const html = data.results?.[0]?.content || '';

    if (!html) {
      return res.status(502).json({ error: 'Empty response from Oxylabs' });
    }

    // Modo debug: devuelve diagnósticos
    if (debug === '1') {
      return res.status(200).json({
        url: productUrl,
        htmlLength: html.length,
        diagnostic: {
          hasProductDetail: html.includes('productDetail') || html.includes('product-detail'),
          hasGoodsName: html.includes('"goods_name"'),
          hasPriceUSD: (html.match(/\$\d+\.\d{2}/g) || []).slice(0, 5),
          hasSize: html.includes('"size_list"') || html.includes('"attr_value"'),
          hasColor: html.includes('"color_attr"') || html.includes('related_color'),
          hasImages: html.includes('"goods_img"') || html.includes('"image_list"'),
          hasDescription: html.includes('"description"') || html.includes('"goods_desc"'),
          firstScript: extractFirstProductScript(html),
        },
      });
    }

    // Modo normal: parsear el detalle del producto
    const product = parseSheinProductDetail(html);

    return res.status(200).json({
      url: productUrl,
      product,
    });

  } catch (error) {
    return res.status(500).json({ error: 'Internal error', message: error.message });
  }
}

function extractFirstProductScript(html) {
  // Buscar el script que contenga la info del producto
  const regex = /<script[^>]*>([\s\S]*?goods_name[\s\S]*?)<\/script>/g;
  const match = regex.exec(html);
  if (match) {
    return match[1].slice(0, 800);
  }
  return null;
}

function parseSheinProductDetail(html) {
  const product = {
    title: '',
    price: '',
    originalPrice: '',
    images: [],
    description: '',
    sizes: [],
    colors: [],
    rating: 0,
    reviewsCount: 0,
    goods_id: '',
    goods_sn: '',
  };

  try {
    // Título
    const titleMatch = html.match(/"goods_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) product.title = unescapeJson(titleMatch[1]);

    // Precio actual
    const priceMatch = html.match(/"salePrice"\s*:\s*\{[^}]*"amountWithSymbol"\s*:\s*"([^"]+)"/) ||
                       html.match(/"amountWithSymbol"\s*:\s*"(\$\d+\.\d{2})"/);
    if (priceMatch) product.price = priceMatch[1];

    // Precio original (tachado)
    const oldPriceMatch = html.match(/"retailPrice"\s*:\s*\{[^}]*"amountWithSymbol"\s*:\s*"([^"]+)"/);
    if (oldPriceMatch) product.originalPrice = oldPriceMatch[1];

    // IDs
    const goodsIdMatch = html.match(/"goods_id"\s*:\s*"?(\d+)"?/);
    if (goodsIdMatch) product.goods_id = goodsIdMatch[1];

    const goodsSnMatch = html.match(/"goods_sn"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (goodsSnMatch) product.goods_sn = unescapeJson(goodsSnMatch[1]);

    // Imágenes (galería)
    const imageRegex = /"origin_image"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let imgMatch;
    const seenImages = new Set();
    while ((imgMatch = imageRegex.exec(html)) !== null && product.images.length < 8) {
      let img = unescapeJson(imgMatch[1]);
      if (img.startsWith('//')) img = 'https:' + img;
      if (!seenImages.has(img) && img.length > 20) {
        seenImages.add(img);
        product.images.push(img);
      }
    }

    // Si no encontró origin_image, probar goods_img
    if (product.images.length === 0) {
      const fallbackRegex = /"goods_img"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      while ((imgMatch = fallbackRegex.exec(html)) !== null && product.images.length < 8) {
        let img = unescapeJson(imgMatch[1]);
        if (img.startsWith('//')) img = 'https:' + img;
        if (!seenImages.has(img) && img.length > 20) {
          seenImages.add(img);
          product.images.push(img);
        }
      }
    }

    // Descripción
    const descMatch = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.){10,2000})"/) ||
                      html.match(/"goods_desc"\s*:\s*"((?:[^"\\]|\\.){10,2000})"/);
    if (descMatch) product.description = unescapeJson(descMatch[1]);

    // Tallas - Shein usa "attr_value_name" dentro de "size_attr"
    const sizesSet = new Set();
    const sizeRegex = /"attr_name"\s*:\s*"Size"[\s\S]{0,5000}?"attr_value_list"\s*:\s*(\[[\s\S]*?\])/;
    const sizeListMatch = html.match(sizeRegex);
    if (sizeListMatch) {
      try {
        const arr = JSON.parse(sizeListMatch[1]);
        for (const item of arr) {
          const name = item.attr_value_name || item.attr_value || '';
          if (name) sizesSet.add(name);
        }
      } catch (e) {}
    }
    // Fallback: buscar cualquier attr_value_name
    if (sizesSet.size === 0) {
      const sizeFallback = /"attr_value_name_en"\s*:\s*"((?:XS|S|M|L|XL|XXL|XXXL|\d+)[^"]{0,5})"/g;
      let sm;
      while ((sm = sizeFallback.exec(html)) !== null && sizesSet.size < 15) {
        sizesSet.add(sm[1]);
      }
    }
    product.sizes = Array.from(sizesSet).slice(0, 15);

    // Colores
    const colorsSet = new Set();
    const colorRegex = /"goods_color_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let cm;
    while ((cm = colorRegex.exec(html)) !== null && colorsSet.size < 10) {
      const colorName = unescapeJson(cm[1]);
      if (colorName) colorsSet.add(colorName);
    }
    product.colors = Array.from(colorsSet);

    // Rating
    const ratingMatch = html.match(/"comment_rank_average"\s*:\s*"?([\d.]+)"?/);
    if (ratingMatch) product.rating = parseFloat(ratingMatch[1]);

    const reviewsCountMatch = html.match(/"comment_num_show"\s*:\s*"?(\d+)"?/);
    if (reviewsCountMatch) product.reviewsCount = parseInt(reviewsCountMatch[1]);

  } catch (e) {
    console.error('Parse error:', e.message);
  }

  return product;
}

function unescapeJson(str) {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str.replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
  }
}
