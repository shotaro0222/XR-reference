export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // --- 1. ニュース配信API（オモシロ復活＆件数増加） ---
    if (url.pathname === "/api/news") {
      const newsData = {
        it: [
          { title: "高性能AI普及へ 年内に行動計画", url: "https://news.yahoo.co.jp/" },
          { title: "セコマ個人情報漏えい 第三者閲覧", url: "https://news.yahoo.co.jp/" },
          { title: "次世代スマホ、来月ついに発表か", url: "https://news.yahoo.co.jp/" },
          { title: "量子コンピューター、実用化へ新技術", url: "https://news.yahoo.co.jp/" },
          { title: "都内で自動運転タクシーの実験開始", url: "https://news.yahoo.co.jp/" },
          { title: "AIによる業務効率化、8割の企業が検討", url: "https://news.yahoo.co.jp/" }
        ],
        business: [
          { title: "佐川急便 宅配便平均13%値上げへ", url: "https://news.yahoo.co.jp/" },
          { title: "東北3地銀 28年4月統合向け協議へ", url: "https://news.yahoo.co.jp/" },
          { title: "日経平均反発、一時4万円台を回復", url: "https://news.yahoo.co.jp/" },
          { title: "主要コンビニ3社、増益基調を維持", url: "https://news.yahoo.co.jp/" },
          { title: "円安進行、輸出企業の業績を押し上げ", url: "https://news.yahoo.co.jp/" },
          { title: "国内スタートアップ投資額が過去最高に", url: "https://news.yahoo.co.jp/" }
        ],
        entertainment: [
          { title: "宮根誠司「ミヤネ屋」最終回で涙", url: "https://news.yahoo.co.jp/" },
          { title: "綾瀬はるか 天然発言で会場沸かす", url: "https://news.yahoo.co.jp/" },
          { title: "大ヒット映画の続編、来夏公開決定", url: "https://news.yahoo.co.jp/" },
          { title: "人気アイドルグループ、電撃解散を発表", url: "https://news.yahoo.co.jp/" },
          { title: "著名俳優が語る、舞台裏のマル秘エピソード", url: "https://news.yahoo.co.jp/" },
          { title: "新作アニメ、初回放送で世界トレンド1位", url: "https://news.yahoo.co.jp/" }
        ],
        funny: [
          { title: "流行語ドパガキどう広がった 分析", url: "https://news.yahoo.co.jp/" },
          { title: "犬が猫に説教？ネットで話題の動画", url: "https://news.yahoo.co.jp/" },
          { title: "小学生のテスト珍回答にSNS爆笑", url: "https://news.yahoo.co.jp/" },
          { title: "UFO目撃情報？実はただの街灯だった", url: "https://news.yahoo.co.jp/" },
          { title: "店長手作りの「変な看板」が大人気", url: "https://news.yahoo.co.jp/" },
          { title: "街で見かけた不思議なファッション", url: "https://news.yahoo.co.jp/" }
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
        const prompt = encodeURIComponent(`${keyword}, high quality, 3D hologram style, glowing, futuristic, 4k`);
        const imageUrl = `https://image.pollinations.ai/prompt/${prompt}`;
        return new Response(JSON.stringify({ url: imageUrl }), { headers: corsHeaders });
      } 
      
      if (mode === "3d") {
        const modelIndex = Math.floor(Math.random() * 3);
        return new Response(JSON.stringify({ taskId: `free-${modelIndex}` }), { headers: corsHeaders });
      }
    }

    // --- 3. 3D進捗確認API (完全無料版) ---
    if (url.pathname === "/api/status" && request.method === "GET") {
      const taskId = url.searchParams.get("taskId") || "";
      const sampleModels = [
        "https://modelviewer.dev/shared-assets/models/Astronaut.glb",
        "https://modelviewer.dev/shared-assets/models/shiba.glb",
        "https://modelviewer.dev/shared-assets/models/RobotExpressive.glb"
      ];
      let modelUrl = sampleModels[0];
      if (taskId.startsWith("free-")) {
        const index = parseInt(taskId.split("-")[1], 10);
        if (!isNaN(index) && sampleModels[index]) modelUrl = sampleModels[index];
      }
      return new Response(JSON.stringify({ status: "SUCCEEDED", progress: 100, model_urls: { glb: modelUrl } }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders });
  }
};