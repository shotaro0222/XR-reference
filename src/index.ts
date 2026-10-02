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

const NEWS_FEEDS = {
  entertainment: "https://news.yahoo.co.jp/rss/topics/entertainment.xml",
  business: "https://news.yahoo.co.jp/rss/topics/business.xml",
  it: "https://news.yahoo.co.jp/rss/topics/it.xml",
  funny: "https://news.yahoo.co.jp/rss/topics/local.xml"
};

async function fetchNewsArticles(url: string, limit: number = 3) {
  try {
    const response = await fetch(url);
    const xml = await response.text();
    const articles = [];
    const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g;
    let match;
    let count = 0;
    
    while ((match = itemRegex.exec(xml)) !== null && count < limit) {
      // XMLエンティティの簡易デコード
      const title = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      articles.push({ title, url: match[2] });
      count++;
    }
    return articles;
  } catch (error) {
    return [];
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const newsData: Record<string, any> = {};
    await Promise.all(
      Object.entries(NEWS_FEEDS).map(async ([category, url]) => {
        newsData[category] = await fetchNewsArticles(url, 3);
      })
    );
    newsData["last_updated"] = new Date().toISOString();
    await env.NEWS_KV.put("daily_news", JSON.stringify(newsData));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // デバッグ・手動更新兼用のエンドポイント
    if (request.method === "GET" && (url.pathname === "/api/news" || url.pathname === "/api/refresh-news")) {
      let cachedNews = await env.NEWS_KV.get("daily_news");
      
      // KVにデータがない、または強制リフレッシュしたい場合はその場で取得して保存
      if (!cachedNews || url.pathname === "/api/refresh-news") {
        const newsData: Record<string, any> = {};
        await Promise.all(
          Object.entries(NEWS_FEEDS).map(async ([category, feedUrl]) => {
            newsData[category] = await fetchNewsArticles(feedUrl, 3);
          })
        );
        newsData["last_updated"] = new Date().toISOString();
        cachedNews = JSON.stringify(newsData);
        await env.NEWS_KV.put("daily_news", cachedNews);
      }

      return new Response(cachedNews, { 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // AR生成エンドポイント
    if (request.method === "POST" && url.pathname === "/api/generate") {
      try {
        const { keyword, mode } = await request.json() as { keyword: string, mode: '2.5d' | '3d' };
        const timestamp = Date.now();
        const safeKeyword = keyword.replace(/[^a-zA-Z0-9]/g, '_');

        if (mode === '2.5d') {
          const prompt = `A highly detailed, isolated 3D-style render of ${keyword}, solid black background, photorealistic`;
          const aiResponse = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', { prompt });
          
          const filename = `${safeKeyword}_${timestamp}.png`;
          await env.BUCKET.put(filename, aiResponse);

          return new Response(JSON.stringify({ 
            status: "success", 
            type: "image",
            url: `https://pub-your-r2-domain.r2.dev/${filename}` 
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: "Generation failed" }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};