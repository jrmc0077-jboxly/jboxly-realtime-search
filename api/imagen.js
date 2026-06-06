export default async function handler(req, res) {
  const { url } = req.query;
  
  if (!url) return res.status(400).json({ error: 'Falta url' });

  try {
    const response = await fetch(decodeURIComponent(url), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.amazon.com',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      }
    });

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).json({ 
      src: `data:${contentType};base64,${base64}` 
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar imagen' });
  }
}
