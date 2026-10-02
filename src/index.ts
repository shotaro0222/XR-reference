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
    // Yahoo RSS対策としてUser-Agentを指定
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!response.ok) {
      console.error(`RSS Fetch failed for ${url}: Status ${response.status}`);
      return [];
    }

    const xml = await response.text();
    const articles = [];
    const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g;
    let match;
    let count = 0;
    
    while ((match = itemRegex.exec(xml)) !== null && count < limit) {
      const title = match[1]
        .replace(/<!\[CDATA\[/g, '')         .replace(/\]\]>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      articles.push({ title, url: match[2] });
      count++;
    }
    return articles;
  } catch (error) {
    console.error(`Error fetching RSS from ${url}:`, error);
    return [];
  }
}

async function getOrRefreshNews(env: Env, forceRefresh: boolean = false) {
  let cachedNews = await env.NEWS_KV.get("daily_news");
  
  if (!cachedNews || forceRefresh) {
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
  return cachedNews;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await getOrRefreshNews(env, true);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ニュース取得・手動更新API
    if (request.method === "GET" && (url.pathname === "/api/news" || url.pathname === "/api/refresh-news")) {
      try {
        const forceRefresh = url.pathname === "/api/refresh-news";
        const newsJson = await getOrRefreshNews(env, forceRefresh);
        
        return new Response(newsJson, { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: "Failed to load news", details: err?.message }), {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    // AR生成API
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