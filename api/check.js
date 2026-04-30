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

function getMonthEnd() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.floor(end.getTime() / 1000);
}

async function fetchArticleText(url) {
  // 1. Jina AI Reader — handles paywalls, JS-heavy pages, and complex layouts
  try {
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(15000),
    });
    if (jinaRes.ok) {
      const text = await jinaRes.text();
      // Jina returns an error page if it can't parse — check for real content
      if (text && text.length > 300 && !text.startsWith('Error')) {
        console.log('TGAP: fetched via Jina AI, chars:', text.length);
        return text.slice(0, 8000);
      }
    }
  } catch (e) {
    console.log('TGAP: Jina AI failed:', e.message);
  }

  // 2. Direct fetch + HTML strip (fallback)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
    console.log('TGAP: fetched via direct fetch, chars:', text.length);
    return text;
  } catch (e) {
    console.log('TGAP: direct fetch failed:', e.message);
    return '';
  }
}

const SYSTEM_PROMPT = `You are TranslationGap — a service that exposes what English-language news articles leave out when compared to how the same story is reported in the original-language sources.

Given a URL and (when available) the article's extracted text, your task is:

1. Identify the main topic and which countries or regions are central to the story.
2. Select 2–3 real, named news outlets in the relevant non-English language(s) that would credibly cover this story.
   Examples by region:
   - Turkey: Cumhuriyet, Hürriyet, Sabah, Sözcü
   - Japan: Nikkei, Asahi Shimbun, Mainichi Shimbun, Yomiuri
   - Iran: Shargh, ISNA, Kayhan, Iran newspaper
   - China: Caixin, Global Times, People's Daily, Xinhua
   - Russia: Kommersant, Novaya Gazeta, Vedomosti
   - Arab world: Al Jazeera Arabic, Al Arabiya, Asharq Al-Awsat, Al-Ahram
   - Germany: Der Spiegel, FAZ, Süddeutsche Zeitung, Die Zeit
   - France: Le Monde, Le Figaro, Libération
   - Latin America: El País (ES), Folha de S.Paulo, La Jornada
3. For each outlet, write 1–2 specific findings — concrete pieces of information, data, perspectives, or framings that appear in that outlet's typical coverage but are absent from or contradicted by the English article.
4. Classify each finding as exactly one of:
   - "missing": information present in foreign-language sources but absent from the English article
   - "contradiction": something the English article states that this outlet disputes or contradicts
   - "nuance": same basic facts, but framed or interpreted very differently
5. For "missing" findings, the label field must be "Missing from the English article".
   For "contradiction" findings: "Contradicts the English article".
   For "nuance" findings: "Framed differently in English".
6. Write a concise overall verdict (2–4 sentences) on what English readers are missing.
7. Recommend exactly 2 real books with real authors that provide deeper context for this story's background. These must be real published books.

Be specific and journalistic. Avoid vague generalities. Reference real reporters, real institutions, real data points where plausible.

Respond ONLY in this exact JSON format with no preamble, no markdown, no code fences:
{"article":{"title":"...","outlet":"...","date":"..."},"sources":[{"outlet":"...","lang":"...","flag":"🏳","type":"editorial lean in one sentence","findings":[{"cat":"missing","label":"Missing from the English article","text":"..."}]}],"verdict":"...","books":[{"title":"...","author":"...","emoji":"📚","why":"one sentence on why this book matters for this story","search":"book title author name"}]}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, userId } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const month = new Date().toISOString().slice(0, 7);

  // --- Credit check ---
  const creditKey = userId ? `tgap:credits:user:${userId}` : `tgap:credits:ip:${ip}`;
  const credits = parseInt(await redisGet(REDIS_URL, REDIS_TOKEN, creditKey) || '0', 10);

  let creditsRemaining = null;
  let freeRemaining = null;

  if (credits > 0) {
    creditsRemaining = await redisDecr(REDIS_URL, REDIS_TOKEN, creditKey);
  } else {
    const freeKey = `tgap:free:${ip}:${month}`;
    const freeCount = parseInt(await redisGet(REDIS_URL, REDIS_TOKEN, freeKey) || '0', 10);
    if (freeCount >= 3) {
      return res.status(429).json({ error: 'FREE_LIMIT_REACHED' });
    }
    await redisPipeline(REDIS_URL, REDIS_TOKEN, [
      ['INCR', freeKey],
      ['EXPIREAT', freeKey, getMonthEnd()]
    ]);
    freeRemaining = Math.max(0, 2 - freeCount);
  }

  // --- Fetch article text (best-effort) ---
  const articleText = await fetchArticleText(url);

  // --- Gemini analysis ---
  try {
    const userMessage = `URL: ${url}\n\n${
      articleText
        ? `ARTICLE CONTENT (extracted text):\n${articleText}`
        : '(Could not fetch article content — use your knowledge of this URL, outlet, and topic to produce the analysis.)'
    }`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      }
    );

    const geminiData = await geminiRes.json();
    console.log('TGAP GEMINI RAW:', JSON.stringify(geminiData).slice(0, 600));
    if (geminiData.error) return res.status(500).json({ error: geminiData.error.message });

    const parts = geminiData.candidates?.[0]?.content?.parts || [];
    const rawText = parts
      .filter(p => typeof p.text === 'string' && !p.thoughtSignature)
      .map(p => p.text)
      .join('');

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse AI response. Please try again.' });

    const result = JSON.parse(jsonMatch[0]);

    // Convert book search terms to Amazon affiliate URLs
    if (Array.isArray(result.books)) {
      result.books = result.books.map(b => ({
        title: b.title,
        author: b.author,
        emoji: b.emoji || '📚',
        why: b.why,
        url: `https://www.amazon.com/s?k=${encodeURIComponent((b.search || b.title + ' ' + b.author).trim())}&tag=haustacorari-20`
      }));
    }

    return res.status(200).json({ result, creditsRemaining, freeRemaining });
  } catch (err) {
    console.error('TGAP error:', err);
    return res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
}
