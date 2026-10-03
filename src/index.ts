export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    
    // CORS対応（フロントエンドからのアクセスを許可）
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 1. ニュース配信API ---
    if (url.pathname === "/api/news") {
      const newsData = {
        it: [
          { title: "高性能AI普及へ 年内に行動計画", url: "https://news.yahoo.co.jp/" },
          { title: "セコマ個人情報漏えい 第三者閲覧", url: "https://news.yahoo.co.jp/" }
        ],
        business: [
          { title: "佐川急便 宅配便平均13%値上げへ", url: "https://news.yahoo.co.jp/" },
          { title: "東北3地銀 28年4月統合向け協議へ", url: "https://news.yahoo.co.jp/" }
        ],
        entertainment: [
          { title: "宮根誠司「ミヤネ屋」最終回で涙", url: "https://news.yahoo.co.jp/" },
          { title: "綾瀬はるか 天然発言で会場沸かす", url: "https://news.yahoo.co.jp/" }
        ]
      };
      return new Response(JSON.stringify(newsData), { headers: corsHeaders });
    }

    // --- 2. 生成API (完全無料版) ---
    if (url.pathname === "/api/generate" && request.method === "POST") {
      const body: any = await request.json();
      const keyword = body.keyword || "cyberpunk";
      const mode = body.mode || "2.5d";

      if (mode === "2.5d") {
        // Pollinations.ai を使って、完全無料でキーワードから画像をAI生成
        const prompt = encodeURIComponent(`${keyword}, high quality, 3D hologram style, glowing, futuristic, 4k`);
        const imageUrl = `https://image.pollinations.ai/prompt/${prompt}`;
        return new Response(JSON.stringify({ url: imageUrl }), { headers: corsHeaders });
      } 
      
      if (mode === "3d") {
        // 3Dは無料の高品質サンプルモデルを返す（フロントエンドのポーリング処理を騙すためのダミーID）
        const modelIndex = Math.floor(Math.random() * 3); // 0〜2のランダム
        const taskId = `free-${modelIndex}`;
        return new Response(JSON.stringify({ taskId: taskId }), { headers: corsHeaders });
      }
    }

    // --- 3. 3D進捗確認API (完全無料版) ---
    if (url.pathname === "/api/status" && request.method === "GET") {
      const taskId = url.searchParams.get("taskId") || "";
      
      // 誰でも無料で使える安全なGLBモデルのURL
      const sampleModels = [
        "https://modelviewer.dev/shared-assets/models/Astronaut.glb", // 宇宙飛行士
        "https://modelviewer.dev/shared-assets/models/shiba.glb",     // 柴犬
        "https://modelviewer.dev/shared-assets/models/RobotExpressive.glb" // ロボット
      ];
      
      let modelUrl = sampleModels[0];
      if (taskId.startsWith("free-")) {
        const index = parseInt(taskId.split("-")[1], 10);
        if (!isNaN(index) && sampleModels[index]) {
          modelUrl = sampleModels[index];
        }
      }

      // 即座に「生成成功」としてフロントエンドに返す
      return new Response(JSON.stringify({
        status: "SUCCEEDED",
        progress: 100,
        model_urls: { glb: modelUrl }
      }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders });
  }
};
