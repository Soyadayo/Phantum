async function redisGet(url, token, key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result;
}

async function redisDecr(url, token, key) {
  const res = await fetch(`${url}/decr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result;
}

async function redisPipeline(url, token, commands) {
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  return res.json();
}

function getNextMidnightUnix() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.floor(midnight.getTime() / 1000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { input, systemPrompt, userId, skipCredit } = req.body;
  if (!input || !systemPrompt) return res.status(400).json({ error: 'Missing input or systemPrompt' });

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const today = new Date().toISOString().slice(0, 10);

  // Skip credit check for oracle selector (internal call)
  if (skipCredit) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ system_instruction:{parts:[{text:systemPrompt}]}, contents:[{role:'user',parts:[{text:input}]}], generationConfig:{temperature:0.3,maxOutputTokens:128} }) }
      );
      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      return res.status(200).json(data);
    } catch(err) { return res.status(500).json({ error: err.message }); }
  }

  // Check paid credits
  const creditKey = userId ? `phantum:credits:user:${userId}` : `phantum:credits:ip:${ip}`;
  const credits = parseInt(await redisGet(REDIS_URL, REDIS_TOKEN, creditKey) || '0', 10);

  let creditsRemaining = null;

  if (credits > 0) {
    creditsRemaining = await redisDecr(REDIS_URL, REDIS_TOKEN, creditKey);
  } else {
    // Free daily limit
    const freeKey = `phantum:free:${ip}:${today}`;
    const freeCount = parseInt(await redisGet(REDIS_URL, REDIS_TOKEN, freeKey) || '0', 10);

    if (freeCount >= 1) {
      return res.status(429).json({ error: 'FREE_LIMIT_REACHED' });
    }

    await redisPipeline(REDIS_URL, REDIS_TOKEN, [
      ['INCR', freeKey],
      ['EXPIREAT', freeKey, getNextMidnightUnix()]
    ]);
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: input }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 512 }
        })
      }
    );
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.status(200).json({ ...data, creditsRemaining });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
