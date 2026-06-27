// /api/shein-product.js
// Endpoint para obtener detalle COMPLETO de un producto Shein
// Uso: /api/shein-product?url=https://us.shein.com/PRODUCTO.html
// Devuelve: titulo, precio, imagenes, tallas, colores, specs, rating, reviews

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" parameter' });
  }

  const user = process.env.OXYLABS_USER;
  const pass = process.env.OXYLABS_PASS;

  if (!user || !pass) {
    return res.status(500).json({ error: 'Oxylabs credentials not configured' });
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
        url: url,
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

    const product = parseSheinProductDetail(html);

    return res.status(200).json({
      url: url,
      product,
    });

  } catch (error) {
    return res.status(500).json({ error: 'Internal error', message: error.message });
  }
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
    specs: [],
    rating: 0,
    reviewsCount: 0,
    reviews: [],
    goods_id: '',
    goods_sn: '',
  };

  try {
    // ===== Título =====
    const titleMatch = html.match(/"goods_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) product.title = unescapeJson(titleMatch[1]);

    // ===== Precio =====
    const priceMatch = html.match(/"salePrice"\s*:\s*\{[^}]*"amountWithSymbol"\s*:\s*"([^"]+)"/) ||
                       html.match(/"amountWithSymbol"\s*:\s*"(\$\d+\.\d{2})"/);
    if (priceMatch) product.price = priceMatch[1];

    const oldPriceMatch = html.match(/"retailPrice"\s*:\s*\{[^}]*"amountWithSymbol"\s*:\s*"([^"]+)"/);
    if (oldPriceMatch) product.originalPrice = oldPriceMatch[1];

    // ===== IDs =====
    const goodsIdMatch = html.match(/"goods_id"\s*:\s*"?(\d+)"?/);
    if (goodsIdMatch) product.goods_id = goodsIdMatch[1];

    const goodsSnMatch = html.match(/"goods_sn"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (goodsSnMatch) product.goods_sn = unescapeJson(goodsSnMatch[1]);

    // ===== Imágenes (galería) =====
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

    // ===== Descripción =====
    const descMatch = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.){10,2000})"/) ||
                      html.match(/"goods_desc"\s*:\s*"((?:[^"\\]|\\.){10,2000})"/);
    if (descMatch) product.description = unescapeJson(descMatch[1]);

    // ===== Tallas =====
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
    if (sizesSet.size === 0) {
      const sizeFallback = /"attr_value_name_en"\s*:\s*"((?:XS|S|M|L|XL|XXL|XXXL|\d+)[^"]{0,5})"/g;
      let sm;
      while ((sm = sizeFallback.exec(html)) !== null && sizesSet.size < 15) {
        sizesSet.add(sm[1]);
      }
    }
    product.sizes = Array.from(sizesSet).slice(0, 15);

    // ===== Colores (extraer imagenes mini de variantes de color) =====
    // Shein expone goods_color_image (URL de imagen mini) para cada color
    const colorMap = new Map(); // image -> {image, name}
    
    // Patrón 1: pares goods_id + goods_color_image (variantes del producto)
    const colorBlockRegex = /"goods_id"\s*:\s*"?(\d+)"?[^{]*?"goods_color_image"\s*:\s*"((?:[^"\\]|\\.)*)"[^{]{0,500}?"goods_url_name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let colorBlock;
    while ((colorBlock = colorBlockRegex.exec(html)) !== null && colorMap.size < 12) {
      const variantId = colorBlock[1];
      let img = unescapeJson(colorBlock[2]);
      if (img.startsWith('//')) img = 'https:' + img;
      const nameRaw = unescapeJson(colorBlock[3] || '');
      // Solo agregar si la URL es valida y no esta repetida
      if (img && img.length > 20 && !colorMap.has(img)) {
        colorMap.set(img, {
          image: img,
          id: variantId,
          name: nameRaw.split(' ').slice(0, 3).join(' ').trim() || `Color ${colorMap.size + 1}`
        });
      }
    }

    // Patrón 2: solo goods_color_image (fallback)
    if (colorMap.size === 0) {
      const fallbackRegex = /"goods_color_image"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let cm;
      while ((cm = fallbackRegex.exec(html)) !== null && colorMap.size < 12) {
        let img = unescapeJson(cm[1]);
        if (img.startsWith('//')) img = 'https:' + img;
        if (img && img.length > 20 && !colorMap.has(img)) {
          colorMap.set(img, {
            image: img,
            id: '',
            name: `Color ${colorMap.size + 1}`
          });
        }
      }
    }

    product.colors = Array.from(colorMap.values());

    // ===== Specs (attr_name / attr_value) =====
    // Buscar todos los pares attr_name + attr_value
    const seenSpecs = new Set();
    const specRegex = /"attr_name"\s*:\s*"([^"]+)"\s*,\s*"attr_value"\s*:\s*"([^"]+)"/g;
    let specMatch;
    while ((specMatch = specRegex.exec(html)) !== null && product.specs.length < 15) {
      const name = unescapeJson(specMatch[1]);
      const value = unescapeJson(specMatch[2]);
      // Filtrar: ignorar Size porque es talla, no spec
      if (name === 'Size' || name === 'Color') continue;
      const key = name + ':' + value;
      if (!seenSpecs.has(key) && name.length < 50 && value.length < 100) {
        seenSpecs.add(key);
        product.specs.push({ name, value });
      }
    }

    // ===== Rating (Schema.org microdata) =====
    const ratingMatch = html.match(/<span itemprop="ratingValue">([\d.]+)<\/span>/);
    if (ratingMatch) {
      product.rating = parseFloat(ratingMatch[1]) || 0;
    }

    // ===== Review count =====
    // Buscar reviewCount o ratingCount en meta tags
    const reviewCountMatch = html.match(/<meta itemprop="reviewCount" content="([^"]+)"/);
    if (reviewCountMatch) {
      // Puede ser "1000+" o "150"
      const raw = reviewCountMatch[1];
      const num = parseInt(raw.replace(/[^\d]/g, '')) || 0;
      product.reviewsCount = num;
      // Si tiene "+" lo agregamos al display, pero numero crudo en el campo
    }

    // Si no, buscar en H2 "Customer Reviews (NUMERO)"
    if (product.reviewsCount === 0) {
      const reviewsH2Match = html.match(/Customer Reviews\s*\((\d+[+]?)\)/);
      if (reviewsH2Match) {
        const num = parseInt(reviewsH2Match[1].replace(/[^\d]/g, '')) || 0;
        product.reviewsCount = num;
      }
    }

    // ===== Reviews individuales (top 5) =====
    const reviewBlocks = html.match(/<article itemprop="review">[\s\S]{0,2000}?<\/article>/g) || [];
    const seenReviews = new Set();
    for (const block of reviewBlocks.slice(0, 5)) {
      const authorMatch = block.match(/<span itemprop="name">([^<]+)<\/span>/);
      const ratingMatch = block.match(/<span itemprop="ratingValue">(\d+)</);
      const textMatch = block.match(/<span itemprop="reviewBody"[^>]*>([^<]+)</) ||
                        block.match(/<p>Author:[^<]+<\/p>[\s\S]*?<p>([^<]+)<\/p>/);
      
      if (authorMatch && ratingMatch) {
        const author = authorMatch[1].trim();
        const rating = parseInt(ratingMatch[1]) || 0;
        const text = textMatch ? textMatch[1].trim() : '';
        const key = author + rating;
        if (!seenReviews.has(key)) {
          seenReviews.add(key);
          product.reviews.push({ author, rating, text: text.slice(0, 300) });
        }
      }
    }

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
