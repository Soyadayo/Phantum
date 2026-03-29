const FREE_LIMIT = 3;

async function redisCommand(url, token, command) {
  const res = await fetch(`${url}/${command.join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}

async function checkSubscription(customerId) {
  if (!customerId) return false;
  const res = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=1`,
    { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
  );
  const data = await res.json();
  return data.data && data.data.length > 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { input, systemPrompt, customerId } = req.body;

  if (!input || !systemPrompt) {
    return res.status(400).json({ error: 'Missing input or systemPrompt' });
  }

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Check subscription first
  const isPremium = await checkSubscription(customerId);

  if (!isPremium) {
    // Rate limit by IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const today = new Date().toISOString().slice(0, 10);
    const key = `phantum:count:${ip}:${today}`;

    const countRes = await redisCommand(REDIS_URL, REDIS_TOKEN, ['GET', key]);
    const count = parseInt(countRes.result || '0', 10);

    if (count >= FREE_LIMIT) {
      return res.status(429).json({
        error: 'FREE_LIMIT_REACHED',
        message: 'You have used your 3 free readings for today.',
        upgradeUrl: '/api/checkout'
      });
    }

    // Increment counter, expire at midnight
    await redisCommand(REDIS_URL, REDIS_TOKEN, ['INCR', key]);
    await redisCommand(REDIS_URL, REDIS_TOKEN, ['EXPIREAT', key, getNextMidnightUnix()]);
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
          generationConfig: { temperature: 0.8, maxOutputTokens: 8192 }
        })
      }
    );

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function getNextMidnightUnix() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.floor(midnight.getTime() / 1000);
}
