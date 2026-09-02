import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import { parseIntent, computeStrike, explainTrade } from './src/ai/parseIntent.js';
import { checkTransactionSafety } from './src/ai/safetyCheck.js';

const app = express();
app.use(cors());
app.use(express.json());

const provider = new ethers.JsonRpcProvider(process.env.THETANUTS_RPC_URL);
const client = new ThetanutsClient({ chainId: 8453, provider });

// ---------------------------------------------------------------------------
// POST /api/parse-intent
// Body: { text: "protect my ETH from a 20% drop, I have 1.5 ETH" }
// Returns: { asset, dropPercent, expiryDays, size }
// ---------------------------------------------------------------------------
app.post('/api/parse-intent', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Missing "text" in request body.' });

        const intent = await parseIntent(text);
        res.json(intent);
    } catch (err) {
        console.error('parse-intent error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/build-trade
// Body: { asset, dropPercent, expiryDays, size, userIntentText }
// Returns: { params, quote, unsignedTx, explanation, safety }
//
// *** TODO — the Thetanuts-specific part below is NOT filled in. ***
// The SDK's exact method names for fetching a live quote and building an
// unsigned transaction are intentionally not guessed here — the builder
// doc explicitly says this part lives in the docs/repo, not the kickstart
// sheet. To find the real method names:
//
//   1. Run: npx -y @thetanuts-finance/mcp
//      Then ask your coding assistant to call get_sdk_context — it loads
//      the whole SDK (types, workflows, gotchas) so you're not guessing.
//   2. Or read: docs.thetanuts.finance/for-builders/sdk
//   3. Or grab llms-full.txt from the repo root and feed it to your coding
//      assistant before asking it to write this function.
//
// What you're looking for, conceptually:
//   - A method to fetch live orders/quotes for a given asset (something
//     built on top of client.api.fetchOrders(), which you already know works)
//   - A method to build (not sign) a transaction that fills an existing
//     OptionBook order matching your target strike/expiry/size
//   - The result should be an UNSIGNED transaction object/hex you can send
//     to a browser wallet (MetaMask) to sign — never sign it here on the
//     server with a private key for the live demo.
// ---------------------------------------------------------------------------
app.post('/api/build-trade', async (req, res) => {
    try {
        const { asset, dropPercent, expiryDays, size, userIntentText } = req.body;
        if (!asset || dropPercent == null || !expiryDays || !size) {
            return res.status(400).json({ error: 'Missing required trade parameters.' });
        }

        // --- Step 1: get real market data (this part IS proven to work) -------
        const marketData = await client.api.getMarketData();
        // TODO: pull the real spot price for `asset` out of marketData once you
        // know its shape (console.log(marketData) to inspect it).
        const spotPrice = marketData?.[asset]?.spotPrice ?? null;
        if (spotPrice == null) {
            return res.status(501).json({
                error: `TODO: extract spot price for ${asset} from marketData. See server.js comments.`,
                marketDataSample: marketData,
            });
        }

        const strike = computeStrike(spotPrice, dropPercent);

        // --- Step 2: fetch a live quote for this strike/expiry/size -----------
        // TODO: replace with the real SDK call once you've found it via MCP/docs.
        // e.g. something like: const quote = await client.optionBook.getQuote({...})
        return res.status(501).json({
            error: 'TODO: implement live quote fetching + unsigned tx building. See comments in server.js.',
            computedSoFar: { asset, strike, expiryDays, size, spotPrice },
        });

        // --- Once real quote/tx building works, the rest of the flow is ready:
        //
        // const premium = quote.premium;
        // const explanation = await explainTrade({ asset, size, strike, expiryDays, premium });
        // const safety = await checkTransactionSafety(
        //   userIntentText,
        //   { asset, size, strike, expiryDays },
        //   { to: unsignedTx.to, approvalAmount: approvalAmount, tradeSize: size }
        // );
        // res.json({ params: { asset, strike, expiryDays, size }, quote, unsignedTx, explanation, safety });

    } catch (err) {
        console.error('build-trade error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/safety-check
// Body: { userIntentText, builtParams, tx }
// Returns: { overallRisk, findings }
// (Exposed standalone too, in case the UI wants to re-check before signing)
// ---------------------------------------------------------------------------
app.post('/api/safety-check', async (req, res) => {
    try {
        const { userIntentText, builtParams, tx } = req.body;
        if (!userIntentText || !builtParams || !tx) {
            return res.status(400).json({ error: 'Missing userIntentText, builtParams, or tx in request body.' });
        }
        const result = await checkTransactionSafety(userIntentText, builtParams, tx);
        res.json(result);
    } catch (err) {
        console.error('safety-check error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/health — quick check that the server + Thetanuts connection work
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
    try {
        const orders = await client.api.fetchOrders();
        res.json({ status: 'ok', liveOrders: orders.length });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Try: curl http://localhost:${PORT}/api/health`);
});