// ElevenLabs による読み上げ音声（アバターの声）
//
// 使い方（秘密情報は git に入れない）
//   npx wrangler secret put ELEVENLABS_API_KEY   … https://elevenlabs.io/app/developers/api-keys で発行したキー
// 声・モデル・月の上限は /admin の「読み上げ音声」で設定する（未設定ならアカウントの最初の声を使う）
//
// - 同じ文章の音声は R2 に保存して使い回す（2回目以降は ElevenLabs の文字数を消費しない）
// - キー未設定・上限超過・エラー時はフロント側がブラウザの読み上げに自動で切り替える
// - 他サイトから無料の読み上げ API として使われないよう、Origin と回数で制限する

import { adminFrom, loadConfig } from './biz';

const API = 'https://api.elevenlabs.io';
const MAX_TEXT = 400;
const RATE_PER_HOUR = 400; // 1IP あたり、キャッシュにない文章の生成回数
const OUTPUT = 'mp3_44100_64';
export const TTS_MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_v3'];
const DEFAULT_MODEL = 'eleven_flash_v2_5';
const DEFAULT_ORIGINS = ['https://newssummoner.com', 'https://www.newssummoner.com', 'http://localhost:3000'];

type Deps = { json: (body: any, status?: number, extra?: Record<string, string>) => Response; corsHeaders: Record<string, string>; hashKey: (p: string, t: string) => Promise<string> };

const month = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
const clean = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

function originAllowed(request: Request, env: any): boolean {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return false;
  const list = String(env.TTS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return (list.length ? list : DEFAULT_ORIGINS).includes(origin);
}

async function settings(env: any) {
  const s: any = (await loadConfig(env)).settings || {};
  return {
    enabled: !!env.ELEVENLABS_API_KEY && s.ttsEnabled !== false,
    voiceId: String(s.ttsVoiceId || env.ELEVENLABS_VOICE_ID || ''),
    model: TTS_MODELS.includes(s.ttsModel) ? s.ttsModel : DEFAULT_MODEL,
    monthlyLimit: Math.max(0, parseInt(s.ttsMonthlyLimit, 10) || 0) // 0 = アプリ側の上限なし（ElevenLabs のプランの上限のみ）
  };
}

async function listVoices(env: any): Promise<any[]> {
  const r = await fetch(`${API}/v1/voices`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
  if (!r.ok) throw new Error(`voices ${r.status}`);
  const d: any = await r.json();
  return (d?.voices || []).map((v: any) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels || {},
    preview: v.preview_url
  }));
}

// 声が未設定のときは、アカウントの最初の声を使う（1日キャッシュ）
async function resolveVoice(env: any, voiceId: string): Promise<string> {
  if (voiceId) return voiceId;
  const cached = await env.NEWS_KV.get('tts:default-voice');
  if (cached) return cached;
  const voices = await listVoices(env);
  const pick = voices.find(v => /ja|japanese/i.test(`${v.labels?.language || ''} ${v.labels?.accent || ''}`)) || voices[0];
  if (!pick) throw new Error('no voice');
  await env.NEWS_KV.put('tts:default-voice', pick.id, { expirationTtl: 86400 });
  return pick.id;
}

async function synthesize(env: any, text: string, voiceId: string, model: string): Promise<{ audio?: ArrayBuffer; status: number; error?: string }> {
  const call = (withLang: boolean) =>
    fetch(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT}`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: model,
        ...(withLang ? { language_code: 'ja' } : {}),
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
  // 言語指定に対応するのは v2.5 系のみ。対応外で弾かれたら指定なしでもう一度
  const useLang = /_v2_5$/.test(model);
  let r = await call(useLang);
  if (!r.ok && useLang && (r.status === 400 || r.status === 422)) r = await call(false);
  if (!r.ok) return { status: r.status, error: (await r.text()).slice(0, 300) };
  return { status: 200, audio: await r.arrayBuffer() };
}

async function getAudio(env: any, d: Deps, text: string, opt: { voiceId: string; model: string; monthlyLimit: number }, request: Request | null) {
  const voiceId = await resolveVoice(env, opt.voiceId);
  const key = (await d.hashKey('tts/', `${voiceId}\n${opt.model}\n${text}`)) + '.mp3';
  const hit = env.BUCKET ? await env.BUCKET.get(key) : null;
  if (hit) return { body: hit.body as ReadableStream | ArrayBuffer, cached: true };

  if (request) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rk = `rl:tts:${ip}:${Math.floor(Date.now() / 3600000)}`;
    const n = parseInt((await env.NEWS_KV.get(rk)) || '0', 10);
    if (n >= RATE_PER_HOUR) return { error: 'rate limited', status: 429 };
    await env.NEWS_KV.put(rk, String(n + 1), { expirationTtl: 3700 });
  }
  const usedKey = `tts:chars:${month()}`;
  const used = parseInt((await env.NEWS_KV.get(usedKey)) || '0', 10);
  if (opt.monthlyLimit && used + text.length > opt.monthlyLimit) return { error: 'monthly limit', status: 429 };

  const res = await synthesize(env, text, voiceId, opt.model);
  if (!res.audio) {
    console.error('elevenlabs', res.status, res.error);
    return { error: 'tts failed', status: 502, detail: res.error };
  }
  await env.NEWS_KV.put(usedKey, String(used + text.length), { expirationTtl: 40 * 86400 });
  if (env.BUCKET) await env.BUCKET.put(key, res.audio, { httpMetadata: { contentType: 'audio/mpeg' } });
  return { body: res.audio, cached: false };
}

export async function handleTts(request: Request, env: any, ctx: any, url: URL, d: Deps): Promise<Response | null> {
  const { json } = d;
  const path = url.pathname;

  // フロントが最初に1回だけ確認する（ElevenLabs を使うかどうか）
  if (path === '/api/tts/status') {
    const s = await settings(env);
    return json({ enabled: s.enabled }, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  if (path === '/api/tts' && request.method === 'POST') {
    const s = await settings(env);
    if (!s.enabled) return json({ error: 'disabled' }, 503);
    if (!originAllowed(request, env)) return json({ error: 'forbidden' }, 403);
    const body: any = await request.json().catch(() => null);
    const text = clean(body?.text);
    if (!text) return json({ error: 'empty text' }, 400);
    try {
      const r: any = await getAudio(env, d, text, s, request);
      if (!r.body) return json({ error: r.error }, r.status || 502);
      return new Response(r.body, {
        headers: { ...d.corsHeaders, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=604800', 'X-TTS-Cache': r.cached ? 'hit' : 'miss' }
      });
    } catch (e) {
      console.error('tts', e);
      return json({ error: 'tts failed' }, 502);
    }
  }

  // ---------- 管理画面：声の一覧・使用量・試聴 ----------
  if (path === '/api/admin/tts' || path === '/api/admin/tts/test') {
    if (!(await adminFrom(request, env))) return json({ error: 'unauthorized' }, 401);
    if (!env.ELEVENLABS_API_KEY) return json({ configured: false });

    if (path === '/api/admin/tts') {
      const s = await settings(env);
      const [voices, sub] = await Promise.all([
        listVoices(env).catch(e => ({ error: String(e?.message || e) })),
        fetch(`${API}/v1/user/subscription`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      ]);
      return json({
        configured: true,
        enabled: s.enabled,
        models: TTS_MODELS,
        voices: Array.isArray(voices) ? voices : [],
        voicesError: Array.isArray(voices) ? undefined : (voices as any).error,
        usedThisMonth: parseInt((await env.NEWS_KV.get(`tts:chars:${month()}`)) || '0', 10),
        subscription: sub
          ? { tier: sub.tier, count: sub.character_count, limit: sub.character_limit, resetAt: sub.next_character_count_reset_unix }
          : null
      });
    }

    // 試聴（保存前の声・モデルでも試せる）
    const body: any = await request.json().catch(() => ({}));
    const s = await settings(env);
    const text = clean(body?.text) || 'こんにちは。ニュースサモナーです。今日のニュースをお伝えします。';
    const model = TTS_MODELS.includes(body?.model) ? body.model : s.model;
    try {
      const r: any = await getAudio(env, d, text, { voiceId: String(body?.voiceId || s.voiceId), model, monthlyLimit: 0 }, null);
      if (!r.body) return json({ error: r.detail || r.error }, r.status || 502);
      return new Response(r.body, { headers: { ...d.corsHeaders, 'Content-Type': 'audio/mpeg' } });
    } catch (e: any) {
      return json({ error: String(e?.message || e) }, 502);
    }
  }

  return null;
}
