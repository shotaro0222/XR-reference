// News Summoner：マネタイズ機能（掲載枠・提携メディア・サイネージ端末・プレミアム・集計・3Dアセット・管理API）
//
// 運用の手間を減らすため、設定はすべて KV の1つのJSON（cfg:v1）にまとめ、/admin 画面から編集する。
// - 掲載枠（placements）
//     sponsor … 企業タイアップ。キーワードに合うニュースに「3Dで見る（PR）」を出す
//     local   … 自治体・観光PR。「ローカル」カテゴリに独自ニュースとして並ぶ
// - 提携メディア（partners） … 記事下に埋め込む XR ウィジェットの利用先。ドメインで許可
// - サイネージ端末（devices） … 端末キーで会話の回数制限をゆるめ、地域情報を会話に使う
// - プレミアム … 管理画面で発行するコード、または Stripe の支払いリンク（任意）で有効化
// - 集計 … D1（任意）に日別の表示・タップ数を保存し、スポンサー／自治体へのレポートに使う
// - 3Dアセット … R2 に GLB を保存して /assets/ から配信

export type Placement = {
  id: string;
  type: 'sponsor' | 'local';
  active: boolean;
  title: string;
  sponsor: string; // 表示する提供者名（企業名・自治体名）
  description: string; // 吹き出しと読み上げに使う紹介文
  glbUrl: string;
  linkUrl?: string;
  linkLabel?: string;
  keywords?: string[]; // sponsor: ニュースのタイトル・要約にこの語が含まれたら表示
  region?: string; // local: 地域名
  realScale?: boolean; // AR で実物大（拡大縮小なし）にするか
  startAt?: string; // YYYY-MM-DD
  endAt?: string;
};
export type Partner = { id: string; name: string; domains: string[]; active: boolean; plan?: string; note?: string };
export type Device = { id: string; name: string; key: string; active: boolean; region?: string };
export type Settings = {
  premiumEnabled: boolean;
  premiumLinkUrl?: string; // Stripe Payment Link（成功時URLに ?premium_session={CHECKOUT_SESSION_ID} を設定）
  premiumPrice?: string; // 表示用（例：月額 300円）
  premiumDays?: number; // 単発購入・コードの有効日数の既定値
  contactUrl?: string; // 企業・自治体向け問い合わせ先
};
export type BizConfig = { placements: Placement[]; partners: Partner[]; devices: Device[]; settings: Settings };

const CFG_KEY = 'cfg:v1';
const DEFAULT_CFG: BizConfig = {
  placements: [],
  partners: [],
  devices: [],
  settings: { premiumEnabled: true, premiumPrice: '月額 300円', premiumDays: 31 }
};

export const EVENT_KINDS = new Set([
  'sponsor_impression', 'sponsor_open', 'sponsor_link',
  'local_impression', 'local_open', 'local_link',
  'photo', 'embed_view', 'embed_play', 'signage_play', 'signage_talk', 'premium_activate'
]);

type Deps = {
  json: (body: any, status?: number, extra?: Record<string, string>) => Response;
  corsHeaders: Record<string, string>;
  extractArticle: (res: Response) => Promise<{ title?: string; description?: string; body: string }>;
  summarize: (env: any, title: string, body: string) => Promise<string | null>;
  hashKey: (prefix: string, text: string) => Promise<string>;
  UA: string;
};

// ---------------- 設定 ----------------
let cfgCache: { at: number; cfg: BizConfig } | null = null;

export async function loadConfig(env: any): Promise<BizConfig> {
  if (cfgCache && Date.now() - cfgCache.at < 30_000) return cfgCache.cfg;
  const stored = (await env.NEWS_KV.get(CFG_KEY, 'json')) as Partial<BizConfig> | null;
  const cfg: BizConfig = {
    placements: stored?.placements || [],
    partners: stored?.partners || [],
    devices: stored?.devices || [],
    settings: { ...DEFAULT_CFG.settings, ...(stored?.settings || {}) }
  };
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}

async function saveConfig(env: any, cfg: BizConfig) {
  await env.NEWS_KV.put(CFG_KEY, JSON.stringify(cfg));
  cfgCache = { at: Date.now(), cfg };
}

const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export function livePlacements(cfg: BizConfig): Placement[] {
  const today = todayJst();
  return cfg.placements.filter(
    p => p.active && p.glbUrl && (!p.startAt || p.startAt <= today) && (!p.endAt || today <= p.endAt)
  );
}

const str = (v: any, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slug = (v: any) => str(v, 64).replace(/[^a-zA-Z0-9_-]/g, '');
const isUrl = (v: string) => /^https:\/\/[^\s]+$/.test(v) || /^\/[^\s]*$/.test(v);

// 管理画面から来た設定を検証・整形（壊れた値で公開画面が落ちないように）
export function sanitizeConfig(input: any): BizConfig {
  const placements: Placement[] = (Array.isArray(input?.placements) ? input.placements : [])
    .map((p: any): Placement => ({
      id: slug(p.id) || crypto.randomUUID().slice(0, 8),
      type: p.type === 'local' ? 'local' : 'sponsor',
      active: !!p.active,
      title: str(p.title, 120),
      sponsor: str(p.sponsor, 60),
      description: str(p.description, 600),
      glbUrl: isUrl(str(p.glbUrl, 1000)) ? str(p.glbUrl, 1000) : '',
      linkUrl: isUrl(str(p.linkUrl, 1000)) ? str(p.linkUrl, 1000) : undefined,
      linkLabel: str(p.linkLabel, 30) || undefined,
      keywords: (Array.isArray(p.keywords) ? p.keywords : String(p.keywords || '').split(/[,、\n]/))
        .map((k: any) => str(k, 40)).filter(Boolean).slice(0, 30),
      region: str(p.region, 40) || undefined,
      realScale: !!p.realScale,
      startAt: /^\d{4}-\d{2}-\d{2}$/.test(p.startAt) ? p.startAt : undefined,
      endAt: /^\d{4}-\d{2}-\d{2}$/.test(p.endAt) ? p.endAt : undefined
    }))
    .filter((p: Placement) => p.title);
  const partners: Partner[] = (Array.isArray(input?.partners) ? input.partners : [])
    .map((p: any): Partner => ({
      id: slug(p.id) || crypto.randomUUID().slice(0, 8),
      name: str(p.name, 80),
      domains: (Array.isArray(p.domains) ? p.domains : String(p.domains || '').split(/[,、\s]+/))
        .map((d: any) => str(d, 100).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(Boolean).slice(0, 20),
      active: !!p.active,
      plan: str(p.plan, 40) || undefined,
      note: str(p.note, 300) || undefined
    }))
    .filter((p: Partner) => p.name);
  const devices: Device[] = (Array.isArray(input?.devices) ? input.devices : [])
    .map((d: any): Device => ({
      id: slug(d.id) || crypto.randomUUID().slice(0, 8),
      name: str(d.name, 80),
      key: slug(d.key) || crypto.randomUUID().replace(/-/g, ''),
      active: !!d.active,
      region: str(d.region, 40) || undefined
    }))
    .filter((d: Device) => d.name);
  const s = input?.settings || {};
  const settings: Settings = {
    premiumEnabled: s.premiumEnabled !== false,
    premiumLinkUrl: /^https:\/\//.test(str(s.premiumLinkUrl, 500)) ? str(s.premiumLinkUrl, 500) : undefined,
    premiumPrice: str(s.premiumPrice, 40) || undefined,
    premiumDays: Math.min(366, Math.max(1, parseInt(s.premiumDays, 10) || 31)),
    contactUrl: /^(https:\/\/|mailto:)/.test(str(s.contactUrl, 300)) ? str(s.contactUrl, 300) : undefined
  };
  return { placements, partners, devices, settings };
}

export async function findDevice(env: any, key: string): Promise<Device | undefined> {
  if (!key) return undefined;
  const cfg = await loadConfig(env);
  return cfg.devices.find(d => d.active && d.key === key);
}

// サイネージで会話するときに使う地域情報（ローカル掲載枠の紹介文）
export async function localContext(env: any, region?: string): Promise<string> {
  const cfg = await loadConfig(env);
  const locals = livePlacements(cfg).filter(p => p.type === 'local' && (!region || !p.region || p.region === region));
  if (!locals.length) return '';
  return locals.slice(0, 6).map(p => `・${p.title}（${p.region || p.sponsor}）：${p.description.slice(0, 200)}`).join('\n');
}

// ---------------- 集計（D1・任意） ----------------
let tableReady = false;
async function ensureTable(env: any) {
  if (tableReady || !env.DB) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS events (day TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, ref))'
  ).run();
  tableReady = true;
}

export async function track(env: any, kind: string, ref: string) {
  if (!env.DB || !EVENT_KINDS.has(kind)) return;
  try {
    await ensureTable(env);
    await env.DB.prepare(
      'INSERT INTO events (day, kind, ref, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(day, kind, ref) DO UPDATE SET n = n + 1'
    ).bind(todayJst(), kind, slug(ref) || '-').run();
  } catch (e) {
    console.error('track failed', e);
  }
}

// ---------------- プレミアム（署名付きトークン） ----------------
type PremiumPayload = { exp: number; src: 'code' | 'stripe'; sub?: string };
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function hmacKey(env: any) {
  const secret = env.PREMIUM_SECRET || env.ADMIN_TOKEN;
  if (!secret) throw new Error('PREMIUM_SECRET is not set');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signPremium(env: any, payload: PremiumPayload): Promise<string> {
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(body));
  return `${body}.${b64u(sig)}`;
}

async function readPremium(env: any, token: string): Promise<PremiumPayload | null> {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64uDecode(sig), new TextEncoder().encode(body));
    return ok ? JSON.parse(new TextDecoder().decode(b64uDecode(body))) : null;
  } catch {
    return null;
  }
}

async function stripeGet(env: any, path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  if (!res.ok) throw new Error(`stripe ${res.status}`);
  return res.json() as Promise<any>;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map(b => chars[b % chars.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

// ---------------- ルーティング ----------------
export async function handleBiz(request: Request, env: any, ctx: any, url: URL, d: Deps): Promise<Response | null> {
  const { json } = d;
  const path = url.pathname;

  // 3Dアセット配信（R2）
  if (path.startsWith('/assets/') && request.method === 'GET') {
    if (!env.BUCKET) return json({ error: 'no bucket' }, 404);
    const key = decodeURIComponent(path.slice('/assets/'.length));
    const obj = await env.BUCKET.get(key);
    if (!obj) return json({ error: 'Not Found' }, 404);
    const headers = new Headers({ ...d.corsHeaders });
    obj.writeHttpMetadata(headers);
    if (key.endsWith('.glb')) headers.set('Content-Type', 'model/gltf-binary');
    if (key.endsWith('.usdz')) headers.set('Content-Type', 'model/vnd.usdz+zip');
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('ETag', obj.httpEtag);
    return new Response(obj.body, { headers });
  }

  // 公開設定（掲載中の枠とプレミアムの案内）
  if (path === '/api/config') {
    const cfg = await loadConfig(env);
    const s = cfg.settings;
    return json(
      {
        placements: livePlacements(cfg).map(({ keywords, ...p }) => ({ ...p, keywords: keywords || [] })),
        premium: { enabled: s.premiumEnabled, linkUrl: s.premiumLinkUrl, price: s.premiumPrice, stripe: !!env.STRIPE_SECRET_KEY },
        contactUrl: s.contactUrl
      },
      200,
      { 'Cache-Control': 'public, max-age=60' }
    );
  }

  // 表示・タップの記録
  if (path === '/api/event' && request.method === 'POST') {
    const body: any = await request.json().catch(() => null);
    const kind = str(body?.kind, 40);
    if (!EVENT_KINDS.has(kind)) return json({ ok: false }, 400);
    ctx?.waitUntil?.(track(env, kind, str(body?.ref, 64)));
    return json({ ok: true });
  }

  // ---------- プレミアム ----------
  if (path === '/api/premium/redeem' && request.method === 'POST') {
    const body: any = await request.json().catch(() => null);
    const code = str(body?.code, 20).toUpperCase();
    const rec: any = code ? await env.NEWS_KV.get(`pcode:${code}`, 'json') : null;
    if (!rec || rec.used >= rec.uses) return json({ error: 'コードが正しくないか、使用済みです' }, 400);
    rec.used++;
    await env.NEWS_KV.put(`pcode:${code}`, JSON.stringify(rec));
    const exp = Date.now() + rec.days * 86400_000;
    ctx?.waitUntil?.(track(env, 'premium_activate', 'code'));
    return json({ token: await signPremium(env, { exp, src: 'code' }), exp });
  }

  if (path === '/api/premium/claim') {
    // Stripe の支払い完了後に戻ってきたときの確認
    const sessionId = str(url.searchParams.get('session_id'), 200);
    if (!env.STRIPE_SECRET_KEY || !/^cs_/.test(sessionId)) return json({ error: 'invalid' }, 400);
    try {
      const s = await stripeGet(env, `checkout/sessions/${encodeURIComponent(sessionId)}`);
      if (s.status !== 'complete' && s.payment_status !== 'paid') return json({ error: '支払いが完了していません' }, 402);
      const cfg = await loadConfig(env);
      const exp = Date.now() + (s.mode === 'subscription' ? 35 : cfg.settings.premiumDays || 31) * 86400_000;
      ctx?.waitUntil?.(track(env, 'premium_activate', 'stripe'));
      return json({ token: await signPremium(env, { exp, src: 'stripe', sub: s.subscription || undefined }), exp });
    } catch (e) {
      console.error('stripe claim failed', e);
      return json({ error: '確認できませんでした' }, 502);
    }
  }

  if (path === '/api/premium/status' && request.method === 'POST') {
    const body: any = await request.json().catch(() => null);
    const p = await readPremium(env, str(body?.token, 2000));
    if (!p) return json({ active: false });
    if (p.exp > Date.now() + 3 * 86400_000) return json({ active: true, exp: p.exp });
    // 月額（サブスク）は Stripe で継続中か確認して延長
    if (p.sub && env.STRIPE_SECRET_KEY) {
      try {
        const sub = await stripeGet(env, `subscriptions/${encodeURIComponent(p.sub)}`);
        if (sub.status === 'active' || sub.status === 'trialing') {
          const exp = (sub.current_period_end || sub.items?.data?.[0]?.current_period_end || Date.now() / 1000 + 31 * 86400) * 1000 + 2 * 86400_000;
          return json({ active: true, exp, token: await signPremium(env, { exp, src: 'stripe', sub: p.sub }) });
        }
      } catch (e) {
        console.error('stripe status failed', e);
        return json({ active: p.exp > Date.now(), exp: p.exp });
      }
    }
    return json({ active: p.exp > Date.now(), exp: p.exp });
  }

  // ---------- 提携メディア向け埋め込みウィジェット ----------
  if (path === '/api/embed/summary') {
    const cfg = await loadConfig(env);
    const partner = cfg.partners.find(p => p.active && p.id === url.searchParams.get('partner'));
    if (!partner) return json({ error: 'unknown partner' }, 403);
    let target: URL;
    try { target = new URL(url.searchParams.get('url') || ''); } catch { return json({ error: 'invalid url' }, 400); }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || !partner.domains.some(dm => host === dm || host.endsWith('.' + dm))) {
      return json({ error: 'domain not allowed' }, 403);
    }
    target.hash = '';
    const key = await d.hashKey('embed:', target.toString());
    ctx?.waitUntil?.(track(env, 'embed_view', partner.id));
    const cached = await env.NEWS_KV.get(key, 'json');
    if (cached) return json(cached);
    try {
      const res = await fetch(target.toString(), { headers: { 'User-Agent': d.UA, Accept: 'text/html' } });
      if (!res.ok) throw new Error(String(res.status));
      const art = await d.extractArticle(res);
      const title = art.title || '';
      const text = art.body.length >= 120 ? art.body : [art.description, art.body].filter(Boolean).join('\n');
      const summary = (text.length >= 60 && (await d.summarize(env, title, text))) || art.description || null;
      const out = { url: target.toString(), title, summary, source: partner.name };
      await env.NEWS_KV.put(key, JSON.stringify(out), { expirationTtl: summary ? 7 * 86400 : 3600 });
      return json(out);
    } catch (e) {
      console.error('embed summary failed', e);
      return json({ url: target.toString(), title: '', summary: null, source: partner.name }, 200);
    }
  }

  // ---------- 管理API ----------
  if (path.startsWith('/api/admin/')) {
    const auth = request.headers.get('Authorization') || '';
    if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);

    if (path === '/api/admin/config' && request.method === 'GET') {
      return json({ ...(await loadConfig(env)), features: { stats: !!env.DB, assets: !!env.BUCKET, stripe: !!env.STRIPE_SECRET_KEY } });
    }
    if (path === '/api/admin/config' && request.method === 'PUT') {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'invalid json' }, 400);
      const cfg = sanitizeConfig(body);
      await saveConfig(env, cfg);
      return json(cfg);
    }
    if (path === '/api/admin/upload' && request.method === 'POST') {
      if (!env.BUCKET) return json({ error: 'R2 が設定されていません' }, 400);
      const name = (url.searchParams.get('name') || 'model.glb').toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(-60);
      if (!/\.(glb|usdz|png|jpg|jpeg|webp)$/.test(name)) return json({ error: 'GLB / USDZ / 画像のみアップロードできます' }, 400);
      const key = `uploads/${todayJst()}/${crypto.randomUUID().slice(0, 8)}-${name}`;
      await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' } });
      return json({ key, url: `${url.origin}/assets/${key}` });
    }
    if (path === '/api/admin/stats') {
      if (!env.DB) return json({ rows: [], note: 'D1 が設定されていないため集計は記録されていません' });
      await ensureTable(env);
      const days = Math.min(400, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
      const since = new Date(Date.now() + 9 * 3600_000 - days * 86400_000).toISOString().slice(0, 10);
      const { results } = await env.DB.prepare(
        'SELECT kind, ref, SUM(n) AS n, MIN(day) AS first, MAX(day) AS last FROM events WHERE day >= ?1 GROUP BY kind, ref ORDER BY n DESC'
      ).bind(since).all();
      const daily = url.searchParams.get('daily')
        ? (await env.DB.prepare('SELECT day, kind, ref, n FROM events WHERE day >= ?1 ORDER BY day').bind(since).all()).results
        : undefined;
      return json({ since, rows: results, daily });
    }
    if (path === '/api/admin/codes' && request.method === 'POST') {
      const body: any = await request.json().catch(() => ({}));
      const count = Math.min(100, Math.max(1, parseInt(body?.count, 10) || 1));
      const days = Math.min(366, Math.max(1, parseInt(body?.days, 10) || 31));
      const uses = Math.min(10, Math.max(1, parseInt(body?.uses, 10) || 1));
      const note = str(body?.note, 100);
      const codes: string[] = [];
      for (let i = 0; i < count; i++) {
        const code = randomCode();
        await env.NEWS_KV.put(`pcode:${code}`, JSON.stringify({ days, uses, used: 0, note, created: new Date().toISOString() }), {
          expirationTtl: 400 * 86400
        });
        codes.push(code);
      }
      return json({ codes, days, uses });
    }
    return json({ error: 'Not Found' }, 404);
  }

  return null;
}
