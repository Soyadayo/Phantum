async function redisGet(url, token, key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result;
}

async function redisIncr(url, token, key) {
  const res = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
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

function getMonthEnd() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.floor(end.getTime() / 1000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, userId } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const month = new Date().toISOString().slice(0, 7); // "2026-04"

  // Check paid credits first
  const creditKey = userId ? `tgap:credits:user:${userId}` : `tgap:credits:ip:${ip}`;
  const credits = parseInt(await redisGet(REDIS_URL, REDIS_TOKEN, creditKey) || '0', 10);

  let creditsRemaining = null;
  let freeRemaining = null;

  if (credits > 0) {
    creditsRemaining = await redisDecr(REDIS_URL, REDIS_TOKEN, creditKey);
  } else {
    // Free monthly limit: 3 per month
    const freeKey = `tgap:free:${ip}:${month}`;
    const freeCount = parseInt(await redisGet(REDIS_URL, REDIS_TOKEN, freeKey) || '0', 10);

    if (freeCount >= 3) {
      return res.status(429).json({ error: 'FREE_LIMIT_REACHED' });
    }

    await redisPipeline(REDIS_URL, REDIS_TOKEN, [
      ['INCR', freeKey],
      ['EXPIREAT', freeKey, getMonthEnd()]
    ]);
    freeRemaining = 2 - freeCount; // after this check
  }

  // --- Article analysis would go here ---
  // For now, return success with usage info.
  // When real: fetch the article, find original sources via RSS/news API,
  // send to Gemini/Claude for translation + gap analysis, return results.

  try {
    // Placeholder: in production, replace with actual LLM analysis
    res.status(200).json({
      success: true,
      creditsRemaining,
      freeRemaining,
      // results would go here
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
