export default async function handler(req, res) {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${session_id}`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
    );
    const session = await response.json();
    if (session.error) throw new Error(session.error.message);

    if (session.payment_status !== 'paid') {
      return res.status(200).json({ success: false });
    }

    const product = session.metadata?.product || 'phantum';
    const isTgap = product === 'tgap';
    const creditsToAdd = 10;
    const keyPrefix = isTgap ? 'tgap' : 'phantum';

    const userId = session.metadata?.userId || session.customer || session.id;
    const creditKey = `${keyPrefix}:credits:user:${userId}`;
    const processedKey = `${keyPrefix}:processed:session:${session_id}`;

    // Idempotency check — avoid double-crediting on repeated calls
    const alreadyProcessed = await fetch(`${REDIS_URL}/get/${encodeURIComponent(processedKey)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    }).then(r => r.json()).then(d => d.result);

    let totalCredits;
    if (alreadyProcessed) {
      const cur = await fetch(`${REDIS_URL}/get/${encodeURIComponent(creditKey)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      }).then(r => r.json()).then(d => parseInt(d.result || '0', 10));
      totalCredits = cur;
    } else {
      const existRes = await fetch(`${REDIS_URL}/get/${encodeURIComponent(creditKey)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const existData = await existRes.json();
      const existing = parseInt(existData.result || '0', 10);
      totalCredits = existing + creditsToAdd;

      await Promise.all([
        fetch(`${REDIS_URL}/set/${encodeURIComponent(creditKey)}/${totalCredits}`, {
          headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        }),
        fetch(`${REDIS_URL}/set/${encodeURIComponent(processedKey)}/1`, {
          headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        }),
      ]);
    }

    res.status(200).json({ success: true, userId, credits: totalCredits, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
