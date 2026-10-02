export interface Env {
  AI: any;
  BUCKET: R2Bucket;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORSプリフライトリクエストの処理
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/api/generate") {
      try {
        const { keyword, mode } = await request.json() as { keyword: string, mode: '2.5d' | '3d' };
        
        // ファイル名の生成（キャッシュ用）
        const timestamp = Date.now();
        const safeKeyword = keyword.replace(/[^a-zA-Z0-9]/g, '_');

        if (mode === '2.5d') {
          // ==========================================
          // [2.5Dモード] Cloudflare Workers AIで画像生成
          // ==========================================
          const prompt = `A highly detailed, isolated 3D-style render of ${keyword}, solid black background, photorealistic`;
          
          // SDXL等のモデルをエッジで実行
          const response = await env.AI.run(
            '@cf/stabilityai/stable-diffusion-xl-base-1.0',
            { prompt }
          );

          // R2へ保存（背景透過処理を挟む場合はここで処理）
          const filename = `${safeKeyword}_${timestamp}.png`;
          await env.BUCKET.put(filename, response);

          // 公開URLを返す (R2のパブリックドメインを設定している前提)
          return new Response(JSON.stringify({ 
            status: "success", 
            type: "image",
            url: `https://pub-your-r2-domain.r2.dev/${filename}` 
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

        } else if (mode === '3d') {
          // ==========================================
          // [3Dモード] 外部 Text-to-3D APIへのリクエスト
          // ==========================================
          // MVP用: 実際の3D生成API（Meshy等）は非同期で数分かかるため、
          // ここではAPIを叩く構造だけ作り、モックのGLB URLを返します。
          
          /* 
          const meshyResponse = await fetch('https://api.meshy.ai/v2/text-to-3d', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer YOUR_API_KEY', 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: keyword, mode: "preview" })
          });
          const { result_id } = await meshyResponse.json();
          // ※実際にはここでポーリング処理かWebhook待機を行い、R2に保存する
          */

          const filename = `${safeKeyword}_mock.glb`;
          
          return new Response(JSON.stringify({ 
            status: "success", 
            type: "model",
            // テスト用にフリーのGLBモデルURLなどを指定してUIを確認します
            url: `https://pub-your-r2-domain.r2.dev/sample_model.glb` 
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

      } catch (error) {
        return new Response(JSON.stringify({ error: "Generation failed" }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};