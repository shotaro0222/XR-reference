export interface Env {
  AI: any;
  BUCKET: R2Bucket;
  NEWS_KV: KVNamespace;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// 各カテゴリのRSSフィードURL（例としてYahooニュース等を使用）
const NEWS_FEEDS = {
  entertainment: "https://news.yahoo.co.jp/rss/topics/entertainment.xml",
  business: "https://news.yahoo.co.jp/rss/topics/business.xml",
  it: "https://news.yahoo.co.jp/rss/topics/it.xml",
  funny: "https://news.yahoo.co.jp/rss/topics/local.xml" // おもしろ/ローカル系
};

// RSSから指定件数の記事を抽出するヘルパー関数
async function fetchNewsArticles(url: string, limit: number = 3) {
  try {
    const response = await fetch(url);
    const xml = await response.text();
    const articles = [];
    
    // Cloudflare Workers環境を軽量に保つため正規表現でパース
    const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g;
    let match;
    let count = 0;
    
    while ((match = itemRegex.exec(xml)) !== null && count < limit) {
      articles.push({ title: match[1], url: match[2] });
      count++;
    }
    return articles;
  } catch (error) {
    return [];
  }
}

export default {
  // ==========================================
  // [1] 自動取得バッチ (Cron Trigger)
  // ==========================================
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const newsData: Record<string, any> = {};

    // 4カテゴリのニュースを並行して取得
    await Promise.all(
      Object.entries(NEWS_FEEDS).map(async ([category, url]) => {
        newsData[category] = await fetchNewsArticles(url, 3);
      })
    );

    newsData["last_updated"] = new Date().toISOString();

    // 取得したニュースをKVに保存（有効期限を設定することも可能）
    await env.NEWS_KV.put("daily_news", JSON.stringify(newsData));
  },

  // ==========================================
  // [2] ユーザー向けAPIエンドポイント
  // ==========================================
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 追加: ニュース取得用エンドポイント
    if (request.method === "GET" && url.pathname === "/api/news") {
      // KVから最新のニュースを取得
      const cachedNews = await env.NEWS_KV.get("daily_news");
      
      if (!cachedNews) {
        return new Response(JSON.stringify({ error: "News not ready" }), { status: 404, headers: corsHeaders });
      }

      return new Response(cachedNews, { 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // （前回までのAR生成APIロジックはそのまま残す）
    if (request.method === "POST" && url.pathname === "/api/generate") {
      // ... (前回のAR生成コード)
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }

    return new Response("Not Found", { status: 404 });
  }
};