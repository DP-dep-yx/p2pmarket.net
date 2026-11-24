# p2pmarket.net — Decentralized AI Marketplace & Universal Trade Node on Base L2

**Live Platform:** [https://p2pmarket.net](https://p2pmarket.net)  
**Public JSON-LD Business Card:** [`https://p2pmarket.net/.well-known/p2pmarket-prompt.json`](https://p2pmarket.net/.well-known/p2pmarket-prompt.json)  
**JSON-LD Schema Standard (v17.0):** [`https://p2pmarket.net/schema/p2pmarket-schema.json`](https://p2pmarket.net/schema/p2pmarket-schema.json)  
**Protocol Version:** `v17.2` · **Network:** Base L2 (`EVM Chain ID 8453 / 84532`)

---

## 1. Architecture Overview & Philosophy

**p2pmarket.net** is an open, decentralized trade protocol on **Base L2** that turns any company website into an autonomous trading node. It eliminates centralized marketplace gatekeepers, 15–30% platform commissions, paid search rankings, and ad-spend dependencies by connecting:

1. **Independent Web2 Company Domains** — verified via cryptographic DNS `TXT` bindings (`evm-contract=0x…`) over Cloudflare DNS-over-HTTPS (DoH).
2. **Two-Way Public JSON-LD Profiles (`.well-known/p2pmarket-prompt.json`)** — machine-readable Schema.org business cards declaring both what a company sells (`makesOffer`) and what it procures (`potentialAction` / `Demand`).
3. **Base L2 Smart Contracts (`P2PMarketRegistry.sol` & `P2PMarketTrade.sol`)** — immutable on-chain identity, anti-spam economic filters, mutual NDA handshakes, USDC escrow, Net-30/60 commercial invoice settlement, independent quality auditing, credit pools, and cargo insurance.
4. **Zero-Cost Client AI Agents (MCP)** — external AI assistants (ChatGPT, Claude, Cursor, Gemini) query the semantic index and negotiate deals directly on behalf of buyers and sellers via the **Model Context Protocol (MCP)**.

---

## 2. Core Value Propositions

### For Sellers (Vendors & Service Providers)
* **True Data Ownership & Immutable Identity** — Your product catalogs and service listings live directly on your own website, completely under your control. Your domain is cryptographically linked to your Web3 wallet on Base — no centralized platform can edit, throttle, or delete your identity.
* **Unlimited Freedom & Zero Censorship** — Publish as many products, services, and commercial offers as you want without marketplace gatekeepers, arbitrary listing bans, or restrictive platform rules.
* **Global Open Access for AI & Humans** — Every user and every AI agent (ChatGPT, Claude, Cursor) can index and discover your offerings in real time without paid ads or paywalls.
* **Seamless Domain Migration & Loss Protection** — Your corporate identity and Trust Score are bound to your Web3 wallet, not a single Web2 domain. If you lose access to a domain or rebrand, you can unbind the old domain (`deactivateProfile`) and bind a new one to the same wallet — preserving 100% of your completed smart contracts and on-chain reputation.

### For Buyers (Clients & Procurement Teams)
* **Verifiable Sales History** — No fake reviews or manipulated star ratings. Anyone can audit a seller's real on-chain transaction volume and settled order history on Base.
* **Authentic Trust Score** — Seller credibility ratings are mathematically derived from actual completed smart contracts and settled escrows, making reputation 100% transparent and unforgeable.
* **Unbiased & Direct Sourcing** — Search across the global network with complete transparency — no ad-sponsored top listings or hidden marketplace markups.

---

## 3. Economic Model & Tariff Grid (`$1 + 0.1%` via Chainlink Oracle)

All protocol fees are priced in USD and converted dynamically on-chain into native **Base ETH** using the live **Chainlink ETH/USD Data Feed** (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` on Base Mainnet), complete with a 24-hour oracle staleness guard:

| Operation / Component | Tariff (USD Equivalent) | On-Chain Mechanism & Anti-Spam Design |
| :--- | :--- | :--- |
| **Profile Registration & Update (`setProfile`)** | **$1.00 Flat Fee** (in Base ETH) | Paid on registration and profile updates (`registrationFeeWei() = 1e26 / ethUsdPrice`). Keeps the registry bot-free (*Skin in the Game*). |
| **Emergency Domain Unbinding (`deactivateProfile`)** | **$1.00 Flat Fee** (in Base ETH) | Economic symmetry against spam deactivations while allowing instant domain unbinding if DNS is compromised. |
| **Trade Deal Registration (`createDeal`)** | **0.1% Protocol Fee** (in Base ETH) | Charged on **every registered deal** with an amount — **both USDC Escrow deals and post-paid Net-30/60 invoices** (`dealFeeWei(amountUsdc)`). Paid in Base ETH at deal creation with automatic overpay refund. Escrowed USDC is never deducted: 100% of the deal amount reaches the seller. |
| **AI Search, MCP & SIWE Verification** | **$0.00 (Free)** | Runs on the user's client-side AI models and free Base RPC `view` calls. |

---

## 4. Smart Contract Architecture (`/contracts`)

### 4.1. `P2PMarketRegistry.sol` (v17.1)
Decentralized identity registry separating wallet reputation from Web2 domain names:
* **Multi-Domain Architecture (`1 Wallet = N Domains`):**
  * `mapping(bytes32 => address) public domainToOwner` — maps `keccak256(cleanDomain)` to the owning wallet.
  * `mapping(bytes32 => BusinessProfile) public domainProfiles` — stores `domain`, `businessInfo`, `aiPromptUri`, `updatedAt`, and `isActive` per domain hash.
  * `mapping(address => bytes32[]) public ownerDomains` — tracks all domains registered by a wallet.
* **On-Chain ASCII Normalization & Validation:** `_toLower()` normalizes domains to lowercase ASCII; `_validateCleanDomain()` rejects protocol prefixes (`:`) and path slashes (`/`).
* **Chainlink-Priced `$1` Fee:** `registrationFeeWei()` queries `AggregatorV3Interface.latestRoundData()` and reverts if `price <= 0` or `updatedAt + 24 hours < block.timestamp`.
* **Emergency Deactivation:** `deactivateProfile(string _domain)` unbinds a compromised domain (`delete domainToOwner[domainHash]`, `isActive = false`) while keeping the wallet's deal history intact.
* **Contract Type 2 — Mutual Attestation Handshake (NDA):** `proposeOrAcceptHandshake(address counterparty)` and `revokeHandshake(address counterparty)` establish on-chain bilateral trust (`hasActiveHandshake`), unlocking SIWE-gated confidential price lists and private endpoints.

### 4.2. `P2PMarketTrade.sol` (v17.2)
Hybrid trade settlement, validation, credit, and insurance engine covering Smart Contract Types 3, 4, 5, and 6:
* **Contract Type 3 — Hybrid Sale (USDC Escrow or Net-30/60 Commercial Invoice):**
  * `createDeal(seller, auditor, amountUsdc, netDays, termsHash, isEscrowEnabled) external payable`
  * Collects the `0.1%` protocol fee (`DEAL_FEE_BPS = 10`) in Base ETH via `dealFeeWei(amountUsdc)`, forwards `feeWei` to the immutable `treasury`, and refunds any excess `msg.value - feeWei` to the caller.
  * When `isEscrowEnabled == true`, locks `amountUsdc` in Circle USDC inside the contract. When `false`, registers a non-escrow Net-30/60 commercial invoice settled off-chain (SEPA/SWIFT) and confirmed on-chain.
* **Contract Type 4 — Independent Quality & Warehouse Auditor:**
  * `submitAuditorAttestation(dealId, reportHash)` — designated auditor records a cryptographic inspection hash and increments `auditedDealsCount` for both parties.
* **Contract Type 5 — Deal-Collateralized Credit Pool:**
  * `fundDealWithCredit(dealId)` — external liquidity provider funds an escrow deal in USDC on behalf of the buyer.
* **Contract Type 6 — Parametric Cargo & Logistics Insurance:**
  * `attachInsurance(dealId, coverageUsdc)` — insurer locks USDC coverage reserve into the deal.
* **Settlement & Reputation Counters:**
  * `settleDeal(dealId)` releases the full `amountUsdc` to the seller (in escrow mode) or records seller confirmation (in Net-30/60 invoice mode), updating on-chain reputation counters (`completedDealsCount`, `onTimeInvoiceSettlements`).

---

## 5. Two-Way JSON-LD Business Card Standard (`/.well-known/p2pmarket-prompt.json`)

Instead of storing bulky product catalogs on-chain, `P2PMarketRegistry.sol` stores a lightweight `aiPromptUri` pointing to a self-hosted JSON-LD file built on **Schema.org**:

1. **Identity & Web3 Binding (`Organization`):**
   * Standard `name`, `url`, `logo`, `description`, `address` (`PostalAddress`), `contactPoint`, and `knowsAbout` categories.
   * Web3 wallet binding under `identifier`:
     ```json
     "identifier": {
       "@type": "PropertyValue",
       "propertyID": "P2PMarketBaseAddress",
       "value": "0x6d48b7EE4ebE81254805ad658D756C26986Ea164"
     }
     ```
2. **Sales Catalog (`makesOffer`):** Array of `@type: "Offer"` items detailing products/services, `sku`, `price`, `priceCurrency`, `incotermsDetails`, minimum volume, and accepted payment methods (SEPA, Invoice, USDC on Base).
3. **Procurement Needs (`potentialAction` / `Demand`):** Array of required raw materials, components, or ecosystem services (`targetVolume`, `preferredIncoterms`, `maxBudget`), enabling AI agents to perform bilateral supply-chain matching.
4. **Logistics (`logistics`) & Agent Instructions (`x-agent-instructions`):** Certified carriers with Base contract addresses and rules for requesting SIWE-protected private price lists.

---

## 6. Off-Chain Components

### 6.1. Cloudflare Worker Edge Service (`/worker`)
* Serves the static platform frontend, schema files, and `.well-known/p2pmarket-prompt.json` from Cloudflare's edge (`run_worker_first: true`).
* Enforces canonical domain redirects (`trustmarkets.net`, `www.trustmarkets.net`, `www.p2pmarket.net` → `301/308` to `https://p2pmarket.net`) and legacy schema path redirects.
* Implements **Sign-In with Ethereum (SIWE / EIP-4361)** endpoints:
  * `GET /api/auth/nonce` — issues a single-use cryptographic nonce.
  * `POST /api/auth/verify` — parses the EIP-4361 message, verifies Base chain ID (`8453` / `84532`), recovers the secp256k1 signer address via `@noble/secp256k1` + `@noble/hashes` (Keccak-256), and issues an HMAC-SHA256 signed `HttpOnly` session cookie (`WORKER_SECRET`).
  * `GET /api/auth/session` — validates the active session cookie.

### 6.2. Base L2 Event Indexer & Semantic Search Engine (`/backend`)
* **Chunked Event Sync:** `backend/indexer.js` polls `ProfileUpdated` and `ProfileDeactivated` logs from `P2PMarketRegistry` via `viem` in 190-block windows (respecting Base public RPC 200-block `eth_getLogs` limits) and persists the block cursor in SQLite (`sync_state`).
* **Multi-Domain SQLite Schema:** Stores profiles keyed by `PRIMARY KEY (wallet, domain)`, fetches and parses the remote `aiPromptUri` JSON-LD card (supporting `https://` and `ipfs://` gateways), and computes live on-chain Trust Scores from `P2PMarketTrade`.
* **Trust-Weighted Semantic Ranking Formula:**
  $$\text{Final\_Rank\_Score} = \text{Cosine\_Similarity}(Q, B) \times \left(1 + \alpha \cdot \ln(1 + \text{Trust\_Score})\right)$$
  Supports both real vector embeddings (`mode: "vector"` via any OpenAI-compatible `/embeddings` endpoint) and deterministic lexical fallback (`mode: "lexical"`).
* **HTTP API:**
  * `GET /api/verify-dns?domain=example.com` — verifies `evm-contract=0x…` DNS `TXT` record via Cloudflare DoH.
  * `GET /api/profiles` — lists active indexed company profiles.
  * `GET /api/ai-search?q=…&alpha=0.35` — returns ranked supplier/buyer matches.

---

## 7. Deployed Contract Addresses

### Base Mainnet (`Chain ID 8453` — Live Production)
| Contract | Address | Notes |
| :--- | :--- | :--- |
| **`P2PMarketRegistry`** | [`0xc53782ba14b06CD195A9125C6abf27CB25e5F5e5`](https://basescan.org/address/0xc53782ba14b06CD195A9125C6abf27CB25e5F5e5) | Multi-domain identity registry (`$1` fee via Chainlink ETH/USD) |
| **`P2PMarketTrade`** | [`0xc2ae0f6AD5d71dD1Fa2470811b1F2A81226E08E0`](https://basescan.org/address/0xc2ae0f6AD5d71dD1Fa2470811b1F2A81226E08E0) | Hybrid USDC Escrow & Net-30/60 engine (`0.1%` fee via Chainlink ETH/USD) |
| **Chainlink ETH/USD Feed** | [`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`](https://basescan.org/address/0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70) | Official Chainlink oracle (8 decimals) |
| **Circle Native USDC** | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) | Official Circle USDC on Base (6 decimals) |

### Base Sepolia Testnet (`Chain ID 84532` — Verified Live Rehearsal)
| Contract | Address | Notes |
| :--- | :--- | :--- |
| **`MockEthUsdFeed`** | `0x8768A8A0F1d9eed9d9154d22149a8B7D460b99f4` | Testnet Chainlink ETH/USD stand-in (8 decimals) |
| **`P2PMarketRegistry`** | `0x5BAe147f7Fa6dF905e642C6a2247AdBA8f054A63` | Live `p2pmarket.net` profile registered & indexed |
| **`P2PMarketTrade`** | `0x90879b5d29Cb641b30fB123229d9E6B0641517B3` | Connected to Circle Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) |

---

## 8. Repository Structure & Quick Start

```text
.
├── .well-known/
│   └── p2pmarket-prompt.json      # Live JSON-LD business card for p2pmarket.net
├── schema/
│   └── p2pmarket-schema.json      # P2PMarket B2B Semantic Standard v17.0 reference
├── contracts/
│   ├── P2PMarketRegistry.sol      # Multi-domain on-chain registry ($1 via Chainlink)
│   ├── P2PMarketTrade.sol         # Escrow, Net-30/60, audit, credit & insurance (0.1% in ETH)
│   └── mocks/
│       └── MockEthUsdFeed.sol     # Testnet oracle mock
├── backend/
│   ├── indexer.js                 # Base L2 event indexer, DoH verifier & search API
│   └── abi/
│       └── P2PMarketRegistry.json # Solc-generated contract ABI
├── worker/
│   ├── worker.js                  # Cloudflare Worker (static assets, redirects, SIWE auth)
│   └── wrangler.jsonc             # Cloudflare Worker & custom domain configuration
└── index.html                     # Interactive protocol UI, onboarding wizard & simulator
```

### Run the Indexer Locally
```bash
cd backend
npm install
npm run selftest

# Start with live Base Sepolia sync:
BASE_RPC_URL="https://sepolia.base.org" \
REGISTRY_ADDRESS="0x5BAe147f7Fa6dF905e642C6a2247AdBA8f054A63" \
TRADE_ADDRESS="0x90879b5d29Cb641b30fB123229d9E6B0641517B3" \
npm start
```

### Deploy the Cloudflare Worker
```bash
cd worker
npm install
npm run deploy
```

---

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).
