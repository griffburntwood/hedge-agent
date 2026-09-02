import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import { parseIntent, computeStrike, explainTrade } from './src/ai/parseIntent.js';
import { checkTransactionSafety } from './src/ai/safetyCheck.js';
import { findMatchingPutOrder, previewOrder, executeOrder, getSpotPrice } from './src/chain/thetanuts.js';

const app = express();
app.use(cors());
app.use(express.json());

const provider = new ethers.JsonRpcProvider(process.env.THETANUTS_RPC_URL);
const client = new ThetanutsClient({ chainId: 8453, provider });

// ---------------------------------------------------------------------------
// POST /api/parse-intent
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
// Returns a PREVIEW ONLY — no funds move, no signing happens here.
// The response includes an `orderId` the frontend must pass back to
// /api/execute-trade once the user confirms.
// ---------------------------------------------------------------------------
const pendingOrders = new Map(); // demo-only in-memory store; fine for a hackathon

app.post('/api/build-trade', async (req, res) => {
    try {
        const { asset, dropPercent, expiryDays, size, userIntentText } = req.body;
        if (!asset || dropPercent == null || !expiryDays || !size) {
            return res.status(400).json({ error: 'Missing required trade parameters.' });
        }

        const spotPrice = await getSpotPrice(asset);
        const strike = computeStrike(spotPrice, dropPercent);

        const matchedOrder = await findMatchingPutOrder({ asset, targetStrike: strike, expiryDays });
        const preview = await previewOrder(matchedOrder);

        const params = { asset, strike, expiryDays, size, spotPrice };
        const explanation = await explainTrade({
            asset,
            size,
            strike,
            expiryDays,
            premium: preview.totalCollateralUsd, // correctly converted from 6-decimal USDC
        });

        const safety = await checkTransactionSafety(
            userIntentText || '',
            params,
            {
                // The transaction actually calls the OptionBook contract, not the
                // order's maker address — that's what needs to be allow-listed.
                to: preview.optionBookAddress,
                approvalAmount: preview.totalCollateral,
                tradeSize: preview.fillAmountUsdc,
            }
        );

        const orderId = `${matchedOrder.order.nonce}`;
        pendingOrders.set(orderId, matchedOrder);

        res.json({ orderId, params, preview, explanation, safety });
    } catch (err) {
        console.error('build-trade error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/execute-trade
// Body: { orderId }
// This is the REAL, SIGNED transaction. Only call after explicit user
// confirmation in the UI. Moves real (small) funds on Base mainnet.
// ---------------------------------------------------------------------------
app.post('/api/execute-trade', async (req, res) => {
    try {
        const { orderId } = req.body;
        const order = pendingOrders.get(orderId);
        if (!order) {
            return res.status(404).json({ error: 'Order not found or expired. Call /api/build-trade again.' });
        }

        const result = await executeOrder(order);
        pendingOrders.delete(orderId);
        res.json(result);
    } catch (err) {
        console.error('execute-trade error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/safety-check (standalone, kept for flexibility)
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
// GET /api/health
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