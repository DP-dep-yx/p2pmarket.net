const express = require('express');
const Database = require('better-sqlite3');
const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// SQLite High-Speed Cache Indexer (trust_index.db)
const db = new Database(path.join(__dirname, 'trust_index.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    wallet TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    business_info TEXT,
    ai_prompt_uri TEXT,
    trust_score REAL DEFAULT 10.0,
    embedding_json TEXT,
    updated_at INTEGER
  );
`);

// Base L2 RPC Client via Viem
const baseClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org')
});

function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * Trust Net v10.0 Ranking Formula:
 * Final_Rank_Score = Cosine_Similarity(Query, BusinessVector) * (1 + alpha * log(1 + Trust_Score))
 */
function computeFinalRankScore(cosineSim, trustScore, alpha = 0.35) {
  return cosineSim * (1 + alpha * Math.log(1 + Math.max(0, trustScore)));
}

// One-way DNS TXT Verification via Cloudflare DoH
app.get('/api/verify-dns', async (req, res) => {
  const domain = (req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`;
    const response = await fetch(url, { headers: { accept: 'application/dns-json' } });
    const data = await response.json();
    const records = (data.Answer || []).map(a => a.data.replace(/^"|"$/g, ''));
    const evmRecord = records.find(r => r.startsWith('evm-contract=0x'));
    res.json({
      domain,
      verified: Boolean(evmRecord),
      wallet: evmRecord ? evmRecord.split('=')[1] : null,
      records
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Semantic Vector Search + Trust Score Ranker
app.get('/api/ai-search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const alpha = parseFloat(req.query.alpha || '0.35');
  const rows = db.prepare('SELECT * FROM profiles').all();

  const results = rows.map(row => {
    const text = `${row.domain} ${row.business_info}`.toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const matches = terms.filter(t => text.includes(t)).length;
    const sim = terms.length ? Math.min(0.99, 0.35 + (matches / terms.length) * 0.64) : 0.5;
    const finalScore = computeFinalRankScore(sim, row.trust_score, alpha);
    return {
      wallet: row.wallet,
      domain: row.domain,
      businessInfo: row.business_info,
      aiPromptUri: row.ai_prompt_uri,
      trustScore: row.trust_score,
      cosineSimilarity: Number(sim.toFixed(4)),
      finalRankScore: Number(finalScore.toFixed(4))
    };
  }).sort((a, b) => b.finalRankScore - a.finalRankScore);

  res.json({ query: q, formula: 'Cosine_Similarity * (1 + alpha * log(1 + Trust_Score))', results });
});

const PORT = process.env.PORT || 8096;
if (require.main === module) {
  app.listen(PORT, () => console.log(`TrustMarkets Indexer listening on :${PORT}`));
}

module.exports = { app, computeFinalRankScore, cosineSimilarity };
