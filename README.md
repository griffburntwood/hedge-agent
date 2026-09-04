# HedgePilot

AI-powered downside protection for crypto — hedge your ETH with real, on-chain options, either on request or automatically when the AI detects a genuine threat.

Built for the MUBA Hackathon — Track 2 (AI × Options).

---

## Project Description

HedgePilot is an AI agent that turns plain-language hedging requests into real, executed options trades on Base. A user states how much of an asset they hold and how much downside protection they want; the AI parses that into precise trade parameters, finds a live matching option on Thetanuts' order book, explains the trade in plain English, runs a safety check, and — only once the user confirms — executes a real transaction on Base mainnet.

A second mode, **Guardian Mode**, lets the same AI evaluate market events and decide whether they're a credible enough threat to the user's specific holdings to warrant hedging automatically — still requiring the user's final confirmation before anything executes.

## Problem Statement

Options are the standard tool for hedging downside risk in traditional finance, but on-chain they remain largely inaccessible to everyday holders. Protecting a position without selling it requires understanding strikes, expiries, premiums, and order books — knowledge most crypto holders don't have and don't have time to learn. Existing on-chain protection tools either require that expertise directly, or don't exist for retail-sized positions at all.

HedgePilot removes that barrier: the user describes their goal in plain language (or a simple form), and the AI handles the translation into an executable, correctly-priced trade — while a transparent safety check ensures nothing is signed blindly.

## Blockchain Technology Used

- **Base** (chainId 8453) — Ethereum L2, where all trades are quoted and executed
- **Thetanuts Finance SDK** (`@thetanuts-finance/thetanuts-client`) — decentralized options protocol; source of live quotes, order matching, and trade execution (OptionBook)
- **Gonka Router** — decentralized AI inference network (OpenAI-compatible API); powers intent parsing, trade explanations, and Guardian Mode's threat scoring

## Smart Contract Addresses

**Note:** The Thetanuts SDK has no testnet configuration — it operates exclusively on Base mainnet (chainId 8453) and Ethereum mainnet (chainId 1). All addresses below are real, live mainnet contracts. Trades in this project are executed with intentionally small amounts (1 USDC) specifically because there is no testnet to rehearse on safely.

| Contract | Address | Network |
|---|---|---|
| Thetanuts OptionBook | `0x1bDff855d6811728acaDC00989e79143a2bdfDed` | Base Mainnet |
| USDC (collateral token) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Base Mainnet |
| aBasUSDC (Aave Base USDC collateral) | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` | Base Mainnet |
| WETH (underlying, ETH options) | `0x4200000000000000000000000000000000000006` | Base Mainnet |

## Setup and Installation

### Prerequisites
- Node.js 18+
- A free Base mainnet RPC key ([alchemy.com](https://alchemy.com) → Create App → Base Mainnet, or [infura.io](https://infura.io))
- A Gonka Router API key ([gonkarouter.io](https://gonkarouter.io))

### Install

```bash
git clone https://github.com/griffburntwood/hedge-agent.git
cd hedge-agent
npm install
```

### Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```
THETANUTS_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
THETANUTS_PRIVATE_KEY=            # only needed to execute real trades — see below
GONKA_BASE_URL=https://api.gonkarouter.io/v1
GONKA_API_KEY=YOUR_GONKA_KEY
GONKA_MODEL=deepseek-ai/DeepSeek-V4-Flash-0731
```

**On `THETANUTS_PRIVATE_KEY`:** this project executes real transactions with real (small) funds — there is no testnet. Use a fresh, disposable wallet only, never one holding anything of value:

```bash
npx @thetanuts-finance/cli wallet create
```

Fund it with 1-3 USDC + a small amount of ETH (for gas) on Base network before attempting to execute a trade.

### Verify the setup

```bash
node -e "
import('dotenv/config').then(async () => {
  const { ethers } = await import('ethers');
  const { ThetanutsClient } = await import('@thetanuts-finance/thetanuts-client');
  const client = new ThetanutsClient({ chainId: 8453, provider: new ethers.JsonRpcProvider(process.env.THETANUTS_RPC_URL) });
  console.log((await client.api.fetchOrders()).length, 'live orders');
});
"
```
Should print a real number of live orders.

### Run

```bash
node server.js
```
Open `public/index.html` in a browser (or visit `http://localhost:3001` if serving statically).

## Team Members

- [Qinyi] — AI integration, chain integration, backend
- [WaiYang] — Frontend / UI
- [XinYuan] — Guardian Mode / AI risk scoring

---

## Known Limitations

- BTC and other assets are not yet supported (only ETH's underlying token address is configured)
- Post-expiry payout claiming is not yet automated — this project covers entering a hedge, not the full lifecycle
- Guardian Mode evaluates a curated set of example events rather than a live news feed, by deliberate design choice for demo reliability
