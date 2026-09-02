# HedgePilot — Handoff Notes

Picking up where I left off. Everything below is real and tested — not
theoretical. Follow this in order and you'll be able to run and continue
the project from your own machine, using your own AI assistant.

---

## 1. Get the code

```bash
git clone https://github.com/griffburntwood/hedge-agent.git
cd hedge-agent
npm install
```

## 2. Set up your own credentials — do NOT reuse anyone else's

Copy the template:
```bash
cp .env.example .env
```

Fill in **your own** values for each:

| Variable | Where to get it |
|---|---|
| `THETANUTS_RPC_URL` | Free key from [alchemy.com](https://alchemy.com) → Create App → Base Mainnet |
| `GONKA_BASE_URL` | `https://api.gonkarouter.io/v1` |
| `GONKA_API_KEY` | Your own key from the Gonka Router dashboard (sign up if you haven't) |
| `GONKA_MODEL` | `deepseek-ai/DeepSeek-V4-Flash-0731` (confirmed working — see note below on finding others) |
| `THETANUTS_PRIVATE_KEY` | Leave blank unless you're the one holding the funded trading wallet — see Section 5 |

⚠️ **Never commit `.env`.** It's already in `.gitignore` — leave it that way.

## 3. Confirm your environment works before touching any code

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
Should print a real number (hundreds of live orders). If it errors, fix that before doing anything else — it means your RPC key isn't working.

## 4. What's already built and working

| Piece | File | Status |
|---|---|---|
| Intent parsing (text → strike/expiry/size) | `src/ai/parseIntent.js` | ✅ Tested, working |
| Trade explanation (plain-English summary) | `src/ai/parseIntent.js` (`explainTrade`) | ✅ Tested, working |
| Pre-sign safety check (contract/approval/param scoring) | `src/ai/safetyCheck.js` | ✅ Tested, working |
| Live order matching + quote preview | `src/chain/thetanuts.js` | ✅ Tested against real Base mainnet data |
| Express server tying it together | `server.js` | ✅ `/api/parse-intent` and `/api/build-trade` both confirmed working end-to-end |

**Try it yourself:**
```bash
node server.js
```
In another terminal:
```bash
curl -X POST http://localhost:3001/api/build-trade \
  -H "Content-Type: application/json" \
  -d '{"asset":"ETH","dropPercent":20,"expiryDays":7,"size":1.5,"userIntentText":"protect my ETH from a 20% drop, I have 1.5 ETH"}'
```
You should get back a real quote against a live Base mainnet order, a plain-English explanation, and a low-risk safety score.

## 5. What's NOT done yet — pick one of these up

### A. `/api/execute-trade` — needs a funded wallet, not yet tested
The code exists in `server.js` but the actual signed, real-money execution hasn't been run yet. To do this:
1. Create a disposable wallet: `npx @thetanuts-finance/cli wallet create`
2. **Get the private key, not just the address** — if it only gives a 12-word mnemonic, derive the key:
   ```bash
   node -e "
   const { ethers } = require('ethers');
   const wallet = ethers.Wallet.fromPhrase('your twelve word mnemonic here');
   console.log('Address:', wallet.address);
   console.log('Private Key:', wallet.privateKey);
   "
   ```
3. Put the private key (66 characters, starts with `0x`) in `.env` as `THETANUTS_PRIVATE_KEY`
4. Fund that wallet with 1-3 USDC + a small amount of ETH on **Base network** (not Ethereum, not any other chain)
5. Once funded, test:
   ```bash
   curl -X POST http://localhost:3001/api/execute-trade \
     -H "Content-Type: application/json" \
     -d '{"orderId":"PASTE_ORDER_ID_FROM_BUILD_TRADE_RESPONSE"}'
   ```
   Note: `orderId` comes from a fresh `/api/build-trade` call — it's stored temporarily in memory, so build-trade and execute-trade need to happen close together (server hasn't restarted in between).

### B. UI — nothing built yet
A simple web page: text input → "Get Quote" (calls `/api/build-trade`) → show the trade summary + safety score → "Confirm & Execute" button (calls `/api/execute-trade`) → show the resulting transaction hash + a Basescan link.

Keep it simple — plain HTML + fetch() calls to the server is enough for a hackathon demo. No need for React unless you're already comfortable with it.

### C. Guardian mode — not started
The 24/7 autonomous-trigger concept: feed a headline/event to Gonka, have it score credibility + impact, and if it crosses a threshold, automatically call the same `/api/build-trade` → `/api/execute-trade` pipeline that already works. Reuses everything that's already built — just a new entry point.

## 6. Known gaps — don't be surprised by these

- **BTC isn't supported yet.** Only ETH's underlying token address is filled in in `src/chain/thetanuts.js` (`UNDERLYING_TOKENS`). To add BTC, fetch a live BTC order and read its `order.underlyingToken` field, then add it to that map.
- **Fill size is hardcoded to 1 USDC** (`DEMO_FILL_AMOUNT_USDC` in `thetanuts.js`) — deliberate, per the hackathon's "trade small" guidance. Don't change this without a good reason.

## 7. If you get stuck on a Thetanuts SDK question

Don't guess at method names — the SDK's real reference doc is more reliable than any AI's memory of it. Pull it fresh:

```bash
curl -s https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/llms-full.txt -o llms-full.txt
```

Then either read it yourself, or paste its contents (or the relevant section) to your AI assistant before asking it to write Thetanuts-related code. This is exactly how the working code in this repo was built — by checking real method names and real data shapes against this file rather than assuming.

You can also run the official MCP server and connect it to an MCP-aware assistant (Claude Code, Cursor, etc.) for the same effect:
```bash
npx -y @thetanuts-finance/mcp
```

## 8. Safety rules — same for everyone touching this repo

- Trade small — 1-3 USDC is plenty, never more.
- Fresh, disposable wallet only — never one holding anything real.
- Never commit a private key. Check `git status` before every commit.
- Approve exact amounts only, never unlimited (`MaxUint256`).
- Always test with a preview/dry-run before anything that actually signs and sends.

---

Questions — message me directly rather than guessing, especially anything touching the wallet/execution side.
