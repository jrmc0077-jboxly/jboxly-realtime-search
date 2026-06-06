export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  try {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(JSON.parse(data)));
    });

    const { texto } = body;
    if (!texto) return res.status(400).json({ ok: false, error: 'Falta texto' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: 'Traduce este texto del inglés al español de forma natural y concisa. Responde SOLO con la traducción, sin explicaciones ni comillas:\n\n' + texto
        }]
      })
    });

    const data = await response.json();
    const traduccion = data.content && data.content[0] ? data.content[0].text : texto;
    return res.status(200).json({ ok: true, traduccion });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message) });
  }
}
