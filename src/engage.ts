// News Summoner：エンゲージメント機能
// - サーベイ（単一／複数／スケール／マトリクス、条件分岐、回答インセンティブ・抽選）
// - 有料サイネージ（Stripe 支払い確認 → 専用URL発行、契約者用カスタマイズAPI、更新確認）
// - サイネージのリアルタイム状態（表示モードの切替）
// - 終わらないニュースクイズ（AI生成＋カテゴリ当て）とランキング
// - キーワードで集めるローカルニュース
//
// 設定はすべて biz.ts の cfg:v1（KV）に入れ、管理画面と契約者画面から編集する。

import { adminFrom, BizConfig, Client, loadConfig, saveConfig, track } from './biz';

// ====================== 型 ======================
export type Opt = { id: string; label: string };
export type Branch = { when: string; goto: string }; // when: 選択肢ID、またはスケールの条件（">=4" など）／ goto: 設問ID か "end"
export type Question = {
  id: string;
  type: 'single' | 'multi' | 'scale' | 'matrix';
  text: string;
  required: boolean;
  options?: Opt[]; // single / multi
  maxSelect?: number; // multi
  min?: number; // scale
  max?: number;
  minLabel?: string;
  maxLabel?: string;
  rows?: Opt[]; // matrix（行＝評価対象、列＝評価）
  cols?: Opt[];
  branches?: Branch[];
};
export type Incentive = {
  type: 'none' | 'coupon' | 'lottery';
  text?: string; // 当選・特典の説明（例：ドリンク1杯無料）
  code?: string; // 店頭で見せるクーポンコード
  url?: string; // 特典ページ
  winRate?: number; // 抽選の当選確率（%）
  maxWinners?: number; // 当選者の上限
  loseText?: string;
};
export type Survey = {
  id: string;
  title: string;
  active: boolean;
  intro: string;
  thanks: string;
  questions: Question[];
  incentive: Incentive;
  owner?: string; // 契約者（サイネージ端末ID）が作ったサーベイ
  client?: string; // 依頼主（クライアント）ID。クライアント別レポートに載る
  startAt?: string;
  endAt?: string;
};
export type LocalItem = { id: string; title: string; description: string; linkUrl?: string };
export type SignagePlan = { id: string; name: string; price: number; interval: string; features: string[]; linkUrl?: string; recommended?: boolean };
export type LocalTopic = { id: string; region: string; keywords: string[]; feeds: string[] };

export type Deps = {
  json: (body: any, status?: number, extra?: Record<string, string>) => Response;
  loadRaw: (env: any, ctx: any) => Promise<any>;
  fetchFeed: (url: string) => Promise<{ source: string; items: { title: string; url: string; summary?: string; source?: string; published?: string }[] }>;
  isAllowedByRobots: (env: any, url: string) => Promise<boolean>;
  aiText: (res: any) => string;
  hashKey: (prefix: string, text: string) => Promise<string>;
  model: string;
};

export const PLAN_FEATURES: Record<string, { survey: boolean; quiz: boolean; talk: boolean }> = {
  lite: { survey: false, quiz: true, talk: false },
  standard: { survey: true, quiz: true, talk: true },
  internal: { survey: true, quiz: true, talk: true } // 管理画面で作った自社・手動契約の端末
};

export const DEFAULT_PLANS: SignagePlan[] = [
  {
    id: 'lite',
    name: 'ライト',
    price: 1980,
    interval: '月',
    features: ['AIアバターのニュース読み上げ（10ジャンル・自動更新）', 'ローカルニュース（手入力＋キーワード自動収集）', '終わらないニュースクイズ', '専用URL・管理画面']
  },
  {
    id: 'standard',
    name: 'スタンダード',
    price: 3980,
    interval: '月',
    recommended: true,
    features: ['ライトの全機能', 'タッチ／スマホで答えるアンケート（分岐・マトリクス）', '回答特典・抽選クーポン', 'アバターとの音声会話', '回答の集計・CSV出力']
  }
];

// ====================== 共通 ======================
const str = (v: any, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slug = (v: any, max = 40) => str(v, max).replace(/[^a-zA-Z0-9_-]/g, '');
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const isHttps = (v: string) => /^https:\/\/[^\s]+$/.test(v);
export const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

function opts(v: any, max = 20): Opt[] {
  return (Array.isArray(v) ? v : [])
    .map((o: any) => ({ id: slug(o?.id) || rid().slice(0, 6), label: str(o?.label, 80) }))
    .filter((o: Opt) => o.label)
    .slice(0, max);
}

export function sanitizeSurvey(s: any, owner?: string): Survey | null {
  const title = str(s?.title, 80);
  if (!title) return null;
  const questions: Question[] = (Array.isArray(s?.questions) ? s.questions : []).slice(0, 30).map((q: any): Question => {
    const type = ['single', 'multi', 'scale', 'matrix'].includes(q?.type) ? q.type : 'single';
    const base: Question = { id: slug(q?.id) || rid().slice(0, 6), type, text: str(q?.text, 200), required: q?.required !== false };
    if (type === 'single' || type === 'multi') base.options = opts(q?.options);
    if (type === 'multi') base.maxSelect = Math.min(20, Math.max(0, parseInt(q?.maxSelect, 10) || 0)) || undefined;
    if (type === 'scale') {
      base.min = Math.min(10, Math.max(0, parseInt(q?.min, 10) || 1));
      base.max = Math.min(10, Math.max(base.min + 1, parseInt(q?.max, 10) || 5));
      base.minLabel = str(q?.minLabel, 20) || undefined;
      base.maxLabel = str(q?.maxLabel, 20) || undefined;
    }
    if (type === 'matrix') {
      base.rows = opts(q?.rows, 12);
      base.cols = opts(q?.cols, 7);
    }
    base.branches = (Array.isArray(q?.branches) ? q.branches : [])
      .map((b: any) => ({ when: str(b?.when, 20), goto: str(b?.goto, 40) }))
      .filter((b: Branch) => b.when && b.goto)
      .slice(0, 20);
    return base;
  }).filter((q: Question) => q.text);
  const inc = s?.incentive || {};
  const type = ['coupon', 'lottery'].includes(inc.type) ? inc.type : 'none';
  return {
    id: slug(s?.id) || rid(),
    title,
    active: !!s?.active,
    intro: str(s?.intro, 400),
    thanks: str(s?.thanks, 300) || 'ご回答ありがとうございました！',
    questions,
    incentive: {
      type,
      text: str(inc.text, 120) || undefined,
      code: str(inc.code, 40) || undefined,
      url: isHttps(str(inc.url, 500)) ? str(inc.url, 500) : undefined,
      winRate: type === 'lottery' ? Math.min(100, Math.max(0, Number(inc.winRate) || 0)) : undefined,
      maxWinners: type === 'lottery' ? Math.max(0, parseInt(inc.maxWinners, 10) || 0) || undefined : undefined,
      loseText: str(inc.loseText, 120) || undefined
    },
    owner: owner || (slug(s?.owner) || undefined),
    client: slug(s?.client) || undefined,
    startAt: /^\d{4}-\d{2}-\d{2}$/.test(s?.startAt) ? s.startAt : undefined,
    endAt: /^\d{4}-\d{2}-\d{2}$/.test(s?.endAt) ? s.endAt : undefined
  };
}

export function sanitizeLocalItems(v: any): LocalItem[] {
  return (Array.isArray(v) ? v : [])
    .map((x: any) => ({
      id: slug(x?.id) || rid().slice(0, 8),
      title: str(x?.title, 100),
      description: str(x?.description, 400),
      linkUrl: isHttps(str(x?.linkUrl, 500)) ? str(x?.linkUrl, 500) : undefined
    }))
    .filter((x: LocalItem) => x.title)
    .slice(0, 30);
}

export const listOfWords = (v: any, max = 20, len = 30) =>
  (Array.isArray(v) ? v : String(v || '').split(/[,、\n]/)).map((k: any) => str(k, len)).filter(Boolean).slice(0, max);
export const listOfFeeds = (v: any) => listOfWords(v, 10, 500).filter(isHttps);

// 端末（サイネージ）の追加項目
export function sanitizeDeviceExtras(d: any) {
  return {
    plan: ['lite', 'standard', 'internal'].includes(d?.plan) ? d.plan : 'internal',
    paidUntil: /^\d{4}-\d{2}-\d{2}$/.test(d?.paidUntil) ? d.paidUntil : undefined,
    stripeSub: str(d?.stripeSub, 100) || undefined,
    ownerKey: slug(d?.ownerKey, 64) || undefined,
    contact: str(d?.contact, 120) || undefined,
    touch: d?.touch !== false,
    mode: ['news', 'survey', 'quiz', 'mix'].includes(d?.mode) ? d.mode : 'news',
    surveyId: slug(d?.surveyId) || undefined,
    localItems: sanitizeLocalItems(d?.localItems),
    localKeywords: listOfWords(d?.localKeywords),
    localFeeds: listOfFeeds(d?.localFeeds)
  };
}

export function sanitizePlans(v: any): SignagePlan[] {
  const list = (Array.isArray(v) && v.length ? v : DEFAULT_PLANS)
    .map((p: any): SignagePlan => ({
      id: ['lite', 'standard'].includes(p?.id) ? p.id : 'lite',
      name: str(p?.name, 30) || 'プラン',
      price: Math.max(0, parseInt(p?.price, 10) || 0),
      interval: str(p?.interval, 10) || '月',
      features: (Array.isArray(p?.features) ? p.features : String(p?.features || '').split('\n')).map((f: any) => str(f, 80)).filter(Boolean).slice(0, 12),
      linkUrl: isHttps(str(p?.linkUrl, 500)) ? str(p?.linkUrl, 500) : undefined,
      recommended: !!p?.recommended
    }));
  return list.filter((p, i) => list.findIndex(x => x.id === p.id) === i);
}

export function sanitizeTopics(v: any): LocalTopic[] {
  return (Array.isArray(v) ? v : [])
    .map((t: any) => ({ id: slug(t?.id) || rid().slice(0, 8), region: str(t?.region, 40), keywords: listOfWords(t?.keywords), feeds: listOfFeeds(t?.feeds) }))
    .filter((t: LocalTopic) => t.region && t.keywords.length)
    .slice(0, 50);
}

export function liveSurvey(cfg: BizConfig, id?: string): Survey | undefined {
  if (!id) return undefined;
  const today = todayJst();
  return (cfg.surveys || []).find(s => s.id === id && s.active && (!s.startAt || s.startAt <= today) && (!s.endAt || today <= s.endAt));
}

// 回答者に見せてよい形（クーポンコード・当選確率は隠す）
export function publicSurvey(s: Survey) {
  const { incentive, owner, ...rest } = s;
  return { ...rest, incentive: { type: incentive.type, text: incentive.text } };
}

export function deviceActive(d: any): boolean {
  if (!d?.active) return false;
  if (!d.paidUntil) return d.plan === 'internal' || !d.plan; // 管理画面で作った無期限の端末
  return d.paidUntil >= todayJst();
}

// ====================== 回答の検証・保存・集計 ======================
function matchBranch(q: Question, value: any, when: string): boolean {
  if (q.type === 'single') return value === when;
  if (q.type === 'multi') return Array.isArray(value) && value.includes(when);
  if (q.type === 'scale') {
    const m = when.match(/^(>=|<=|=|>|<)?\s*(\d+)$/);
    if (!m || typeof value !== 'number') return false;
    const n = parseInt(m[2], 10);
    return m[1] === '>=' ? value >= n : m[1] === '<=' ? value <= n : m[1] === '>' ? value > n : m[1] === '<' ? value < n : value === n;
  }
  return false;
}

// 次に表示する設問（分岐を考慮）。フロントと同じロジック
export function nextQuestionId(s: Survey, current: Question, value: any): string | 'end' {
  for (const b of current.branches || []) if (matchBranch(current, value, b.when)) return b.goto;
  const i = s.questions.findIndex(q => q.id === current.id);
  return s.questions[i + 1]?.id || 'end';
}

// 分岐をたどって実際に通った設問だけの回答に整える（不正な値は捨てる）
export function validateAnswers(s: Survey, input: any): { answers: Record<string, any>; ok: boolean } {
  const out: Record<string, any> = {};
  let q = s.questions[0];
  let guard = 0;
  while (q && guard++ < 60) {
    const raw = input?.[q.id];
    let v: any = undefined;
    if (q.type === 'single' && q.options?.some(o => o.id === raw)) v = raw;
    if (q.type === 'multi' && Array.isArray(raw)) {
      const ids = [...new Set(raw.filter((x: any) => q.options?.some(o => o.id === x)))];
      if (ids.length && (!q.maxSelect || ids.length <= q.maxSelect)) v = ids;
    }
    if (q.type === 'scale' && typeof raw === 'number' && raw >= (q.min ?? 1) && raw <= (q.max ?? 5) && Number.isInteger(raw)) v = raw;
    if (q.type === 'matrix' && raw && typeof raw === 'object') {
      const m: Record<string, string> = {};
      for (const r of q.rows || []) if (q.cols?.some(c => c.id === raw[r.id])) m[r.id] = raw[r.id];
      if (Object.keys(m).length) v = m;
    }
    if (v === undefined && q.required) return { answers: out, ok: false };
    if (v !== undefined) out[q.id] = v;
    const next = nextQuestionId(s, q, v);
    if (next === 'end') break;
    q = s.questions.find(x => x.id === next) as Question;
  }
  return { answers: out, ok: Object.keys(out).length > 0 };
}

// days：日別の回答数（JST）、dev：設置場所（端末・QR・Web）別の回答数
type Agg = { total: number; q: Record<string, Record<string, any>>; days?: Record<string, number>; dev?: Record<string, number>; first?: string; updated?: string };

function addToAgg(agg: Agg, s: Survey, answers: Record<string, any>, device = '', created = new Date().toISOString()) {
  agg.total++;
  const day = new Date(Date.parse(created) + 9 * 3600_000).toISOString().slice(0, 10);
  (agg.days ||= {})[day] = (agg.days[day] || 0) + 1;
  if (device) (agg.dev ||= {})[device] = (agg.dev[device] || 0) + 1;
  if (!agg.first || created < agg.first) agg.first = created;
  for (const q of s.questions) {
    const v = answers[q.id];
    if (v === undefined) continue;
    const a = (agg.q[q.id] ||= {});
    if (q.type === 'single') a[v] = (a[v] || 0) + 1;
    if (q.type === 'multi') for (const id of v) a[id] = (a[id] || 0) + 1;
    if (q.type === 'scale') { a[String(v)] = (a[String(v)] || 0) + 1; a._sum = (a._sum || 0) + v; a._n = (a._n || 0) + 1; }
    if (q.type === 'matrix') for (const [r, c] of Object.entries(v)) { const row = (a[r] ||= {}); row[c as string] = (row[c as string] || 0) + 1; }
  }
  agg.updated = new Date().toISOString();
}

let respTable = false;
async function saveResponse(env: any, s: Survey, device: string, answers: Record<string, any>) {
  const created = new Date().toISOString();
  if (env.DB) {
    if (!respTable) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS responses (id INTEGER PRIMARY KEY AUTOINCREMENT, survey TEXT NOT NULL, device TEXT, answers TEXT NOT NULL, created TEXT NOT NULL)').run();
      respTable = true;
    }
    await env.DB.prepare('INSERT INTO responses (survey, device, answers, created) VALUES (?1, ?2, ?3, ?4)').bind(s.id, device, JSON.stringify(answers), created).run();
  } else {
    await env.NEWS_KV.put(`resp:${s.id}:${Date.now()}-${rid().slice(0, 4)}`, JSON.stringify({ device, answers, created }), { expirationTtl: 400 * 86400 });
  }
  const key = `agg:${s.id}`;
  const agg: Agg = (await env.NEWS_KV.get(key, 'json')) || { total: 0, q: {} };
  addToAgg(agg, s, answers, device, created);
  await env.NEWS_KV.put(key, JSON.stringify(agg));
}

// 保存済みの回答から集計を作り直す（日別・設置場所別の内訳がない古い集計の補完用）
async function rebuildAgg(env: any, s: Survey): Promise<Agg> {
  const rows = await exportResponses(env, s.id);
  const agg: Agg = { total: 0, q: {} };
  for (const r of [...rows].reverse()) addToAgg(agg, s, r.answers || {}, r.device || '', r.created);
  agg.updated = new Date().toISOString();
  await env.NEWS_KV.put(`agg:${s.id}`, JSON.stringify(agg));
  return agg;
}

// ---------- クライアント別レポート ----------
// レポートには回答の集計だけを載せる（クーポンコード・当選確率などの設定値は出さない）
async function buildReport(env: any, cfg: BizConfig, client: Client) {
  const mine = (cfg.surveys || []).filter(x => x.client === client.id);
  const devNames: Record<string, string> = { qr: 'QRコード（スマホ）', web: 'Web' };
  for (const dv of cfg.devices) devNames[dv.id] = dv.name;
  const surveys = await Promise.all(mine.map(async x => {
    const agg: Agg = (await env.NEWS_KV.get(`agg:${x.id}`, 'json')) || { total: 0, q: {} };
    const winners = x.incentive.type === 'lottery' ? parseInt((await env.NEWS_KV.get(`lotw:${x.id}`)) || '0', 10) : undefined;
    const { incentive, owner, ...rest } = x;
    return { survey: { ...rest, incentive: { type: incentive.type, text: incentive.text } }, agg, winners };
  }));
  return { client: { name: client.name }, generatedAt: new Date().toISOString(), devices: devNames, surveys };
}

async function exportResponses(env: any, surveyId: string) {
  if (env.DB) {
    if (!respTable) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS responses (id INTEGER PRIMARY KEY AUTOINCREMENT, survey TEXT NOT NULL, device TEXT, answers TEXT NOT NULL, created TEXT NOT NULL)').run();
      respTable = true;
    }
    const { results } = await env.DB.prepare('SELECT device, answers, created FROM responses WHERE survey = ?1 ORDER BY id DESC LIMIT 10000').bind(surveyId).all();
    return results.map((r: any) => ({ device: r.device, created: r.created, answers: JSON.parse(r.answers) }));
  }
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.NEWS_KV.list({ prefix: `resp:${surveyId}:`, cursor });
    for (const k of page.keys) { const v = await env.NEWS_KV.get(k.name, 'json'); if (v) rows.push(v); }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length < 5000);
  return rows;
}

// 抽選：当選したら引換コードを発行
async function drawIncentive(env: any, s: Survey) {
  const inc = s.incentive;
  if (inc.type === 'none') return { type: 'none' as const };
  if (inc.type === 'coupon') return { type: 'coupon' as const, won: true, text: inc.text, code: inc.code, url: inc.url };
  const wKey = `lotw:${s.id}`;
  const winners = parseInt((await env.NEWS_KV.get(wKey)) || '0', 10);
  const canWin = !inc.maxWinners || winners < inc.maxWinners;
  const won = canWin && Math.random() * 100 < (inc.winRate || 0);
  if (!won) return { type: 'lottery' as const, won: false, text: inc.loseText || '残念！またチャレンジしてね' };
  await env.NEWS_KV.put(wKey, String(winners + 1));
  const claim = rid().slice(0, 6).toUpperCase();
  await env.NEWS_KV.put(`claim:${claim}`, JSON.stringify({ survey: s.id, owner: s.owner || '', prize: inc.text || '', at: new Date().toISOString(), redeemed: false }), { expirationTtl: 120 * 86400 });
  return { type: 'lottery' as const, won: true, text: inc.text, code: inc.code, url: inc.url, claim };
}

// ====================== ローカルニュース（キーワード収集） ======================
type LocalNews = { title: string; url: string; summary?: string; source?: string; published?: string };

function topicsOf(cfg: BizConfig): LocalTopic[] {
  const topics = [...(cfg.settings.localTopics || [])];
  for (const d of cfg.devices) {
    if ((d as any).localKeywords?.length) topics.push({ id: `d-${d.id}`, region: d.region || d.name, keywords: (d as any).localKeywords, feeds: (d as any).localFeeds || [] });
  }
  return topics;
}

export async function crawlLocal(env: any, ctx: any, d: Deps, onlyTopic?: string) {
  const cfg = await loadConfig(env);
  const raw = await d.loadRaw(env, ctx);
  const pool: LocalNews[] = [];
  if (raw) for (const k of Object.keys(raw)) if (Array.isArray(raw[k])) pool.push(...raw[k]);
  for (const t of topicsOf(cfg)) {
    if (onlyTopic && t.id !== onlyTopic) continue;
    const candidates: LocalNews[] = [...pool];
    for (const f of t.feeds.slice(0, 5)) {
      try {
        if (!(await d.isAllowedByRobots(env, f))) continue;
        const feed = await d.fetchFeed(f);
        candidates.push(...feed.items.map(i => ({ ...i, source: i.source || feed.source })));
      } catch (e) {
        console.error('local feed failed', f, String(e));
      }
    }
    const kw = t.keywords.map(k => k.toLowerCase());
    const hits: LocalNews[] = [];
    for (const c of candidates) {
      const text = `${c.title} ${c.summary || ''}`.toLowerCase();
      const t0 = c.published ? Date.parse(c.published) : NaN;
      if (!isNaN(t0) && Date.now() - t0 > 14 * 86400_000) continue;
      if (kw.some(k => text.includes(k)) && !hits.some(h => h.url === c.url)) hits.push({ title: c.title, url: c.url, summary: c.summary, source: c.source, published: c.published });
      if (hits.length >= 15) break;
    }
    await env.NEWS_KV.put(`local:${t.id}`, JSON.stringify({ at: new Date().toISOString(), items: hits }), { expirationTtl: 3 * 86400 });
  }
}

async function localNewsFor(env: any, ctx: any, d: Deps, topicId: string) {
  const rec: any = await env.NEWS_KV.get(`local:${topicId}`, 'json');
  if (!rec || Date.now() - Date.parse(rec.at) > 6 * 3600_000) ctx?.waitUntil?.(crawlLocal(env, ctx, d, topicId));
  return (rec?.items || []) as LocalNews[];
}

// ====================== ニュースクイズ ======================
type Quiz = { q: string; choices: string[]; answer: number; explain?: string; source?: string; url?: string; kind: 'ai' | 'category' };
const CAT_LABELS: Record<string, string> = {
  it: 'IT', business: 'ビジネス', entertainment: 'エンタメ', funny: 'オモシロ', politics: '政治', society: '社会',
  world: '国際', sports: 'スポーツ', science: '科学', lifestyle: '暮らし'
};

const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function parseQuizJson(text: string): Omit<Quiz, 'kind'>[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : [])
      .map((x: any) => ({
        q: str(x?.q, 120),
        choices: (Array.isArray(x?.choices) ? x.choices : []).map((c: any) => str(String(c ?? ''), 40)).filter(Boolean),
        answer: parseInt(x?.answer, 10),
        explain: str(x?.explain, 160) || undefined,
        url: str(x?.url, 500) || undefined
      }))
      .filter((x: any) => x.q && x.choices.length === 4 && new Set(x.choices).size === 4 && x.answer >= 0 && x.answer < 4);
  } catch {
    return [];
  }
}

export async function generateQuizzes(env: any, ctx: any, d: Deps, batches = 2) {
  if (!env.AI) return;
  const raw = await d.loadRaw(env, ctx);
  if (!raw) return;
  const pool: Quiz[] = (await env.NEWS_KV.get('quiz:pool', 'json')) || [];
  const used = new Set(pool.map(p => p.url));
  const items: any[] = [];
  for (const k of Object.keys(raw)) if (Array.isArray(raw[k])) items.push(...raw[k].filter((i: any) => i.summary && !used.has(i.url)));
  shuffle(items);
  for (let b = 0; b < batches && items.length; b++) {
    const chunk = items.splice(0, 6);
    try {
      const res = await env.AI.run(d.model, {
        messages: [
          {
            role: 'system',
            content:
              'あなたはニュースクイズの出題者です。与えられたニュースそれぞれについて、中学生でも楽しめる4択クイズを1問ずつ作ってください。' +
              '答えは必ずニュース本文に書かれている事実にし、本文にないことは出題しないこと。誤答の選択肢はもっともらしく、でも明確に間違いにすること。' +
              '出力は JSON 配列だけ：[{"q":"問題文(60字以内)","choices":["A","B","C","D"],"answer":正解の番号0〜3,"explain":"解説(80字以内)","url":"ニュースのURL"}]'
          },
          { role: 'user', content: chunk.map(i => `URL: ${i.url}\nタイトル: ${i.title}\n本文: ${String(i.summary).slice(0, 400)}`).join('\n\n') }
        ],
        max_tokens: 1500,
        temperature: 0.4
      });
      const made = parseQuizJson(d.aiText(res));
      for (const m of made) {
        const src = chunk.find(i => i.url === m.url) || chunk.find(i => m.q && String(i.summary).includes(m.choices[m.answer]));
        if (!src) continue;
        // 選択肢の並びを入れ替えて正解の位置を偏らせない
        const correct = m.choices[m.answer];
        const choices = shuffle([...m.choices]);
        pool.unshift({ q: m.q, choices, answer: choices.indexOf(correct), explain: m.explain, source: src.source, url: src.url, kind: 'ai' });
      }
    } catch (e) {
      console.error('quiz generation failed', e);
    }
  }
  await env.NEWS_KV.put('quiz:pool', JSON.stringify(pool.slice(0, 300)));
}

function categoryQuizzes(raw: any, n: number): Quiz[] {
  const cats = Object.keys(raw || {}).filter(k => CAT_LABELS[k] && Array.isArray(raw[k]) && raw[k].length);
  if (cats.length < 4) return [];
  const out: Quiz[] = [];
  for (let i = 0; i < n; i++) {
    const cat = cats[Math.floor(Math.random() * cats.length)];
    const item = raw[cat][Math.floor(Math.random() * raw[cat].length)];
    const others = shuffle(cats.filter(c => c !== cat)).slice(0, 3);
    const choices = shuffle([cat, ...others]).map(c => CAT_LABELS[c]);
    out.push({ q: `このニュースはどのジャンル？「${item.title}」`, choices, answer: choices.indexOf(CAT_LABELS[cat]), source: item.source, url: item.url, kind: 'category' });
  }
  return out;
}

async function leaderboard(env: any, scope: string) {
  return ((await env.NEWS_KV.get(`lb:${scope}:${todayJst()}`, 'json')) || []) as { name: string; score: number; at: string }[];
}

// ====================== 申し込み（振込・手動で有効化） ======================
export type Application = {
  id: string;
  createdAt: string;
  status: 'new' | 'invoiced' | 'active' | 'cancelled';
  plan: string;
  screens: number;
  company: string;
  name: string;
  email: string;
  phone?: string;
  place?: string;
  touch?: boolean;
  note?: string;
  memo?: string; // 管理者メモ（請求書番号・入金日など）
  deviceIds?: string[];
};

const APP_KEY = (id: string) => `app:${id}`;
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

async function listApplications(env: any): Promise<Application[]> {
  const out: Application[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.NEWS_KV.list({ prefix: 'app:', cursor });
    for (const k of page.keys) { const v = await env.NEWS_KV.get(k.name, 'json'); if (v) out.push(v); }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && out.length < 1000);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function notifyApplication(url: string | undefined, a: Application, planName: string) {
  if (!url) return;
  const text = `📥 サイネージの申し込みがありました\n${a.company} / ${a.name} 様（${a.email}${a.phone ? ' / ' + a.phone : ''}）\nプラン：${planName} × ${a.screens}画面${a.place ? `\n設置場所：${a.place}` : ''}${a.note ? `\n備考：${a.note}` : ''}`;
  try {
    // Slack は text、Discord は content を読む
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  } catch (e) {
    console.error('notify failed', e);
  }
}

// 入金確認後：申し込み内容から端末（サイネージ）を発行する
function devicesFromApplication(a: Application, months: number) {
  const paidUntil = addMonths(todayJst(), months);
  const ownerKey = rid() + rid() + rid();
  return Array.from({ length: Math.max(1, Math.min(50, a.screens)) }, (_, i) => ({
    id: rid().slice(0, 8),
    name: `${a.company}${a.screens > 1 ? ` ${i + 1}` : ''}`.slice(0, 80),
    key: rid() + rid(),
    active: true,
    ...sanitizeDeviceExtras({ plan: a.plan, paidUntil, ownerKey: a.screens > 1 ? rid() + rid() + rid() : ownerKey, contact: `${a.name} <${a.email}>`, touch: a.touch !== false, mode: 'news' })
  }));
}

export const addMonths = (d: string, n: number) => {
  const t = new Date(Date.parse(d + 'T00:00:00Z'));
  const day = t.getUTCDate();
  t.setUTCMonth(t.getUTCMonth() + n);
  if (t.getUTCDate() !== day) t.setUTCDate(0); // 1/31 + 1ヶ月 → 2/28
  return t.toISOString().slice(0, 10);
};

// ====================== Stripe ======================
async function stripeGet(env: any, path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  if (!res.ok) throw new Error(`stripe ${res.status}`);
  return res.json() as Promise<any>;
}
const periodEnd = (sub: any) => sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;

// 期限が近い月額契約は Stripe で継続を確認して延長（1日1回まで）
async function renewIfNeeded(env: any, cfg: BizConfig, dev: any) {
  if (!dev.stripeSub || !env.STRIPE_SECRET_KEY || !dev.paidUntil) return;
  if (dev.paidUntil > addDays(todayJst(), 3)) return;
  const flag = `subchk:${dev.id}:${todayJst()}`;
  if (await env.NEWS_KV.get(flag)) return;
  await env.NEWS_KV.put(flag, '1', { expirationTtl: 2 * 86400 });
  try {
    const sub = await stripeGet(env, `subscriptions/${encodeURIComponent(dev.stripeSub)}`);
    if ((sub.status === 'active' || sub.status === 'trialing') && periodEnd(sub)) {
      const until = new Date(periodEnd(sub) * 1000 + 9 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
      const fresh = await loadConfig(env, true);
      const target: any = fresh.devices.find(x => x.id === dev.id);
      if (target) { target.paidUntil = until; await saveConfig(env, fresh); }
    }
  } catch (e) {
    console.error('renew check failed', e);
  }
}

// ====================== ルーティング ======================
export async function handleEngage(request: Request, env: any, ctx: any, url: URL, d: Deps): Promise<Response | null> {
  const { json } = d;
  const path = url.pathname;
  const body = async () => (request.method === 'POST' || request.method === 'PUT' ? await request.json().catch(() => null) : null);

  // ---------- サーベイ（回答者向け） ----------
  if (path === '/api/survey' && request.method === 'GET') {
    const cfg = await loadConfig(env);
    const s = liveSurvey(cfg, url.searchParams.get('id') || '');
    if (!s) return json({ error: 'このアンケートは終了しました' }, 404);
    return json(publicSurvey(s));
  }

  if (path === '/api/survey/submit' && request.method === 'POST') {
    const b: any = await body();
    const cfg = await loadConfig(env);
    const s = liveSurvey(cfg, str(b?.id, 40));
    if (!s) return json({ error: 'このアンケートは終了しました' }, 404);
    const { answers, ok } = validateAnswers(s, b?.answers);
    if (!ok) return json({ error: '未回答の設問があります' }, 400);
    const ip = request.headers.get('CF-Connecting-IP') || 'x';
    const rl = `srl:${s.id}:${ip}:${Math.floor(Date.now() / 600_000)}`;
    const n = parseInt((await env.NEWS_KV.get(rl)) || '0', 10);
    const device = cfg.devices.find(x => x.key === str(b?.device, 64));
    // サイネージ端末以外（スマホ）は同じ回線から10分に5回まで
    if (!device && n >= 5) return json({ error: '短時間に送信が続いています。少し時間をおいてください' }, 429);
    await env.NEWS_KV.put(rl, String(n + 1), { expirationTtl: 900 });
    await saveResponse(env, s, device?.id || (b?.via === 'qr' ? 'qr' : 'web'), answers);
    ctx?.waitUntil?.(track(env, 'survey_complete', s.id));
    return json({ ok: true, thanks: s.thanks, incentive: await drawIncentive(env, s) });
  }

  if (path === '/api/survey/live') {
    // サイネージに出す「みんなの回答」（集計のみ）
    const cfg = await loadConfig(env);
    const s = liveSurvey(cfg, url.searchParams.get('id') || '');
    if (!s) return json({ total: 0, q: {} });
    return json((await env.NEWS_KV.get(`agg:${s.id}`, 'json')) || { total: 0, q: {} }, 200, { 'Cache-Control': 'public, max-age=15' });
  }

  // ---------- 管理者のサイネージプレビュー（契約・端末なしで全モードを確認） ----------
  if (path === '/api/signage/preview') {
    if (!(await adminFrom(request, env))) return json({ active: false, reason: 'admin' }, 401);
    const cfg = await loadConfig(env, true);
    const q = url.searchParams;
    const mode = ['news', 'survey', 'quiz', 'mix'].includes(q.get('mode') || '') ? q.get('mode') : 'mix';
    const region = str(q.get('region'), 40) || undefined;
    const surveyId = str(q.get('survey'), 40);
    const survey = (cfg.surveys || []).find(s => s.id === surveyId) || (cfg.surveys || []).find(s => s.active) || null;
    const topicIds = (cfg.settings.localTopics || []).filter(t => !region || t.region === region).map(t => t.id);
    const crawled: LocalNews[] = [];
    for (const t of topicIds) for (const it of await localNewsFor(env, ctx, d, t)) if (!crawled.some(c => c.url === it.url)) crawled.push(it);
    return json({
      active: true,
      preview: true,
      rev: `${cfg.rev || ''}|${mode}|${q.get('touch')}|${survey?.id || ''}|${region || ''}`,
      device: { id: 'preview', name: '管理者プレビュー', region, touch: q.get('touch') !== '0', mode, plan: 'internal' },
      features: PLAN_FEATURES.internal,
      survey: survey ? publicSurvey(survey) : null,
      surveys: (cfg.surveys || []).map(s => ({ id: s.id, title: s.title, active: s.active })),
      regions: [...new Set([...(cfg.settings.localTopics || []).map(t => t.region), ...cfg.devices.map(x => x.region).filter(Boolean)])],
      localItems: [],
      localNews: crawled.slice(0, 15)
    });
  }

  // ---------- サイネージの状態（端末が20秒ごとに取得） ----------
  if (path === '/api/signage/state') {
    const cfg = await loadConfig(env, true);
    const dev: any = cfg.devices.find(x => x.key === url.searchParams.get('device'));
    if (!dev) return json({ active: false, reason: 'unknown', rev: cfg.rev || '' });
    ctx?.waitUntil?.(renewIfNeeded(env, cfg, dev));
    if (!deviceActive(dev)) return json({ active: false, reason: 'expired', name: dev.name, rev: cfg.rev || '' });
    const features = PLAN_FEATURES[dev.plan || 'internal'] || PLAN_FEATURES.internal;
    const survey = features.survey && (dev.mode === 'survey' || dev.mode === 'mix') ? liveSurvey(cfg, dev.surveyId) : undefined;
    const topicIds = [`d-${dev.id}`, ...(cfg.settings.localTopics || []).filter(t => dev.region && t.region === dev.region).map(t => t.id)];
    const crawled: LocalNews[] = [];
    for (const t of topicIds) for (const it of await localNewsFor(env, ctx, d, t)) if (!crawled.some(c => c.url === it.url)) crawled.push(it);
    return json({
      active: true,
      rev: cfg.rev || '',
      device: { id: dev.id, name: dev.name, region: dev.region, touch: dev.touch !== false, mode: dev.mode || 'news', plan: dev.plan || 'internal' },
      features,
      survey: survey ? publicSurvey(survey) : null,
      localItems: dev.localItems || [],
      localNews: crawled.slice(0, 15)
    });
  }

  // サイネージの申し込み（振込）：内容を保存して管理者に通知し、振込先を返す
  if (path === '/api/signage/apply' && request.method === 'POST') {
    const b: any = await body();
    const cfg = await loadConfig(env);
    const plans = cfg.settings.signagePlans || DEFAULT_PLANS;
    const plan = plans.find(p => p.id === b?.plan) || plans[0];
    const a: Application = {
      id: `${Date.now().toString(36)}-${rid().slice(0, 4)}`,
      createdAt: new Date().toISOString(),
      status: 'new',
      plan: plan.id,
      screens: Math.min(100, Math.max(1, parseInt(b?.screens, 10) || 1)),
      company: str(b?.company, 80),
      name: str(b?.name, 40),
      email: str(b?.email, 120),
      phone: str(b?.phone, 30) || undefined,
      place: str(b?.place, 120) || undefined,
      touch: b?.touch !== false,
      note: str(b?.note, 600) || undefined
    };
    if (!a.company || !a.name || !emailOk(a.email)) return json({ error: '会社名・お名前・メールアドレスを正しく入力してください' }, 400);
    if (str(b?.website, 100)) return json({ ok: true }); // ボット対策（見えない入力欄に値があれば保存しない）
    const ip = request.headers.get('CF-Connecting-IP') || 'x';
    const rl = `aprl:${ip}:${todayJst()}`;
    const n = parseInt((await env.NEWS_KV.get(rl)) || '0', 10);
    if (n >= 5) return json({ error: '本日の申し込み回数の上限に達しました。お問い合わせからご連絡ください' }, 429);
    await env.NEWS_KV.put(rl, String(n + 1), { expirationTtl: 2 * 86400 });
    await env.NEWS_KV.put(APP_KEY(a.id), JSON.stringify(a), { expirationTtl: 3 * 365 * 86400 });
    ctx?.waitUntil?.(notifyApplication(cfg.settings.applyNotifyUrl, a, plan.name));
    ctx?.waitUntil?.(track(env, 'signage_contract', `apply-${plan.id}`));
    return json({
      ok: true,
      id: a.id,
      plan: { id: plan.id, name: plan.name, price: plan.price, interval: plan.interval },
      total: plan.price * a.screens,
      bankInfo: cfg.settings.bankInfo || null,
      invoiceNote: cfg.settings.invoiceNote || null
    });
  }

  // 有料サイネージ：Stripe の支払い後に戻ってきたときの確認 → 端末を発行
  if (path === '/api/signage/claim') {
    const sessionId = str(url.searchParams.get('session_id'), 200);
    if (!env.STRIPE_SECRET_KEY || !/^cs_/.test(sessionId)) return json({ error: '支払い情報を確認できません' }, 400);
    const done: any = await env.NEWS_KV.get(`sess:${sessionId}`, 'json');
    if (done) return json(done); // 再読み込みしても同じURLを返す
    try {
      const s = await stripeGet(env, `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`);
      if (s.status !== 'complete') return json({ error: '支払いが完了していません' }, 402);
      const plan = ['lite', 'standard'].includes(s.client_reference_id) ? s.client_reference_id : 'lite';
      const sub = typeof s.subscription === 'object' ? s.subscription : null;
      const end = periodEnd(sub);
      const paidUntil = end ? new Date(end * 1000 + 9 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10) : addDays(todayJst(), 34);
      const cfg = await loadConfig(env, true);
      const dev: any = {
        id: rid().slice(0, 8),
        name: str(s.customer_details?.name, 60) || str(s.customer_details?.email, 60) || 'サイネージ',
        key: rid() + rid(),
        active: true,
        ...sanitizeDeviceExtras({ plan, paidUntil, stripeSub: sub?.id || (typeof s.subscription === 'string' ? s.subscription : undefined), ownerKey: rid() + rid() + rid(), contact: s.customer_details?.email, touch: true, mode: 'news' })
      };
      cfg.devices.unshift(dev);
      await saveConfig(env, cfg);
      const out = { deviceKey: dev.key, ownerKey: dev.ownerKey, plan, paidUntil };
      await env.NEWS_KV.put(`sess:${sessionId}`, JSON.stringify(out), { expirationTtl: 400 * 86400 });
      ctx?.waitUntil?.(track(env, 'signage_contract', plan));
      return json(out);
    } catch (e) {
      console.error('signage claim failed', e);
      return json({ error: '確認できませんでした。時間をおいて再読み込みしてください' }, 502);
    }
  }

  // ---------- ニュースクイズ ----------
  if (path === '/api/quiz') {
    const n = Math.min(30, Math.max(1, parseInt(url.searchParams.get('n') || '15', 10)));
    const pool: Quiz[] = (await env.NEWS_KV.get('quiz:pool', 'json')) || [];
    if (pool.length < 40) {
      const flag = 'quiz:gen-lock';
      if (!(await env.NEWS_KV.get(flag))) {
        await env.NEWS_KV.put(flag, '1', { expirationTtl: 600 });
        ctx?.waitUntil?.(generateQuizzes(env, ctx, d, 1));
      }
    }
    const raw = await d.loadRaw(env, ctx);
    const ai = shuffle([...pool]).slice(0, Math.ceil(n * 0.7));
    const list = shuffle([...ai, ...categoryQuizzes(raw, n - ai.length)]);
    return json({ quizzes: list, pool: pool.length });
  }

  if (path === '/api/quiz/leaderboard') {
    return json({ day: todayJst(), top: await leaderboard(env, slug(url.searchParams.get('scope') || 'web') || 'web') }, 200, { 'Cache-Control': 'public, max-age=20' });
  }

  if (path === '/api/quiz/score' && request.method === 'POST') {
    const b: any = await body();
    const name = str(b?.name, 12).replace(/https?:\/\/\S+|[<>]/g, '') || 'ななしさん';
    const score = Math.max(0, Math.min(100000, parseInt(b?.score, 10) || 0));
    const scope = slug(b?.scope || 'web') || 'web';
    const ip = request.headers.get('CF-Connecting-IP') || 'x';
    const rl = `qrl:${ip}:${Math.floor(Date.now() / 3600_000)}`;
    const cnt = parseInt((await env.NEWS_KV.get(rl)) || '0', 10);
    if (cnt >= 30) return json({ error: 'rate limited' }, 429);
    await env.NEWS_KV.put(rl, String(cnt + 1), { expirationTtl: 3700 });
    ctx?.waitUntil?.(track(env, 'quiz_play', scope));
    const top = await leaderboard(env, scope);
    if (score > 0 && (top.length < 20 || score > top[top.length - 1].score)) {
      top.push({ name, score, at: new Date().toISOString() });
      top.sort((a, b2) => b2.score - a.score);
      await env.NEWS_KV.put(`lb:${scope}:${todayJst()}`, JSON.stringify(top.slice(0, 20)), { expirationTtl: 8 * 86400 });
    }
    const rank = top.findIndex(t => t.name === name && t.score === score) + 1;
    return json({ rank: rank || null, top: top.slice(0, 20) });
  }

  // ---------- ローカルニュース（メイン画面の ?local=地域名） ----------
  if (path === '/api/local') {
    const cfg = await loadConfig(env);
    const region = str(url.searchParams.get('region'), 40);
    const items: LocalNews[] = [];
    for (const t of (cfg.settings.localTopics || []).filter(t => !region || t.region === region)) {
      for (const it of await localNewsFor(env, ctx, d, t.id)) if (!items.some(x => x.url === it.url)) items.push({ ...it, source: it.source });
    }
    return json({ region, items: items.slice(0, 20) }, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  // ---------- 契約者（サイネージのオーナー）向け ----------
  if (path.startsWith('/api/owner/')) {
    const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
    const cfg = await loadConfig(env, true);
    const dev: any = auth ? cfg.devices.find((x: any) => x.ownerKey && x.ownerKey === auth) : undefined;
    if (!dev) return json({ error: 'URLが正しくないか、契約が見つかりません' }, 401);
    const features = PLAN_FEATURES[dev.plan || 'internal'] || PLAN_FEATURES.internal;
    const mine = (cfg.surveys || []).filter(s => s.owner === dev.id);

    if (path === '/api/owner/device' && request.method === 'GET') {
      const aggs: Record<string, any> = {};
      for (const s of mine) aggs[s.id] = (await env.NEWS_KV.get(`agg:${s.id}`, 'json')) || { total: 0, q: {} };
      return json({
        device: dev, active: deviceActive(dev), features, surveys: mine, aggs, plans: cfg.settings.signagePlans || DEFAULT_PLANS,
        payment: { mode: cfg.settings.paymentMode || 'bank', bankInfo: dev.stripeSub ? null : cfg.settings.bankInfo || null }
      });
    }
    if (path === '/api/owner/device' && request.method === 'PUT') {
      const b: any = await body();
      const ex = sanitizeDeviceExtras({ ...dev, ...b, plan: dev.plan, paidUntil: dev.paidUntil, stripeSub: dev.stripeSub, ownerKey: dev.ownerKey });
      Object.assign(dev, ex, {
        name: str(b?.name, 80) || dev.name,
        region: str(b?.region, 40) || undefined,
        mode: features.survey || ex.mode !== 'survey' ? ex.mode : 'news',
        surveyId: mine.some(s => s.id === ex.surveyId) ? ex.surveyId : undefined
      });
      await saveConfig(env, cfg);
      ctx?.waitUntil?.(crawlLocal(env, ctx, d, `d-${dev.id}`));
      return json({ device: dev });
    }
    if (path === '/api/owner/surveys' && request.method === 'PUT') {
      if (!features.survey) return json({ error: 'アンケートはスタンダードプランでご利用いただけます' }, 403);
      const b: any = await body();
      const before = new Map((cfg.surveys || []).filter(s => s.owner === dev.id).map(s => [s.id, s.client]));
      // クライアントの割り当ては管理者だけが変えられる
      const list = ((Array.isArray(b?.surveys) ? b.surveys : []).slice(0, 20).map((s: any) => sanitizeSurvey(s, dev.id)).filter(Boolean) as Survey[])
        .map(s => ({ ...s, client: before.get(s.id) }));
      cfg.surveys = [...(cfg.surveys || []).filter(s => s.owner !== dev.id), ...list];
      if (dev.surveyId && !list.some(s => s.id === dev.surveyId)) dev.surveyId = undefined;
      await saveConfig(env, cfg);
      return json({ surveys: list });
    }
    if (path === '/api/owner/export') {
      const id = str(url.searchParams.get('id'), 40);
      if (!mine.some(s => s.id === id)) return json({ error: 'not found' }, 404);
      return json({ rows: await exportResponses(env, id) });
    }
    if (path === '/api/owner/claim') {
      return claimCheck(env, json, str(url.searchParams.get('code'), 10).toUpperCase(), request.method === 'POST', dev.id);
    }
    return json({ error: 'Not Found' }, 404);
  }

  // ---------- 管理API（biz.ts と同じ管理者認証） ----------
  // ---------- クライアント別レポート（レポートURLのキーで閲覧） ----------
  if (path === '/api/report' || path === '/api/report/export') {
    const key = str(url.searchParams.get('key'), 80);
    const cfg = await loadConfig(env);
    const client = key.length >= 16 ? (cfg.clients || []).find(c => c.reportKey === key) : undefined;
    if (!client) return json({ error: 'このレポートURLは無効です。発行元にお問い合わせください' }, 404);
    const nocache = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };
    if (path === '/api/report') return json(await buildReport(env, cfg, client), 200, nocache);
    const s = (cfg.surveys || []).find(x => x.id === str(url.searchParams.get('id'), 40) && x.client === client.id);
    if (!s) return json({ error: 'not found' }, 404);
    return json({ rows: await exportResponses(env, s.id) }, 200, nocache);
  }

  if (path.startsWith('/api/admin/') && ['/api/admin/survey/reagg', '/api/admin/survey/export', '/api/admin/survey/agg', '/api/admin/claim', '/api/admin/local/crawl', '/api/admin/quiz/generate', '/api/admin/applications', '/api/admin/applications/update', '/api/admin/applications/activate'].includes(path)) {
    if (!(await adminFrom(request, env))) return json({ error: 'unauthorized' }, 401);
    if (path === '/api/admin/applications') return json({ applications: await listApplications(env) });
    if (path === '/api/admin/applications/update' && request.method === 'POST') {
      const b: any = await body();
      const a: Application | null = await env.NEWS_KV.get(APP_KEY(str(b?.id, 40)), 'json');
      if (!a) return json({ error: 'not found' }, 404);
      if (['new', 'invoiced', 'cancelled'].includes(b?.status)) a.status = b.status;
      if (typeof b?.memo === 'string') a.memo = str(b.memo, 300);
      await env.NEWS_KV.put(APP_KEY(a.id), JSON.stringify(a), { expirationTtl: 3 * 365 * 86400 });
      return json({ application: a });
    }
    if (path === '/api/admin/applications/activate' && request.method === 'POST') {
      // 入金を確認したら押す：端末を発行して申し込みを「有効」にする
      const b: any = await body();
      const a: Application | null = await env.NEWS_KV.get(APP_KEY(str(b?.id, 40)), 'json');
      if (!a) return json({ error: 'not found' }, 404);
      if (a.status === 'active') return json({ error: 'この申し込みはすでに有効化されています' }, 409);
      const months = Math.min(24, Math.max(1, parseInt(b?.months, 10) || 1));
      const cfg = await loadConfig(env, true);
      const devs = devicesFromApplication(a, months);
      cfg.devices.unshift(...(devs as any[]));
      await saveConfig(env, cfg);
      a.status = 'active';
      a.deviceIds = devs.map(d => d.id);
      a.memo = [a.memo, `${todayJst()} 入金確認・${months}ヶ月分で有効化`].filter(Boolean).join(' / ').slice(0, 300);
      await env.NEWS_KV.put(APP_KEY(a.id), JSON.stringify(a), { expirationTtl: 3 * 365 * 86400 });
      ctx?.waitUntil?.(track(env, 'signage_contract', a.plan));
      return json({ application: a, devices: devs.map(d => ({ id: d.id, name: d.name, key: d.key, ownerKey: d.ownerKey, paidUntil: d.paidUntil })), rev: cfg.rev });
    }
    if (path === '/api/admin/survey/reagg' && request.method === 'POST') {
      const s = (await loadConfig(env, true)).surveys.find(x => x.id === str(url.searchParams.get('id'), 40));
      if (!s) return json({ error: 'not found' }, 404);
      return json(await rebuildAgg(env, s));
    }
    if (path === '/api/admin/survey/export') return json({ rows: await exportResponses(env, str(url.searchParams.get('id'), 40)) });
    if (path === '/api/admin/survey/agg') return json((await env.NEWS_KV.get(`agg:${str(url.searchParams.get('id'), 40)}`, 'json')) || { total: 0, q: {} });
    if (path === '/api/admin/claim') return claimCheck(env, json, str(url.searchParams.get('code'), 10).toUpperCase(), request.method === 'POST');
    if (path === '/api/admin/local/crawl') { await crawlLocal(env, ctx, d); return json({ ok: true }); }
    if (path === '/api/admin/quiz/generate') { await generateQuizzes(env, ctx, d, 2); return json({ pool: ((await env.NEWS_KV.get('quiz:pool', 'json')) || []).length }); }
  }

  return null;
}

// 抽選の引換コードの確認・使用済みにする（店頭スタッフ用）
async function claimCheck(env: any, json: Deps['json'], code: string, redeem: boolean, owner?: string) {
  const rec: any = code ? await env.NEWS_KV.get(`claim:${code}`, 'json') : null;
  if (!rec || (owner && rec.owner !== owner)) return json({ valid: false, message: 'このコードは見つかりません' });
  if (redeem && !rec.redeemed) {
    rec.redeemed = true;
    rec.redeemedAt = new Date().toISOString();
    await env.NEWS_KV.put(`claim:${code}`, JSON.stringify(rec), { expirationTtl: 120 * 86400 });
  }
  return json({ valid: true, ...rec });
}
