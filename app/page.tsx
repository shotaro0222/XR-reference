'use client'

import { useState } from 'react';

export default function ARArticleExtension() {
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'2.5d' | '3d'>('2.5d');
  const [loading, setLoading] = useState(false);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!keyword) return;
    setLoading(true);
    setAssetUrl(null);

    try {
      // Cloudflare WorkerのAPIを叩く
      const res = await fetch('https://ar-generator-api.your-subdomain.workers.dev/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, mode })
      });
      
      const data = await res.json();
      if (data.url) {
        setAssetUrl(data.url);
      }
    } catch (error) {
      console.error("生成エラー:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6 flex flex-col items-center font-sans">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm p-6 mb-8">
        <h1 className="text-xl font-bold mb-4 text-gray-800">メディアAR拡張機能 (MVP)</h1>
        
        <p className="text-sm text-gray-500 mb-4">
          記事内のキーワードをタップした想定で入力してください。
        </p>

        <input 
          type="text" 
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="例: 古代の壺, サイバーパンクな時計..."
          className="w-full border p-3 rounded-lg mb-4 text-black"
        />

        <div className="flex gap-4 mb-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="radio" 
              name="mode" 
              value="2.5d" 
              checked={mode === '2.5d'} 
              onChange={() => setMode('2.5d')} 
            />
            <span className="text-gray-700">2.5D (高速・画像)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="radio" 
              name="mode" 
              value="3d" 
              checked={mode === '3d'} 
              onChange={() => setMode('3d')} 
            />
            <span className="text-gray-700">3D (リッチ・GLB)</span>
          </label>
        </div>

        <button 
          onClick={handleGenerate}
          disabled={loading || !keyword}
          className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? '生成中...' : 'AR空間に召喚する'}
        </button>
      </div>

      {/* ARビューア領域 */}
      {assetUrl && (
        <div className="w-full max-w-md h-96 bg-gray-200 rounded-xl overflow-hidden relative shadow-inner">
          {mode === '2.5d' ? (
            // 2.5D表示: CSSで簡易的なホログラム風にオーバーレイ
            <div className="absolute inset-0 flex items-center justify-center p-4">
               {/* 実際のAR実装時はカメラストリーム上に合成 */}
              <img src={assetUrl} alt="Generated 2.5D" className="max-h-full object-contain drop-shadow-2xl animate-pulse" />
            </div>
          ) : (
            // 3D表示: model-viewerを使用（デバイスのAR機能へのボタンが自動表示されます）
            // ※動作確認のためにはHTMLヘッダーに <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.3.0/model-viewer.min.js"></script> の追加が必要です
            // @ts-ignore
            <model-viewer 
              src={assetUrl} 
              ar 
              ar-modes="webxr scene-viewer quick-look" 
              camera-controls 
              auto-rotate
              style={{ width: '100%', height: '100%' }}
            />
          )}
        </div>
      )}
    </div>
  );
}