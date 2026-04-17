export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, userId } = req.body;

  try {
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('line_items[0][price]', process.env.STRIPE_PRICE_ID);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', (process.env.SITE_URL || 'https://www.tacorari.eu/phantum') + '?status=success&session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', process.env.SITE_URL || 'https://www.tacorari.eu/phantum');
    if (email) {
      params.append('customer_email', email);
    }
    if (userId) {
      params.append('metadata[userId]', userId);
    }

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await response.json();

    if (session.error) {
      console.error('Stripe error:', session.error);
      return res.status(500).json({ error: session.error.message });
    }

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}
