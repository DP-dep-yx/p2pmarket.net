// TrustMarkets.net — Cloudflare Worker
// Static site (Workers Assets) + SIWE (EIP-4361) auth backend:
//   GET  /api/auth/nonce   -> { nonce, expiresIn }
//   POST /api/auth/verify  -> verifies signature, sets signed session cookie
//   GET  /api/auth/session -> current session status
// All other paths are served from static assets.

import { keccak_256 } from '@noble/hashes/sha3';
import { Signature } from '@noble/secp256k1';

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_CHAIN_IDS = new Set(['8453', '84532']); // Base Mainnet, Base Sepolia

const nonces = new Map(); // best-effort single-use store (per-isolate)

function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(headers || {})
    }
  });
}

function issueNonce() {
  const now = Date.now();
  if (nonces.size > 500) {
    for (const [k, exp] of nonces) if (exp < now) nonces.delete(k);
  }
  const nonce = randomHex(16);
  nonces.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

function consumeNonce(nonce) {
  const exp = nonces.get(nonce);
  if (!exp) return false;
  nonces.delete(nonce);
  return Date.now() <= exp;
}

// Minimal EIP-4361 parser for the canonical message format used by the site.
function parseSiweMessage(message) {
  const lines = String(message).split('\n');
  if (lines.length < 8) return null;
  const domainLine = lines[0];
  if (!/ wants you to sign in with your Ethereum account:$/.test(domainLine)) return null;
  const domain = domainLine.replace(/ wants you to sign in with your Ethereum account:$/, '');

  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const address = lines[i++] || '';

  while (i < lines.length && lines[i].trim() === '') i++;
  let statement = '';
  if (i < lines.length && !/^URI: /.test(lines[i])) {
    statement = lines[i++];
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  const fields = {};
  for (; i < lines.length; i++) {
    const m = /^([A-Za-z ]+): (.*)$/.exec(lines[i]);
    if (m) fields[m[1].toLowerCase()] = m[2];
  }

  if (!/^[a-z0-9.-]+$/i.test(domain)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return { domain, address, statement, fields };
}

function ethSignedMessageHash(message) {
  const prefix = '\x19Ethereum Signed Message:\n' + new TextEncoder().encode(message).length;
  const data = new TextEncoder().encode(prefix + message);
  return keccak_256(data);
}

function recoveryParamFromV(v) {
  if (v >= 35) return v - 35;
  if (v >= 27) return v - 27;
  return v & 1;
}

function recoverSignerAddress(message, signatureHex) {
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new Error('Signature must be 65 bytes (r,s,v)');
  const compact = sig.slice(0, 64);
  const recovery = recoveryParamFromV(sig[64]);
  const hash = ethSignedMessageHash(message);
  const sigObj = Signature.fromCompact(compact).addRecoveryBit(recovery);
  const point = sigObj.recoverPublicKey(hash);
  const pubBytes = point.toRawBytes(false).slice(1); // drop 0x04 prefix
  const addrHash = keccak_256(pubBytes);
  return '0x' + bytesToHex(addrHash.slice(12));
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// основной домен и его старые имена: по ним же проверяется SIWE-сообщение
const PRIMARY_DOMAIN = 'p2pmarket.net';
const SITE_DOMAINS = [PRIMARY_DOMAIN, 'trustmarkets.net'];

// эти хосты 301-ят на основной домен (api.trustmarkets.net остаётся жить для старых клиентов)
const REDIRECT_HOSTS = new Set([`www.${PRIMARY_DOMAIN}`, 'trustmarkets.net', 'www.trustmarkets.net']);

const CORS_ORIGINS = new Set(SITE_DOMAINS.flatMap((d) => [`https://${d}`, `http://${d}`, `https://www.${d}`]));

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  if (!CORS_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'vary': 'origin'
  };
}

const te = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    te.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(data)));
}

async function issueSessionCookie(address, secret) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${address.toLowerCase()}.${exp}`;
  const mac = b64url(await hmac(secret, payload));
  return `tm_session=${payload}.${mac}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; HttpOnly; Secure; SameSite=None`;
}

async function readSessionCookie(request, secret) {
  const raw = request.headers.get('cookie') || '';
  const m = /tm_session=([^;]+)/.exec(raw);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const [address, exp, mac] = parts;
  const expected = b64url(await hmac(secret, `${address}.${exp}`));
  if (expected !== mac) return null;
  if (Date.now() > Number(exp)) return null;
  return address;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const secret = (env && env.WORKER_SECRET) || 'dev-secret';
    const cors = corsHeaders(request);
    const j = (obj, status, headers) => json(obj, status, Object.assign({}, cors, headers || {}));

    // старые домены уводим на новый основной, путь и query сохраняем
    if (REDIRECT_HOSTS.has(url.hostname.toLowerCase())) {
      const target = new URL(request.url);
      target.protocol = 'https:';
      target.hostname = PRIMARY_DOMAIN;
      target.port = '';
      const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
      return Response.redirect(target.toString(), status);
    }

    if (path.startsWith('/api/') && request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: Object.assign({}, cors, {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
          'cache-control': 'no-store'
        })
      });
    }

    if (path === '/api/auth/nonce' && request.method === 'GET') {
      const nonce = issueNonce();
      return j({ nonce, expiresIn: NONCE_TTL_MS / 1000 });
    }

    if (path === '/api/auth/verify' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return j({ ok: false, error: 'Invalid JSON body' }, 400);
      }
      const { message, signature } = body || {};
      if (typeof message !== 'string' || typeof signature !== 'string') {
        return j({ ok: false, error: 'Missing message or signature' }, 400);
      }

      const parsed = parseSiweMessage(message);
      if (!parsed) return j({ ok: false, error: 'Malformed EIP-4361 message' }, 400);

      if (parsed.fields['version'] !== '1') {
        return j({ ok: false, error: 'Unsupported SIWE version' }, 400);
      }
      const chainId = String(parsed.fields['chain id'] || '');
      if (!ALLOWED_CHAIN_IDS.has(chainId)) {
        return j({ ok: false, error: `Chain ID ${chainId || 'missing'} not allowed (Base only)` }, 400);
      }

      const host = (request.headers.get('host') || '').split(':')[0].toLowerCase();
      const msgDomain = parsed.domain.toLowerCase();
      const hostOk = msgDomain === host ||
        SITE_DOMAINS.some((d) => msgDomain === d && (host === d || host.endsWith(`.${d}`))) ||
        host.endsWith('workers.dev') || host.endsWith('localhost') || host.startsWith('127.');
      if (!hostOk) {
        return j({ ok: false, error: `Domain mismatch: ${parsed.domain}` }, 400, corsHeaders(request));
      }

      const nonce = parsed.fields['nonce'] || '';
      if (!nonce || !consumeNonce(nonce)) {
        return j({ ok: false, error: 'Nonce unknown or already used' }, 401);
      }

      const expTime = parsed.fields['expiration time'];
      if (!expTime || Date.now() > Date.parse(expTime)) {
        return j({ ok: false, error: 'Message expired' }, 401);
      }
      const issuedAt = parsed.fields['issued at'];
      if (issuedAt && Date.parse(issuedAt) > Date.now() + 60 * 1000) {
        return j({ ok: false, error: 'Issued At in the future' }, 400);
      }

      let recovered;
      try {
        recovered = recoverSignerAddress(message, signature);
      } catch (e) {
        return j({ ok: false, error: 'Signature verification failed' }, 401);
      }
      if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
        return j({ ok: false, error: 'Recovered address does not match' }, 401);
      }

      return j(
        { ok: true, address: parsed.address, chainId: Number(chainId) },
        200,
        { 'set-cookie': await issueSessionCookie(parsed.address, secret) }
      );
    }

    if (path === '/api/auth/session' && request.method === 'GET') {
      const address = await readSessionCookie(request, secret);
      return j(address ? { authenticated: true, address } : { authenticated: false });
    }

    if (path.startsWith('/api/')) {
      return j({ ok: false, error: 'Not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
