'use client'

import { useState, useEffect } from 'react';

export default function ARMediaMVP() {
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'2.5d' | '3d'>('2.5d');
  const [loading, setLoading] = useState(false);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [news, setNews] = useState<any>(null);

  // 1. ページ読み込み時にニュースをWorkerから取得
  useEffect(() => {
    const fetchNews = async () => {
      try {
        const res = await fetch('https://xr-reference.kyouhitotsu-dev.workers.dev/api/news');
        const data = await res.json();
        setNews(data);
      } catch (error) {
        console.error("ニュース取得エラー:", error);
      }
    };
    fetchNews();
  }, []);

  // 2. AR生成リクエストをWorkerへ送信
  const handleGenerate = async () => {
    if (!keyword) return;
    setLoading(true);
    setAssetUrl(null);

    try {
      const res = await fetch('https://xr-reference.kyouhitotsu-dev.workers.dev/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, mode })
      });
      const data = await res.json();
      if (data.url) setAssetUrl(data.url);
    } catch (error) {
      console.error("生成エラー:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6 font-sans flex flex-col md:flex-row gap-6">
      
      {/* 左パネル：メディア記事＆ニュースセクション */}
      <div className="flex-1 space-y-6">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h1 className="text-2xl font-bold mb-4 text-gray-800">最新ニュース & AR拡張記事</h1>
          <p className="text-gray-600 text-sm mb-6">
            記事内のキーワードから、直接AR空間に3Dオブジェクトや情景を召喚できます。
          </p>
          
          {/* ニュース表示エリア */}
          {news ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {['it', 'business', 'entertainment'].map((category) => (
                <div key={category} className="border rounded-lg p-4">
                  <h3 className="font-bold text-gray-700 uppercase mb-2 border-b pb-1">{category}</h3>
                  <ul className="space-y-2 text-sm">
                    {news[category]?.map((article: any, i: number) => (
                      <li key={i}>
                        <a href={article.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                          {article.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 text-sm animate-pulse">ニュースを読み込み中...</p>
          )}
        </div>
      </div>

      {/* 右パネル：ARジェネレーターUI */}
      <div className="w-full md:w-96 bg-white rounded-xl shadow-sm p-6 flex flex-col">
        <h2 className="text-lg font-bold mb-4 text-gray-800">ARアセット生成</h2>
        
        <input 
          type="text" 
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="例: サイバーパンクな日本刀"
          className="w-full border border-gray-300 p-3 rounded-lg mb-4 text-black focus:ring-2 focus:ring-blue-500 outline-none"
        />

        <div className="flex gap-4 mb-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="mode" value="2.5d" checked={mode === '2.5d'} onChange={() => setMode('2.5d')} />
            <span className="text-gray-700 text-sm">2.5D (高速画像)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="mode" value="3d" checked={mode === '3d'} onChange={() => setMode('3d')} />
            <span className="text-gray-700 text-sm">3D (GLB)</span>
          </label>
        </div>

        <button 
          onClick={handleGenerate}
          disabled={loading || !keyword}
          className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? 'AIが生成中...' : '空間に召喚する'}
        </button>

        {/* ARビューア領域 */}
        {assetUrl && (
          <div className="mt-6 w-full h-64 bg-gray-900 rounded-xl overflow-hidden relative shadow-inner">
            {mode === '2.5d' ? (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <img src={assetUrl} alt="Generated AR Asset" className="max-h-full object-contain drop-shadow-2xl animate-pulse" />
              </div>
            ) : (
              // @ts-ignore
              <model-viewer src={assetUrl} ar auto-rotate camera-controls style={{ width: '100%', height: '100%' }} />
            )}
          </div>
        )}
      </div>

    </div>
  );
}