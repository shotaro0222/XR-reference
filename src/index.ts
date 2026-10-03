// News Summoner backend (Cloudflare Workers)
// - Cron（JST 5:00 / 17:00）で各メディアの公式RSSを取得し、タイトル・リンク・要約(summary)をKVに保存
// - 要約はRSSが配信している記事概要(description)を使用。長いものだけWorkers AIで読み上げ用に短く整える
// - /api/news でフロントに配信

const DATA_VERSION = 2;
const MAX_ITEMS = 6;
const SUMMARY_MAX = 220; // これを超える概要はAIで短く整える（失敗時は文単位で切り詰め）
const MAX_AI_CALLS = 12; // 1回のCronでAIを呼ぶ上限
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const UA = 'Mozilla/5.0 (compatible; NewsSummoner/2.0; +https://github.com/shotaro0222/XR-reference)';

// カテゴリごとのRSS。上から順に試して、要約付きの記事が取れた最初のフィードを採用する
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

export type NewsItem = { title: string; url: string; summary?: string; source?: string; published?: string };

// ---------- RSS パース ----------
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function cleanText(s = ''): string {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = decodeEntities(t); // エスケープされたHTMLを戻してからタグを除去
  t = t
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return decodeEntities(t);
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1] : '';
}

export function parseFeed(xml: string): { source: string; items: NewsItem[] } {
  const channel = xml.match(/<channel[\s>][\s\S]*?(?=<item[\s>]|<\/channel>)/i)?.[0] || xml.match(/<feed[\s\S]*?(?=<entry[\s>])/i)?.[0] || '';
  const source = cleanText(tag(channel, 'title')).replace(/\s*[-|｜].*$/, '').trim();
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const items: NewsItem[] = [];
  for (const b of blocks) {
    const title = cleanText(tag(b, 'title'));
    let url = cleanText(tag(b, 'link'));
    if (!url) url = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] || b.match(/rdf:about="([^"]+)"/i)?.[1] || '';
    const summary = cleanText(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'))
      .replace(/[\s(（\[【]*(続きを読む|続きはこちら|全文を読む|もっと見る|Read more)[\s)）\]】»>…]*$/i, '')
      .trim();
    const published = cleanText(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'updated') || tag(b, 'published'));
    if (!title || !/^https?:\/\//.test(url)) continue;
    // 概要がタイトルと同じ・極端に短いものは要約なし扱い
    const usable = summary && summary.length >= 20 && summary !== title ? summary : undefined;
    items.push({ title, url: decodeEntities(url), summary: usable, source: source || undefined, published: published || undefined });
  }
  return { source, items };
}

// 文の区切りで maxLen 以内に収める
export function truncateSentences(text: string, maxLen = SUMMARY_MAX): string {
  if (text.length <= maxLen) return text;
  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > maxLen) break;
    out += s;
  }
  if (!out) out = text.slice(0, maxLen - 1) + '…';
  return out.trim();
}

async function fetchFeed(url: string): Promise<{ source: string; items: NewsItem[] }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
    cf: { cacheTtl: 600 }
  } as RequestInit);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return parseFeed(await res.text());
}

async function polishSummary(env: any, title: string, text: string): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const model = env.SUMMARY_MODEL || DEFAULT_MODEL;
    const res: any = await env.AI.run(model, {
      messages: [
        {
          role: 'system',
          content:
            'あなたはニュースを読み上げるアナウンサーです。与えられた記事概要だけを根拠に、日本語の「です・ます」調で、' +
            `${SUMMARY_MAX}字以内・2〜3文の読み上げ原稿にしてください。概要にない事実は絶対に足さないこと。` +
            'タイトルの繰り返し、前置き、箇条書き、記号、URLは書かず、原稿の本文だけを出力してください。'
        },
        { role: 'user', content: `タイトル：${title}\n概要：${text.slice(0, 1500)}` }
      ],
      max_tokens: 400,
      temperature: 0.2
    });
    const out = String(res?.response ?? res?.choices?.[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^[「『"]|[」』"]$/g, '')
      .trim();
    // 日本語として妥当かを簡易チェック
    if (out.length < 20 || out.length > SUMMARY_MAX * 1.5 || !/[ぁ-んァ-ヶ一-龠]/.test(out)) return null;
    return out;
  } catch (e) {
    console.error('AI summary failed', e);
    return null;
  }
}

async function buildNews(env: any, previous: any) {
  const data: any = { version: DATA_VERSION };
  let aiCalls = 0;

  for (const [category, urls] of Object.entries(FEEDS)) {
    let items: NewsItem[] = [];
    for (const url of urls) {
      try {
        const feed = await fetchFeed(url);
        // 要約付きの記事を優先
        const withSummary = feed.items.filter(i => i.summary);
        const picked = (withSummary.length >= 3 ? withSummary : feed.items).slice(0, MAX_ITEMS);
        if (picked.length) {
          items = picked;
          break;
        }
      } catch (e) {
        console.error('feed failed', category, url, e);
      }
    }

    for (const item of items) {
      if (item.summary && item.summary.length > SUMMARY_MAX) {
        let polished: string | null = null;
        if (aiCalls < MAX_AI_CALLS) {
          aiCalls++;
          polished = await polishSummary(env, item.title, item.summary);
        }
        item.summary = polished || truncateSentences(item.summary);
      }
    }

    // 取得に失敗したカテゴリは前回のデータを使い続ける
    if (!items.length && Array.isArray(previous?.[category])) items = previous[category];
    data[category] = items;
  }

  data.last_updated = new Date().toISOString();
  return data;
}

async function refreshNews(env: any) {
  const prevString = await env.NEWS_KV.get('latest_news');
  const previous = prevString ? JSON.parse(prevString) : null;
  const data = await buildNews(env, previous?.version === DATA_VERSION ? previous : null);
  const hasAny = Object.keys(FEEDS).some(k => data[k]?.length);
  if (hasAny) await env.NEWS_KV.put('latest_news', JSON.stringify(data));
  return hasAny ? data : previous;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

export default {
  // ① Cronで定期実行（JST 5:00, 17:00）
  async scheduled(_event: any, env: any, ctx: any) {
    const p = refreshNews(env);
    if (ctx?.waitUntil) ctx.waitUntil(p);
    await p;
  },

  // ② フロントエンドからのリクエスト
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    if (url.pathname === '/api/news') {
      const cached = await env.NEWS_KV.get('latest_news');
      const parsed = cached ? JSON.parse(cached) : null;
      // KVが空、または旧形式（ダミーデータ）のときはその場で取得し直す
      if (!parsed || parsed.version !== DATA_VERSION) {
        const fresh = await refreshNews(env);
        return json(fresh || { last_updated: null });
      }
      // 13時間以上更新されていなければ裏で更新（Cron失敗時の保険）
      if (Date.now() - new Date(parsed.last_updated).getTime() > 13 * 3600 * 1000) {
        ctx?.waitUntil?.(refreshNews(env));
      }
      return new Response(cached, { headers: corsHeaders });
    }

    return json({ error: 'Not Found' }, 404);
  }
};
