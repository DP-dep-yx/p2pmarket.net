// Local end-to-end test for the SIWE backend (no Cloudflare account needed).
// Usage: start "wrangler dev" in another terminal, then: node scripts/siwe-test.mjs
import { etc, getPublicKey, sign, utils } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, etc.concatBytes(...msgs));

const BASE_URL = process.env.TM_BASE_URL || 'http://127.0.0.1:8787';
const DOMAIN = process.env.TM_DOMAIN || new URL(BASE_URL).host;

function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function ethSignedMessageHash(message) {
  const enc = new TextEncoder();
  const prefix = '\x19Ethereum Signed Message:\n' + enc.encode(message).length;
  return keccak_256(enc.encode(prefix + message));
}

const priv = utils.randomPrivateKey();
const pub = getPublicKey(priv, false);
const address = '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(12));

const nonceRes = await fetch(BASE_URL + '/api/auth/nonce');
const { nonce } = await nonceRes.json();
if (!nonce) throw new Error('No nonce received');

const issuedAt = new Date().toISOString();
const expirationTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const message =
  DOMAIN + ' wants you to sign in with your Ethereum account:\n' +
  address + '\n\n' +
  'Sign in to the p2pmarket.net decentralized marketplace on Base.\n\n' +
  'URI: ' + BASE_URL + '\n' +
  'Version: 1\n' +
  'Chain ID: 8453\n' +
  'Nonce: ' + nonce + '\n' +
  'Issued At: ' + issuedAt + '\n' +
  'Expiration Time: ' + expirationTime;

const sig = await sign(ethSignedMessageHash(message), priv);
const sigHex = '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16).padStart(2, '0');

const verifyRes = await fetch(BASE_URL + '/api/auth/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, signature: sigHex })
});
const verifyBody = await verifyRes.json();
const cookie = verifyRes.headers.get('set-cookie') || '';

console.log('address:', address);
console.log('verify:', verifyRes.status, JSON.stringify(verifyBody));

if (!verifyBody.ok) throw new Error('Verification failed');

const replayRes = await fetch(BASE_URL + '/api/auth/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, signature: sigHex })
});
console.log('replay (must fail):', replayRes.status, JSON.stringify(await replayRes.json()));
if (replayRes.status === 200) throw new Error('Replay was accepted — nonce is not single-use');

const sessionRes = await fetch(BASE_URL + '/api/auth/session', { headers: { cookie } });
console.log('session:', sessionRes.status, JSON.stringify(await sessionRes.json()));

console.log('\nSIWE backend: ALL TESTS PASSED');
