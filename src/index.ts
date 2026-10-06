// (前半のimport、定数、パース関数、AI要約関数はいただいたコードと同じため省略せずそのまま記述します)
const DATA_VERSION = 3;
const MAX_ITEMS = 6;
const CANDIDATES = 10;
const SUMMARY_MAX = 320;
const WARM_ON_CRON = 10;
const WARM_ON_REQUEST = 2;
const SUMMARY_TTL = 60 * 60 * 24 * 7;
const FAIL_TTL = 60 * 60 * 6;
const ROBOTS_TTL = 60 * 60 * 24;
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const UA_TOKEN = 'NewsSummoner';
const UA = `Mozilla/5.0 (compatible; ${UA_TOKEN}/3.0; +https://github.com/shotaro0222/XR-reference)`;

const FEEDS: Record<string, string[]> = {
  it: ['https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml'],
  business: ['https://rss.itmedia.co.jp/rss/2.0/business.xml'],
  entertainment: [
    'https://natalie.mu/music/feed/news',
    'https://natalie.mu/eiga/feed/news',
    'https://eiga.com/rss/news/',
    'https://www.cinemacafe.net/rss/index.rdf'
  ],
  funny: ['https://gigazine.net/news/rss_2.0/', 'https://rss.itmedia.co.jp/rss/2.0/netlab.xml']
};

export type NewsItem = {
  title: string;
  url: string;
  summary?: string;
  summaryKind?: 'ai' | 'rss';
  source?: string;
  published?: string;
};
type SummaryRecord = { summary?: string; failed?: boolean; at: string };

// ====================== テキスト処理 ======================
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function safeCodePoint(n: number) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

export function cleanText(s = ''): string {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = decodeEntities(t);
  t = t
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return decodeEntities(t);
}

const hasJapanese = (s: string) => /[ぁ-んァ-ヶ一-龠]/.test(s);

export function truncateSentences(text: string, maxLen = SUMMARY_MAX): string {
  if (text.length <= maxLen) return text;
  const sentences = text.match(/[^。！？!?]+[。！？!?」』）)]*/g) || [text];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > maxLen) break;
    out += s;
  }
  return (out || text.slice(0, maxLen - 1) + '…').trim();
}

// ====================== RSS ======================
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1] : '';
}

export function parseFeed(xml: string): { source: string; items: NewsItem[] } {
  const channel =
    xml.match(/<channel[\s>][\s\S]*?(?=<item[\s>]|<\/channel>)/i)?.[0] ||
    xml.match(/<feed[\s\S]*?(?=<entry[\s>])/i)?.[0] ||
    '';
  const source = cleanText(tag(channel, 'title')).replace(/\s*[-|｜].*$/, '').trim();
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const items: NewsItem[] = [];
  for (const b of blocks) {
    const title = cleanText(tag(b, 'title'));
    let url = cleanText(tag(b, 'link'));
    if (!url) url = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] || b.match(/rdf:about="([^"]+)"/i)?.[1] || '';
    url = decodeEntities(url).replace(/[?&]utm_[^=]+=[^&]*/g, '');
    const summary = cleanText(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'))
      .replace(/[\s(（\[【]*(続きを読む|続きはこちら|全文を読む|もっと見る|Read more)[\s)）\]】»>…]*$/i, '')
      .trim();
    const published = cleanText(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'updated') || tag(b, 'published'));
    if (!title || !/^https?:\/\/[^/]+\/.+/.test(url)) continue;
    const usable = summary && summary.length >= 20 && summary !== title ? truncateSentences(summary) : undefined;
    items.push({
      title,
      url,
      summary: usable,
      summaryKind: usable ? 'rss' : undefined,
      source: source || undefined,
      published: published || undefined
    });
  }
  return { source, items };
}

async function fetchFeed(url: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8' }
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return parseFeed(await res.text());
}

// ====================== robots.txt ======================
export function robotsAllows(robotsTxt: string, path: string, agent = UA_TOKEN): boolean {
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', pattern: val });
    }
  }
  const a = agent.toLowerCase();
  const group = groups.find(g => g.agents.some(x => x !== '*' && a.includes(x))) || groups.find(g => g.agents.includes('*'));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    const re = new RegExp('^' + r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.pattern.length > best.len || (r.pattern.length === best.len && r.allow))) {
      best = { allow: r.allow, len: r.pattern.length };
    }
  }
  return best ? best.allow : true;
}

async function isAllowedByRobots(env: any, url: string): Promise<boolean> {
  const u = new URL(url);
  const key = `robots:${u.host}`;
  let txt: string | null = await env.NEWS_KV.get(key);
  if (txt === null) {
    try {
      const res = await fetch(`${u.protocol}//${u.host}/robots.txt`, { headers: { 'User-Agent': UA } });
      txt = res.ok ? await res.text() : res.status >= 500 ? 'User-agent: *\nDisallow: /' : '';
    } catch {
      txt = 'User-agent: *\nDisallow: /';
    }
    await env.NEWS_KV.put(key, txt.slice(0, 50000), { expirationTtl: ROBOTS_TTL });
  }
  return robotsAllows(txt, u.pathname + u.search);
}

// ====================== 記事本文の抽出 ======================
const BOILERPLATE = /(Copyright|©|All rights reserved|関連記事|関連リンク|ランキング|会員登録|ログイン|シェアする|ブックマーク|続きを読む|この記事を|PR：|PR:|お問い合わせ|利用規約|プライバシー)/i;
const SKIP_TAGS = new Set(['aside', 'nav', 'footer', 'header', 'form', 'figure', 'figcaption', 'li', 'button', 'select', 'noscript', 'style', 'script', 'template', 'svg', 'iframe']);
const SKIP_ATTR = /(related|ranking|share|sns|author|footer|breadcrumb|recommend|banner|comment|pickup|popular)/i;
const BODY_ATTR = /(^|[\s_-])(cmsBody|article[_-]?body|articleBody|entry-content|post-content|cntimage|news_body|main-text)([\s_-]|$)/i;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export async function extractArticle(res: Response): Promise<{ title?: string; description?: string; body: string }> {
  const parts: string[] = [];
  let ldBody = '';
  let ldBuf: string | null = null;
  let ogTitle = '';
  let ogDesc = '';
  let skipDepth = 0;
  let bodyDepth = 0;
  let pBuf: string | null = null;
  let blockBuf = '';

  const flushBlock = () => {
    const t = cleanText(blockBuf);
    if (t) parts.push(t);
    blockBuf = '';
  };

  const rewriter = new HTMLRewriter().on('*', {
    element(el) {
      const tagName = el.tagName.toLowerCase();
      if (VOID_TAGS.has(tagName)) {
        if (tagName === 'meta') {
          const p = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
          const c = el.getAttribute('content') || '';
          if (p === 'og:title' && !ogTitle) ogTitle = c;
          if ((p === 'og:description' || p === 'description') && !ogDesc) ogDesc = c;
        } else if (tagName === 'br' && bodyDepth > 0 && pBuf === null) {
          flushBlock();
        }
        return;
      }
      const attrs = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
      const isLd = tagName === 'script' && (el.getAttribute('type') || '').includes('ld+json');
      const isSkip = !isLd && (SKIP_TAGS.has(tagName) || SKIP_ATTR.test(attrs));
      const isBody = !isSkip && (el.getAttribute('itemprop') === 'articleBody' || BODY_ATTR.test(attrs) || tagName === 'article' || tagName === 'main');
      const isP = tagName === 'p' && skipDepth === 0 && !isSkip;
      const isBlockBoundary = tagName === 'div' || /^h[1-6]$/.test(tagName);

      if (isLd) ldBuf = '';
      if (isSkip) skipDepth++;
      if (isBody) bodyDepth++;
      if (isBlockBoundary && bodyDepth > 0 && pBuf === null) flushBlock();
      if (isP) { if (bodyDepth > 0) flushBlock(); pBuf = ''; }

      el.onEndTag(() => {
        if (isLd && ldBuf !== null) {
          try {
            const data = JSON.parse(ldBuf);
            const list = Array.isArray(data) ? data : data['@graph'] || [data];
            for (const d of list) if (d?.articleBody && String(d.articleBody).length > ldBody.length) ldBody = String(d.articleBody);
          } catch { }
          ldBuf = null;
        }
        if (isP && pBuf !== null) {
          const t = cleanText(pBuf);
          if (t) parts.push(t);
          pBuf = null;
        }
        if (isBlockBoundary && bodyDepth > 0 && pBuf === null) flushBlock();
        if (isBody) { flushBlock(); bodyDepth--; }
        if (isSkip) skipDepth--;
      });
    },
    text(t) {
      if (ldBuf !== null) { ldBuf += t.text; return; }
      if (skipDepth > 0) return;
      if (pBuf !== null) pBuf += t.text;
      else if (bodyDepth > 0) blockBuf += t.text;
    }
  });

  await rewriter.transform(res).arrayBuffer();
  flushBlock();

  const good = (s: string) => s.length >= 25 && hasJapanese(s) && !BOILERPLATE.test(s.slice(0, 60));
  const fromHtml = [...new Set(parts.filter(good))].join('\n');
  const ld = cleanText(ldBody);
  const body = ld.length > fromHtml.length ? ld : fromHtml;
  return { title: cleanText(ogTitle) || undefined, description: cleanText(ogDesc) || undefined, body: body.slice(0, 6000) };
}

// ====================== AI 要約 ======================
async function summarize(env: any, title: string, body: string): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const res: any = await env.AI.run(env.SUMMARY_MODEL || DEFAULT_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'あなたはニュースを読み上げるアナウンサーです。与えられた記事本文だけを根拠に、日本語の「です・ます」調で、' +
            `${SUMMARY_MAX}字以内・3〜4文の読み上げ原稿を作ってください。` +
            '「誰が・何を・なぜ・今後どうなるか」が伝わるようにし、本文にない事実や意見は絶対に足さないこと。' +
            'タイトルの繰り返し、前置き、箇条書き、記号、URLは書かず、原稿の本文だけを出力してください。'
        },
        { role: 'user', content: `タイトル：${title}\n本文：\n${body.slice(0, 3500)}` }
      ],
      max_tokens: 600,
      temperature: 0.2
    });
    const out = String(res?.response ?? res?.choices?.[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^(原稿|読み上げ原稿)[:：]\s*/, '')
      .replace(/^[「『"]|[」』"]$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (out.length < 40 || !hasJapanese(out)) return null;
    return truncateSentences(out, Math.round(SUMMARY_MAX * 1.2));
  } catch (e) {
    console.error('AI summary failed', e);
    return null;
  }
}

async function sumKey(url: string) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url));
  return 'sum:' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getOrCreateSummary(env: any, item: NewsItem): Promise<SummaryRecord> {
  const key = await sumKey(item.url);
  const cached: SummaryRecord | null = await env.NEWS_KV.get(key, 'json');
  if (cached) return cached;

  let record: SummaryRecord = { failed: true, at: new Date().toISOString() };
  try {
    if (!(await isAllowedByRobots(env, item.url))) throw new Error('disallowed by robots.txt');
    const res = await fetch(item.url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) throw new Error(`article ${res.status}`);
    const article = await extractArticle(res);
    const text = article.body.length >= 120 ? article.body : [item.summary, article.description, article.body].filter(Boolean).join('\n');
    if (text.length < 60) throw new Error('body too short');
    const summary = await summarize(env, item.title, text);
    if (summary) record = { summary, at: new Date().toISOString() };
  } catch (e) {
    console.error('summary failed', item.url, String(e));
  }
  await env.NEWS_KV.put(key, JSON.stringify(record), { expirationTtl: record.failed ? FAIL_TTL : SUMMARY_TTL });
  return record;
}

async function overlaySummaries(env: any, data: any) {
  for (const cat of Object.keys(FEEDS)) {
    const items: NewsItem[] = data[cat] || [];
    await Promise.all(
      items.map(async item => {
        const rec: SummaryRecord | null = await env.NEWS_KV.get(await sumKey(item.url), 'json');
        if (rec?.summary) { item.summary = rec.summary; item.summaryKind = 'ai'; }
      })
    );
    data[cat] = items.filter(i => i.summary).slice(0, MAX_ITEMS);
  }
  return data;
}

async function warmSummaries(env: any, data: any, limit: number) {
  const queue: NewsItem[] = [];
  for (let i = 0; i < CANDIDATES; i++) {
    for (const cat of Object.keys(FEEDS)) {
      const it = (data[cat] || [])[i];
      if (it) queue.push(it);
    }
  }
  const todo: NewsItem[] = [];
  for (const item of queue) {
    if (todo.length >= limit) break;
    if (!(await env.NEWS_KV.get(await sumKey(item.url)))) todo.push(item);
  }
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(item => getOrCreateSummary(env, item)));
  }
}

// ====================== ニュース一覧 ======================
async function buildNews(env: any, previous: any) {
  const data: any = { version: DATA_VERSION };
  for (const [category, urls] of Object.entries(FEEDS)) {
    const items: NewsItem[] = [];
    for (const url of urls) {
      if (items.length >= CANDIDATES) break;
      try {
        const feed = await fetchFeed(url);
        for (const i of feed.items) {
          if (items.some(x => x.url === i.url)) continue;
          items.push(i);
          if (items.length >= CANDIDATES) break;
        }
      } catch (e) {
        console.error('feed failed', category, url, String(e));
      }
    }
    data[category] = items.length ? items : previous?.[category] || [];
  }
  data.last_updated = new Date().toISOString();
  return data;
}

async function refreshNews(env: any, warm: number) {
  const prevString = await env.NEWS_KV.get('latest_raw');
  const previous = prevString ? JSON.parse(prevString) : null;
  const data = await buildNews(env, previous?.version === DATA_VERSION ? previous : null);
  const hasAny = Object.keys(FEEDS).some(k => data[k]?.length);
  if (!hasAny) return previous;
  await env.NEWS_KV.put('latest_raw', JSON.stringify(data));
  if (warm > 0) await warmSummaries(env, data, warm);
  return data;
}

async function loadRaw(env: any, ctx: any) {
  const s = await env.NEWS_KV.get('latest_raw');
  const raw = s ? JSON.parse(s) : null;
  if (!raw || raw.version !== DATA_VERSION) {
    const fresh = await refreshNews(env, 0);
    if (fresh) ctx?.waitUntil?.(warmSummaries(env, fresh, WARM_ON_CRON));
    return fresh;
  }
  if (Date.now() - new Date(raw.last_updated).getTime() > 13 * 3600 * 1000) ctx?.waitUntil?.(refreshNews(env, 0));
  return raw;
}

// ====================== 質問への回答・難しい単語 ======================
const ASK_MAX_QUESTION = 200;
const ASK_MAX_HISTORY = 6;
const ASK_RATE_PER_HOUR = 40;
const ASK_CACHE_TTL = 60 * 60 * 24 * 3;

type ChatTurn = { role: 'user' | 'assistant'; content: string };

function findItem(raw: any, url: string): NewsItem | undefined {
  if (!raw || !url) return undefined;
  for (const cat of Object.keys(FEEDS)) {
    const hit = (raw[cat] || []).find((i: NewsItem) => i.url === url);
    if (hit) return hit;
  }
  return undefined;
}

async function articleContext(env: any, item?: NewsItem): Promise<string> {
  if (!item) return '';
  const rec: SummaryRecord | null = await env.NEWS_KV.get(await sumKey(item.url), 'json');
  const summary = rec?.summary || item.summary || '';
  return `ニュースのタイトル：${item.title}\nニュースの内容：${summary}${item.source ? `\n出典：${item.source}` : ''}`;
}

function aiText(res: any): string {
  return String(res?.response ?? res?.choices?.[0]?.message?.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

async function hashKey(prefix: string, text: string) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return prefix + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function rateLimited(env: any, request: Request): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const n = parseInt((await env.NEWS_KV.get(key)) || '0', 10);
  if (n >= ASK_RATE_PER_HOUR) return true;
  await env.NEWS_KV.put(key, String(n + 1), { expirationTtl: 3700 });
  return false;
}

async function answerQuestion(env: any, question: string, item: NewsItem | undefined, history: ChatTurn[]): Promise<string | null> {
  if (!env.AI) return null;
  const context = await articleContext(env, item);
  const messages: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        'あなたはニュースを読み上げるロボット「ニュースサモナー」です。ユーザーはニュースを聞いていて、' +
        'わからない言葉や内容について質問します。中学生にもわかる言葉で、「です・ます」調で、2〜3文・150字以内で答えてください。' +
        'ニュースの中身についてはニュースの内容に書かれていることだけを根拠にし、言葉の意味や背景は一般的な知識で説明してかまいません。' +
        '確かでないことは「はっきりとはわかりません」と正直に言い、作り話や推測を事実のように言わないこと。' +
        '箇条書き、記号、URL、前置きは使わず、答えの本文だけを出力してください。' +
        (context ? `\n\n【いま話題にしているニュース】\n${context}` : '')
    },
    ...history.slice(-ASK_MAX_HISTORY).map(t => ({ role: t.role, content: t.content.slice(0, 400) })),
    { role: 'user', content: question }
  ];
  try {
    const res = await env.AI.run(env.SUMMARY_MODEL || DEFAULT_MODEL, { messages, max_tokens: 400, temperature: 0.3 });
    const out = aiText(res).replace(/^(答え|回答)[:：]\s*/, '').replace(/\s+/g, ' ');
    if (out.length < 5 || !hasJapanese(out)) return null;
    return truncateSentences(out, 220);
  } catch (e) {
    console.error('AI answer failed', e);
    return null;
  }
}

export function parseTerms(text: string, source: string): string[] {
  let list: string[] = [];
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) {
    try { list = JSON.parse(arr[0]); } catch { /* fallthrough */ }
  }
  if (!list.length) list = text.split(/[\n、,]/);
  return [...new Set(
    list
      .map(t => String(t).replace(/^[\s\-・*\d.）)「『"]+|[\s」』"]+$/g, '').trim())
      .filter(t => t.length >= 2 && t.length <= 20 && source.includes(t))
  )].slice(0, 5);
}

async function extractTerms(env: any, item: NewsItem): Promise<string[]> {
  if (!env.AI) return [];
  const context = await articleContext(env, item);
  try {
    const res = await env.AI.run(env.SUMMARY_MODEL || DEFAULT_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            '次のニュースの中から、一般の人や中学生にはわかりにくいと思われる専門用語・固有名詞・略語を最大5つ選び、' +
            '本文に書かれている表記のまま JSON の文字列配列だけで出力してください。例：["量子コンピューター","DX"]'
        },
        { role: 'user', content: context.replace(/\n出典：.*$/, '') }
      ],
      max_tokens: 200,
      temperature: 0
    });
    return parseTerms(aiText(res), context.replace(/\n出典：.*$/, '')).filter(t => !item.source || !item.source.includes(t));
  } catch (e) {
    console.error('AI terms failed', e);
    return [];
  }
}

// ====================== HTTP ======================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};
const json = (body: any, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, ...extra } });

export default {
  async scheduled(_event: any, env: any, ctx: any) {
    const p = refreshNews(env, WARM_ON_CRON);
    ctx?.waitUntil?.(p);
    await p;
  },

  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    if (url.pathname === '/api/news') {
      const raw = await loadRaw(env, ctx);
      if (!raw) return json({ last_updated: null });
      const data = await overlaySummaries(env, JSON.parse(JSON.stringify(raw)));
      ctx?.waitUntil?.(warmSummaries(env, raw, WARM_ON_REQUEST));
      return json(data, 200, { 'Cache-Control': 'public, max-age=60' });
    }

    if (url.pathname === '/api/summary') {
      const target = url.searchParams.get('url') || '';
      const raw = await loadRaw(env, ctx);
      let item: NewsItem | undefined;
      for (const cat of Object.keys(FEEDS)) item = item || (raw?.[cat] || []).find((i: NewsItem) => i.url === target);
      if (!item) return json({ error: 'unknown article' }, 404);
      const rec = await getOrCreateSummary(env, item);
      if (rec.summary) return json({ url: item.url, summary: rec.summary, summaryKind: 'ai' });
      if (item.summary) return json({ url: item.url, summary: item.summary, summaryKind: 'rss' });
      return json({ url: item.url, summary: null }, 200);
    }

    // --- ここから新規追加：XR生成API（スポンサー連携版） ---
    if (url.pathname === "/api/generate" && request.method === "POST") {
      let body: any = {};
      try { body = await request.json(); } catch { }
      const keyword = body.keyword || "cyberpunk";
      const mode = body.mode || "3d";

      if (mode === "2.5d") {
        const prompt = encodeURIComponent(`${keyword}, high quality, 3D hologram style, glowing, futuristic, 4k`);
        const imageUrl = `https://image.pollinations.ai/prompt/${prompt}`;
        return json({ url: imageUrl });
      } 
      
      if (mode === "3d") {
        let taskId = `free-${Math.floor(Math.random() * 3)}`;
        // 実装2：タイトルに「立川」が含まれていたら専用のスポンサー3Dモデル枠を発動
        if (keyword.includes("立川")) {
          taskId = "sponsor-tachikawa";
        }
        return json({ taskId });
      }
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      const taskId = url.searchParams.get("taskId") || "";
      const sampleModels = [
        "https://modelviewer.dev/shared-assets/models/Astronaut.glb",
        "https://modelviewer.dev/shared-assets/models/shiba.glb",
        "https://modelviewer.dev/shared-assets/models/RobotExpressive.glb"
      ];
      
      let modelUrl = sampleModels[0];
      
      if (taskId === "sponsor-tachikawa") {
        // スポンサー用モデル（テスト用にニール・アームストロング宇宙飛行士を指定）
        modelUrl = "https://modelviewer.dev/shared-assets/models/NeilArmstrong.glb";
      } else if (taskId.startsWith("free-")) {
        const index = parseInt(taskId.split("-")[1], 10);
        if (!isNaN(index) && sampleModels[index]) modelUrl = sampleModels[index];
      }
      return json({ status: "SUCCEEDED", progress: 100, model_urls: { glb: modelUrl } });
    }
    // --- 新規追加ここまで ---

    if (url.pathname === '/api/ask' && request.method === 'POST') {
      let body: any;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const question = String(body?.question || '').replace(/\s+/g, ' ').trim();
      if (!question) return json({ error: 'empty question' }, 400);
      if (question.length > ASK_MAX_QUESTION) return json({ error: 'question too long' }, 400);
      const history: ChatTurn[] = Array.isArray(body?.history)
        ? body.history
            .filter((t: any) => (t?.role === 'user' || t?.role === 'assistant') && typeof t?.content === 'string')
            .slice(-ASK_MAX_HISTORY)
        : [];
      const raw = await loadRaw(env, ctx);
      const item = findItem(raw, String(body?.url || ''));

      const cacheKey = history.length ? null : await hashKey('ask:', `${item?.url || ''}\n${question}`);
      if (cacheKey) {
        const hit = await env.NEWS_KV.get(cacheKey);
        if (hit) return json({ answer: hit, cached: true });
      }
      if (await rateLimited(env, request)) {
        return json({ error: 'rate limited', answer: 'たくさん質問してくれてありがとう！少し時間をおいてから、また聞いてください。' }, 429);
      }
      const answer = await answerQuestion(env, question, item, history);
      if (!answer) return json({ error: 'ai failed', answer: 'ごめんなさい、うまく答えを作れませんでした。もう一度聞いてみてください。' }, 502);
      if (cacheKey) await env.NEWS_KV.put(cacheKey, answer, { expirationTtl: ASK_CACHE_TTL });
      return json({ answer });
    }

    if (url.pathname === '/api/terms') {
      const raw = await loadRaw(env, ctx);
      const item = findItem(raw, url.searchParams.get('url') || '');
      if (!item) return json({ terms: [] }, 404);
      const key = await hashKey('terms:', item.url);
      const cached = await env.NEWS_KV.get(key, 'json');
      if (cached) return json({ terms: cached });
      const terms = await extractTerms(env, item);
      const rec: SummaryRecord | null = await env.NEWS_KV.get(await sumKey(item.url), 'json');
      await env.NEWS_KV.put(key, JSON.stringify(terms), { expirationTtl: rec?.summary ? SUMMARY_TTL : 3600 });
      return json({ terms });
    }

    if (url.pathname === '/api/refresh' && env.REFRESH_TOKEN && url.searchParams.get('token') === env.REFRESH_TOKEN) {
      const data = await refreshNews(env, WARM_ON_CRON);
      return json({ ok: true, last_updated: data?.last_updated });
    }

    return json({ error: 'Not Found' }, 404);
  }
};
