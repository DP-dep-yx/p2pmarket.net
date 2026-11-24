/**
 * P2PMarket Indexer — Trust Net v17.1
 *
 * Реальность, а не пересказ:
 *  - читает события ProfileUpdated / ProfileDeactivated прямо из P2PMarketRegistry (viem getLogs, поллинг HTTP RPC);
 *  - мультидоменная схема: ключ (wallet, domain) — один кошелёк владеет N доменами;
 *  - после ProfileUpdated вызывает getProfile(domain), скачивает карточку по aiPromptUri
 *    (https://… или ipfs://… через шлюз), парсит и кладёт в SQLite;
 *  - Trust Score: базовый 10.0, а при заданном TRADE_ADDRESS — из реальных
 *    completedDealsCount + onTimeInvoiceSettlements контракта P2PMarketTrade;
 *  - поиск: векторный (косинус), если настроен любой OpenAI-совместимый embeddings-эндпоинт,
 *    иначе — лексический, и ответ честно помечен mode:"lexical".
 *
 * Env:
 *  BASE_RPC_URL        (default https://mainnet.base.org)
 *  REGISTRY_ADDRESS    адрес P2PMarketRegistry (без него индексатор работает только с локальной БД)
 *  TRADE_ADDRESS       адрес P2PMarketTrade (включает ончейн Trust Score)
 *  START_BLOCK         стартовый блок синка (default: текущий высотный на запуске)
 *  POLL_INTERVAL_MS    интервал опроса логов (default 12000)
 *  IPFS_GATEWAY        (default https://ipfs.io/ipfs/)
 *  EMBEDDING_API_BASE / EMBEDDING_API_KEY / EMBEDDING_MODEL
 *  DB_PATH             (default ./trust_index.db)
 *  PORT                (default 8096)
 */

const express = require('express');
const Database = require('better-sqlite3');
const { createPublicClient, http, formatUnits } = require('viem');
const { base } = require('viem/chains');
const path = require('path');
const fs = require('fs');

const ABI = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', 'P2PMarketRegistry.json'), 'utf8'));
const EV = Object.fromEntries(ABI.filter(a => a.type === 'event').map(e => [e.name, e]));
const FN = Object.fromEntries(ABI.filter(a => a.type === 'function').map(f => [f.name, f]));

const CFG = {
  rpc: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  registry: process.env.REGISTRY_ADDRESS || null,
  trade: process.env.TRADE_ADDRESS || null,
  startBlock: process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : null,
  pollMs: parseInt(process.env.POLL_INTERVAL_MS || '12000', 10),
  ipfsGateway: process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/',
  embed: process.env.EMBEDDING_API_BASE
    ? {
        base: process.env.EMBEDDING_API_BASE.replace(/\/$/, ''),
        key: process.env.EMBEDDING_API_KEY || '',
        model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      }
    : null,
  dbPath: process.env.DB_PATH || path.join(__dirname, 'trust_index.db'),
  port: parseInt(process.env.PORT || '8096', 10),
};

// ---------------------------------------------------------------- SQLite v17.1

const db = new Database(CFG.dbPath);

function migrate() {
  const cols = db.prepare('PRAGMA table_info(profiles)').all().map(c => c.name);
  if (cols.length && !cols.includes('is_active')) {
    // старая v10-схема (wallet PK) — бэкапим и создаём мультидоменную
    db.exec('ALTER TABLE profiles RENAME TO profiles_v10_backup');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      wallet          TEXT NOT NULL,
      domain          TEXT NOT NULL,
      business_info   TEXT,
      ai_prompt_uri   TEXT,
      prompt_json     TEXT,
      card_text       TEXT,
      embedding_json  TEXT,
      is_active       INTEGER NOT NULL DEFAULT 1,
      trust_score     REAL NOT NULL DEFAULT 10.0,
      updated_at      INTEGER,
      synced_at       INTEGER,
      PRIMARY KEY (wallet, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_domain ON profiles(domain);
    CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(is_active);
    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
migrate();

const upsertStmt = db.prepare(`
  INSERT INTO profiles (wallet, domain, business_info, ai_prompt_uri, is_active, updated_at, synced_at)
  VALUES (@wallet, @domain, @businessInfo, @aiPromptUri, 1, @updatedAt, @syncedAt)
  ON CONFLICT (wallet, domain) DO UPDATE SET
    business_info = excluded.business_info,
    ai_prompt_uri = excluded.ai_prompt_uri,
    is_active = 1,
    updated_at = excluded.updated_at,
    synced_at = excluded.synced_at
`);

// ---------------------------------------------------------------- Base client

const baseClient = createPublicClient({
  chain: base,
  transport: http(CFG.rpc),
});

// ---------------------------------------------------------------- helpers

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Trust Net ranking: Cosine * (1 + alpha * log(1 + Trust_Score)) */
function computeFinalRankScore(sim, trustScore, alpha = 0.35) {
  return sim * (1 + alpha * Math.log(1 + Math.max(0, trustScore)));
}

const STOP = new Set('and the for with from that this are was were you your our their they it its а и в на с от что для'.split(' '));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9+]+/i)
    .filter(t => t.length > 1 && !STOP.has(t));
}

function lexicalSim(queryTerms, text) {
  if (!queryTerms.length) return 0.5;
  const hay = new Set(tokenize(text));
  const matched = queryTerms.filter(t => hay.has(t)).length;
  return Math.min(0.99, 0.15 + (matched / queryTerms.length) * 0.84);
}

async function embedText(text) {
  if (!CFG.embed) return null;
  try {
    const res = await fetch(CFG.embed.base + '/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.embed.key}` },
      body: JSON.stringify({ model: CFG.embed.model, input: String(text).slice(0, 24000) }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const vec = j.data && j.data[0] && j.data[0].embedding;
    return Array.isArray(vec) ? vec : null;
  } catch {
    return null;
  }
}

/** https://site/… или ipfs://… → https-адрес, который можно скачать */
function resolveUri(uri) {
  const u = String(uri || '').trim();
  if (/^ipfs:\/\//i.test(u)) return CFG.ipfsGateway + u.replace(/^ipfs:\/\//i, '');
  if (/^https:\/\//i.test(u)) return u;
  return null;
}

/** Скачиваем карточку продавца (best-effort: недоступность сайта не ломает индексацию профиля) */
async function fetchPromptCard(uri) {
  const url = resolveUri(uri);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.text()).slice(0, 512 * 1024);
    const card = JSON.parse(raw);
    const offers = Array.isArray(card.makesOffer) ? card.makesOffer : [];
    const cardText = [
      card.name,
      card.description,
      ...offers.map(o => [o.name, o.description, o.category].filter(Boolean).join(' ')),
    ].filter(Boolean).join(' ');
    return { raw, cardText: cardText.slice(0, 24000) };
  } catch {
    return null;
  }
}

/** Ончейн Trust Score: база 10 + реальные сделки из P2PMarketTrade (если задан TRADE_ADDRESS) */
async function computeTrustScore(wallet) {
  if (!CFG.trade) return 10.0;
  try {
    const [completed, onTime] = await Promise.all([
      baseClient.readContract({
        address: CFG.trade,
        abi: TRADE_MIN_ABI,
        functionName: 'completedDealsCount',
        args: [wallet],
      }),
      baseClient.readContract({
        address: CFG.trade,
        abi: TRADE_MIN_ABI,
        functionName: 'onTimeInvoiceSettlements',
        args: [wallet],
      }),
    ]);
    return Math.min(100, 10 + Number(completed) + 0.5 * Number(onTime));
  } catch {
    return 10.0;
  }
}

const TRADE_MIN_ABI = [
  { type: 'function', name: 'completedDealsCount', stateMutability: 'view', inputs: [{ name: 'wallet', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'onTimeInvoiceSettlements', stateMutability: 'view', inputs: [{ name: 'wallet', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

// ---------------------------------------------------------------- синхронизация

function getState(key) {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return r ? BigInt(r.value) : null;
}
function setState(key, value) {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

async function syncProfile(wallet, domain) {
  const profile = await baseClient.readContract({
    address: CFG.registry,
    abi: ABI,
    functionName: 'getProfile',
    args: [domain],
  });
  if (!profile || !profile.isActive) return;
  upsertStmt.run({
    wallet: String(wallet).toLowerCase(),
    domain: String(profile.domain || domain).toLowerCase(),
    businessInfo: profile.businessInfo || '',
    aiPromptUri: profile.aiPromptUri || '',
    updatedAt: Math.floor(Date.now() / 1000),
    syncedAt: Math.floor(Date.now() / 1000),
  });
}

async function indexUpdatedCard(wallet, domain) {
  const key = [String(wallet).toLowerCase(), String(domain).toLowerCase()];
  await syncProfile(wallet, domain);
  const row = db.prepare('SELECT * FROM profiles WHERE wallet = ? AND domain = ?').get(...key);
  if (!row) return;

  const card = await fetchPromptCard(row.ai_prompt_uri);
  const trustScore = await computeTrustScore(row.wallet);

  let embedding = null;
  if (CFG.embed) {
    embedding = await embedText(`${row.domain} ${row.business_info} ${card ? card.cardText : ''}`);
  }

  db.prepare(`
    UPDATE profiles SET prompt_json = ?, card_text = ?, embedding_json = ?, trust_score = ?
    WHERE wallet = ? AND domain = ?
  `).run(
    card ? card.raw : null,
    card ? card.cardText : null,
    embedding ? JSON.stringify(embedding) : null,
    trustScore,
    ...key,
  );
}

async function deactivateCard(wallet, domain) {
  db.prepare('UPDATE profiles SET is_active = 0 WHERE wallet = ? AND domain = ?')
    .run(String(wallet).toLowerCase(), String(domain).toLowerCase());
}

async function pollLoop() {
  if (!CFG.registry) {
    console.warn('[indexer] REGISTRY_ADDRESS не задан — ончейн-синк отключён, работаю с локальной БД');
    return;
  }
  let cursor = getState('last_block');
  if (cursor === null) {
    cursor = CFG.startBlock !== null ? CFG.startBlock : await baseClient.getBlockNumber();
    setState('last_block', cursor);
  }
  console.log(`[indexer] синк с блока ${cursor}, RPC ${CFG.rpc}, registry ${CFG.registry}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const head = await baseClient.getBlockNumber();
      while (head > cursor) {
        const from = cursor + 1n;
        // Публичный RPC Base ограничивает eth_getLogs диапазоном в 200 блоков
        const to = head - from > 190n ? from + 190n : head;
        const logs = await baseClient.getLogs({
          address: CFG.registry,
          events: [EV.ProfileUpdated, EV.ProfileDeactivated],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          const { args } = log;
          if (log.eventName === 'ProfileUpdated') {
            console.log(`[indexer] ProfileUpdated: ${args.owner} → ${args.domain} (${args.aiPromptUri})`);
            await indexUpdatedCard(args.owner, args.domain);
          } else if (log.eventName === 'ProfileDeactivated') {
            console.log(`[indexer] ProfileDeactivated: ${args.owner} ✕ ${args.domain}`);
            await deactivateCard(args.owner, args.domain);
          }
        }
        setState('last_block', to);
        cursor = to;
      }
    } catch (err) {
      console.error('[indexer] poll error:', err.message);
    }
    await new Promise(r => setTimeout(r, CFG.pollMs));
  }
}

// ---------------------------------------------------------------- HTTP API

const app = express();
app.use(express.json({ limit: '1mb' }));

// Проверка DNS TXT (evm-contract=0x…) через Cloudflare DoH — как на сайте
app.get('/api/verify-dns', async (req, res) => {
  const domain = (req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`;
    const response = await fetch(url, { headers: { accept: 'application/dns-json' } });
    const data = await response.json();
    const records = (data.Answer || []).map(a => a.data.replace(/^"|"$/g, ''));
    const evmRecord = records.find(r => /^evm-contract=0x[0-9a-fA-F]{40}$/i.test(r));
    res.json({
      domain,
      verified: Boolean(evmRecord),
      wallet: evmRecord ? evmRecord.split('=')[1] : null,
      records,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Карточки из индекса
app.get('/api/profiles', (req, res) => {
  const domain = (req.query.domain || '').trim().toLowerCase();
  const includeInactive = req.query.includeInactive === '1';
  if (domain) {
    const row = db.prepare(
      `SELECT wallet, domain, business_info, ai_prompt_uri, is_active, trust_score, updated_at
       FROM profiles WHERE domain = ?`
    ).get(domain);
    return res.json({ profile: row || null });
  }
  const rows = db.prepare(
    `SELECT wallet, domain, business_info, ai_prompt_uri, trust_score, updated_at
     FROM profiles ${includeInactive ? '' : 'WHERE is_active = 1'}
     ORDER BY trust_score DESC, domain`
  ).all();
  res.json({ count: rows.length, profiles: rows });
});

// AI-поиск: векторный при настроенных эмбеддингах, иначе лексический (mode честно указан)
app.get('/api/ai-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const alpha = parseFloat(req.query.alpha || '0.35');
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });
  const rows = db.prepare('SELECT * FROM profiles WHERE is_active = 1').all();

  const queryTerms = tokenize(q);
  let queryVec = null;
  if (CFG.embed) queryVec = await embedText(q);
  const mode = queryVec ? 'vector' : 'lexical';

  const results = [];
  for (const row of rows) {
    let sim = null;
    if (queryVec) {
      const rowVec = row.embedding_json ? JSON.parse(row.embedding_json) : null;
      if (rowVec) sim = cosineSimilarity(queryVec, rowVec);
    }
    if (sim === null) {
      sim = lexicalSim(queryTerms, `${row.domain} ${row.business_info} ${row.card_text || ''}`);
    }
    results.push({
      wallet: row.wallet,
      domain: row.domain,
      businessInfo: row.business_info,
      aiPromptUri: row.ai_prompt_uri,
      trustScore: row.trust_score,
      cosineSimilarity: Number(sim.toFixed(4)),
      finalRankScore: Number(computeFinalRankScore(sim, row.trust_score, alpha).toFixed(4)),
    });
  }
  results.sort((a, b) => b.finalRankScore - a.finalRankScore);

  res.json({
    query: q,
    mode,
    formula: 'Cosine_Similarity * (1 + alpha * log(1 + Trust_Score))',
    results: results.slice(0, 50),
  });
});

// ---------------------------------------------------------------- self-test

async function selftest() {
  const testDb = new Database(':memory:');
  const t = testDb;
  t.exec(`
    CREATE TABLE profiles (
      wallet TEXT NOT NULL, domain TEXT NOT NULL, business_info TEXT, ai_prompt_uri TEXT,
      prompt_json TEXT, card_text TEXT, embedding_json TEXT,
      is_active INTEGER NOT NULL DEFAULT 1, trust_score REAL NOT NULL DEFAULT 10.0,
      updated_at INTEGER, synced_at INTEGER, PRIMARY KEY (wallet, domain)
    );
  `);
  const ins = t.prepare(`
    INSERT INTO profiles (wallet, domain, business_info, ai_prompt_uri, card_text, trust_score, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  const A = '0x6d48b7ee4ebe81254805ad658d756c26986ea164';
  const B = '0xa33e1d790b1139d2e2b0bc7af8109df4b7831af2';
  ins.run(A, 'p2pmarket.net', 'Decentralized marketplace node on Base L2', 'https://p2pmarket.net/schema/p2pmarket-schema.json',
    'organic wheat hazelnuts almond flour supplier export', 25.0);
  ins.run(B, 'alpina-foods.eu', 'Alpina Foods GmbH — organic food producer', 'https://alpina-foods.eu/.well-known/p2pmarket-prompt.json',
    'organic hazelnut spread chocolate confectionery EU certified', 10.0);

  const terms = tokenize('20t organic hazelnuts to Zurich');
  const simA = lexicalSim(terms, 'p2pmarket.net Decentralized marketplace node on Base L2 organic wheat hazelnuts almond flour supplier export');
  const simB = lexicalSim(terms, 'alpina-foods.eu Alpina Foods GmbH organic hazelnut spread chocolate confectionery EU certified');
  const rankA = computeFinalRankScore(simA, 25.0);
  const rankB = computeFinalRankScore(simB, 10.0);
  console.log('lexical A:', simA.toFixed(3), '→ rank', rankA.toFixed(3));
  console.log('lexical B:', simB.toFixed(3), '→ rank', rankB.toFixed(3));

  // векторная функция должна давать 1.0 на identical-векторах, ~0 на ортогональных
  const cos = cosineSimilarity([1, 0], [1, 0]);
  const cos2 = cosineSimilarity([1, 0], [0, 1]);
  const uriHttps = resolveUri('https://example.com/.well-known/prompt.json');
  const uriIpfs = resolveUri('ipfs://bafyabc123');

  const ok =
    simA > 0 && rankA > 0 &&
    Math.abs(cos - 1) < 1e-9 && Math.abs(cos2) < 1e-9 &&
    uriHttps === 'https://example.com/.well-known/prompt.json' &&
    uriIpfs === CFG.ipfsGateway + 'bafyabc123';
  console.log(ok ? 'SELFTEST OK' : 'SELFTEST FAILED');
  testDb.close();
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- main

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    selftest().catch(e => { console.error(e); process.exit(1); });
  } else {
    app.listen(CFG.port, () => {
      console.log(`[indexer] HTTP API на :${CFG.port}`);
      console.log(`[indexer] эмбеддинги: ${CFG.embed ? CFG.embed.model + ' @ ' + CFG.embed.base : 'нет → mode "lexical"'}`);
      console.log(`[indexer] Trust Score из Trade: ${CFG.trade || 'нет → базовый 10.0'}`);
    });
    pollLoop().catch(err => { console.error('[indexer] фатальная ошибка синка:', err); process.exit(1); });
  }
}

module.exports = { app, cosineSimilarity, computeFinalRankScore, tokenize, lexicalSim, resolveUri, fetchPromptCard };
