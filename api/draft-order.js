const fetch = require('node-fetch');

// ============================================================
// DRAFT ORDER - Checkout via Shopify para paises NO-Venezuela
// ============================================================
// Recibe un carrito con productos (titulos custom, sin variant_id real)
// y crea un Draft Order en Shopify que devuelve un invoice_url.
// El cliente abre ese link y paga directo en Shopify (Stripe, Visa, etc).
// ============================================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Solo POST permitido' });
  }

  // 1) Validar variables de entorno
  const SHOP = process.env.SHOPIFY_SHOP;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!SHOP || !TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'SHOPIFY_SHOP o SHOPIFY_ADMIN_TOKEN no configurados en Vercel'
    });
  }

  // 2) Validar payload recibido
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'JSON invalido' });
  }
  if (!body) return res.status(400).json({ ok: false, error: 'Body vacio' });

  const carrito = body.carrito || [];
  const cliente = body.cliente || {};
  const envio = parseFloat(body.envio) || 0;
  const impuestos = parseFloat(body.impuestos) || 0;
  const seguro = parseFloat(body.seguro) || 0;
  const feeServicio = parseFloat(body.feeServicio) || 0;
  const pais = body.pais || '';
  const soloProductos = body.solo_productos === true;  // Modo "Comprar productos ya"

  if (!Array.isArray(carrito) || carrito.length === 0) {
    return res.status(400).json({ ok: false, error: 'Carrito vacio' });
  }
  if (!cliente.email) {
    return res.status(400).json({ ok: false, error: 'Email del cliente requerido' });
  }

  // 3) Construir line_items custom para Shopify
const lineItems = carrito.map(function(item) {
    const precio = parseFloat(item.precioNum || item.precio || 0);
    const cantidad = parseInt(item.cantidad) || 1;

    // Shopify limita titulos a 120 chars. Construimos meta primero, despues titulo.
    const meta = [];
    if (item.tienda) meta.push(item.tienda.charAt(0).toUpperCase() + item.tienda.slice(1));
    if (item.variante) meta.push(item.variante);
    const metaStr = meta.length > 0 ? ' (' + meta.join(' - ') + ')' : '';

    // Reservar espacio para el meta
    const espacioParaTitulo = Math.max(40, 120 - metaStr.length - 3); // -3 por "..."
    let tituloBase = (item.tituloEs || item.titulo || 'Producto JBOXLY');
    if (tituloBase.length > espacioParaTitulo) {
      tituloBase = tituloBase.substring(0, espacioParaTitulo).trim() + '...';
    }

    let titulo = tituloBase + metaStr;
    // Garantia final: nunca pasar de 120 chars
    if (titulo.length > 120) titulo = titulo.substring(0, 120);

    return {
      title: titulo,
      price: precio.toFixed(2),
      quantity: cantidad,
      taxable: false,
      requires_shipping: false
    };
  });

  // 4) Agregar impuestos, seguro, fee y envio como lineas custom
  // 4) Agregar lineas extra SOLO si no es "solo productos"
  if (!soloProductos) {
    if (impuestos > 0) {
      lineItems.push({
        title: 'Impuestos (8.25%)',
        price: impuestos.toFixed(2),
        quantity: 1,
        taxable: false,
        requires_shipping: false
      });
    }
    if (seguro > 0) {
      lineItems.push({
        title: 'Seguro obligatorio (5%)',
        price: seguro.toFixed(2),
        quantity: 1,
        taxable: false,
        requires_shipping: false
      });
    }
    if (feeServicio > 0) {
      lineItems.push({
        title: 'Fee de servicio + Manejo y Empaque',
        price: feeServicio.toFixed(2),
        quantity: 1,
        taxable: false,
        requires_shipping: false
      });
    }
    if (envio > 0) {
      lineItems.push({
        title: 'Envio internacional a ' + (pais || 'tu pais'),
        price: envio.toFixed(2),
        quantity: 1,
        taxable: false,
        requires_shipping: false
      });
    }
  }

  // 5) Construir payload del Draft Order
  // Tag distintivo para identificar si es "solo productos" o "completo"
  const tagModo = soloProductos ? 'solo-productos' : 'completo';
  const notaModo = soloProductos
    ? 'MODO: SOLO PRODUCTOS - Pendiente cobrar envio + fee + impuestos en segundo link'
    : 'MODO: COMPLETO - Incluye productos + envio + fee + impuestos';

  const draftOrderPayload = {
    draft_order: {
      line_items: lineItems,
      email: cliente.email,
      note: notaModo + ' | Pais: ' + pais + (cliente.casillero ? ' | Casillero: ' + cliente.casillero : ''),
      tags: 'jboxly,' + (pais || 'sin-pais').toLowerCase() + ',' + tagModo,
      use_customer_default_address: false
    }
  };

  if (cliente.customerId) {
    draftOrderPayload.draft_order.customer = { id: parseInt(cliente.customerId) };
  }

  // 6) Llamar a la API de Shopify
  try {
    const url = 'https://' + SHOP + '/admin/api/2024-01/draft_orders.json';
    const shopifyRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN
      },
      body: JSON.stringify(draftOrderPayload)
    });

    const data = await shopifyRes.json();

    if (!shopifyRes.ok) {
      console.error('Shopify error:', shopifyRes.status, data);
      return res.status(shopifyRes.status).json({
        ok: false,
        error: 'Error de Shopify',
        detalle: data.errors || data
      });
    }

    if (!data.draft_order) {
      return res.status(500).json({
        ok: false,
        error: 'Shopify no devolvio draft_order',
        respuesta: data
      });
    }

    // 7) Devolver el invoice_url al frontend
    return res.status(200).json({
      ok: true,
      checkout_url: data.draft_order.invoice_url,
      draft_order_id: data.draft_order.id,
      total: data.draft_order.total_price,
      name: data.draft_order.name
    });
  } catch (err) {
    console.error('Error al crear Draft Order:', err);
    return res.status(500).json({
      ok: false,
      error: 'Error al comunicarse con Shopify',
      detalle: err.message
    });
  }
};
