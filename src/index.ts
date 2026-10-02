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
    // 【修正箇所】Yahoo側からBotとして弾かれないようにUser-Agentを付与
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    
    if (!response.ok) return [];

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
        
        // 【修正箇所】日本語キーワードでもファイル名としてR2に保存できるようにエンコード処理を追加
        const safeKeyword = encodeURIComponent(keyword).replace(/[^a-zA-Z0-9_-]/g, '');

        if (mode === '2.5d') {
          const prompt = `A highly detailed, isolated 3D-style render of ${keyword}, solid black background, photorealistic`;
          const aiResponse = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', { prompt });
          
          const filename = `${safeKeyword}_${timestamp}.png`;
          await env.BUCKET.put(filename, aiResponse);

          return new Response(JSON.stringify({ 
            status: "success", 
            type: "image",
            // ★以下のURLをR2のパブリックURL（またはカスタムドメイン）に変更してください★
            url: `https://pub-your-r2-domain.r2.dev/${filename}` 
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          
        } else if (mode === '3d') {
          // 【修正箇所】未実装の3Dモードがリクエストされた場合でもフロントエンドがフリーズしないようにエラーを返す
          return new Response(JSON.stringify({ error: "3D mode is not implemented yet" }), { 
            status: 400, 
            headers: { ...corsHeaders, "Content-Type": "application/json" } 
          });
        }
      } catch (error) {
        // 【修正箇所】エラー時にもCORSヘッダーを返す（フロントエンドで詳細なエラーを拾うため）
        return new Response(JSON.stringify({ error: "Generation failed" }), { 
          status: 500, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
    }

    // 【修正箇所】404エラー時にもCORSヘッダーを返す
    return new Response(JSON.stringify({ error: "Not Found" }), { 
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
};