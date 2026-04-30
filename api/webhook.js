import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = {};
  sigHeader.split(',').forEach(part => {
    const idx = part.indexOf('=');
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 'v1') {
      parts.v1 = parts.v1 || [];
      parts.v1.push(v);
    } else {
      parts[k] = v;
    }
  });

  if (!parts.t || !parts.v1) return false;

  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  return parts.v1.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
}

async function redisGet(url, token, key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json().then(d => d.result);
}

async function redisSet(url, token, key, value) {
  await fetch(`${url}/set/${encodeURIComponent(key)}/${value}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) return res.status(400).json({ error: 'Missing signature or webhook secret' });

  const rawBody = await getRawBody(req);

  if (!verifyStripeSignature(rawBody.toString(), sig, webhookSecret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.status(200).json({ received: true });

    const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
    const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

    const product = session.metadata?.product || 'phantum';
    const isTgap = product === 'tgap';
    const creditsToAdd = isTgap ? 5 : 10;
    const keyPrefix = isTgap ? 'tgap' : 'phantum';

    const userId = session.metadata?.userId || session.customer || session.id;
    const creditKey = `${keyPrefix}:credits:user:${userId}`;
    const processedKey = `${keyPrefix}:processed:session:${session.id}`;

    const alreadyProcessed = await redisGet(REDIS_URL, REDIS_TOKEN, processedKey);
    if (!alreadyProcessed) {
      const existing = parseInt(await redisGet(REDIS_URL, REDIS_TOKEN, creditKey) || '0', 10);
      await Promise.all([
        redisSet(REDIS_URL, REDIS_TOKEN, creditKey, existing + creditsToAdd),
        redisSet(REDIS_URL, REDIS_TOKEN, processedKey, '1'),
      ]);
    }
  }

  res.status(200).json({ received: true });
}
