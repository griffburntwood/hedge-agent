import 'dotenv/config';
import express from 'express';
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import { parseIntent, computeStrike, explainTrade } from './src/ai/parseIntent.js';
import { checkTransactionSafety } from './src/ai/safetyCheck.js';
import { findMatchingPutOrder, previewOrder, executeOrder, getSpotPrice } from './src/chain/thetanuts.js';
import { scoreEvent, maybeTriggerHedge, THREAT_THRESHOLD, TEST_HEADLINES } from './src/ai/guardianCheck.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
const executingOrders = new Set();

app.post('/api/build-trade', async (req, res) => {
    try {
        const { asset, dropPercent, expiryDays, size, userIntentText } = req.body;
        const numericDrop = Number(dropPercent);
        const numericExpiry = Number(expiryDays);
        const numericSize = Number(size);

        if (asset !== 'ETH') {
            return res.status(400).json({ error: 'Only ETH protection is supported in this demo.' });
        }
        if (!Number.isFinite(numericDrop) || numericDrop < 1 || numericDrop > 90) {
            return res.status(400).json({ error: 'Downside protection must be between 1% and 90%.' });
        }
        if (![1, 2, 3].includes(numericExpiry)) {
            return res.status(400).json({ error: 'Protection duration must be 1, 2, or 3 days.' });
        }
        if (!Number.isFinite(numericSize) || numericSize <= 0) {
            return res.status(400).json({ error: 'Position size must be greater than zero.' });
        }

        const spotPrice = await getSpotPrice(asset);
        const strike = computeStrike(spotPrice, numericDrop);

        const params = {
            asset,
            strike,
            dropPercent: numericDrop,
            expiryDays: numericExpiry,
            size: numericSize,
            spotPrice,
        };
        // Finish the slower AI work before requesting a marketplace order.
        // The demo always fills exactly 1 USDC through the configured
        // OptionBook, so these are the same safety inputs previewOrder will
        // return below. A market-maker signature often lasts only ~90 seconds.
        const [explanation, safety] = await Promise.all([
            explainTrade({
                asset,
                size: numericSize,
                strike,
                expiryDays: numericExpiry,
                premium: 1,
            }),
            checkTransactionSafety(
                userIntentText || '',
                params,
                {
                    // The transaction actually calls the OptionBook contract, not the
                    // order's maker address — that's what needs to be allow-listed.
                    to: client.chainConfig.contracts.optionBook,
                    approvalAmount: '1000000',
                    tradeSize: '1000000',
                }
            ),
        ]);

        // Fetch and preview the short-lived signed order last. This preserves
        // nearly its full validity window for the confirmation click.
        const matchedOrder = await findMatchingPutOrder({ asset, targetStrike: strike, expiryDays: numericExpiry });
        const preview = await previewOrder(matchedOrder);

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
    let orderId;
    try {
        ({ orderId } = req.body);
        const order = pendingOrders.get(orderId);
        if (!order) {
            return res.status(404).json({ error: 'Order not found or expired. Call /api/build-trade again.' });
        }
        if (executingOrders.has(orderId)) {
            return res.status(409).json({ error: 'This hedge is already being executed. Please wait.' });
        }

        // Block duplicate concurrent submissions, but retain the preview if an
        // RPC/order error occurs so the UI can show the error and safely retry.
        executingOrders.add(orderId);
        const result = await executeOrder(order);
        pendingOrders.delete(orderId);
        res.json(result);
    } catch (err) {
        console.error('execute-trade error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (orderId) executingOrders.delete(orderId);
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
// GET /api/guardian/headlines — the hardcoded demo headlines for the UI dropdown
// ---------------------------------------------------------------------------
app.get('/api/guardian/headlines', (req, res) => {
    res.json({ headlines: TEST_HEADLINES, threshold: THREAT_THRESHOLD });
});

// ---------------------------------------------------------------------------
// POST /api/guardian/score
// Body: { headline, asset, size, dropPercent, expiryDays, riskTolerance }
// Scores only — no trade fires. Safe to call freely.
// ---------------------------------------------------------------------------
app.post('/api/guardian/score', async (req, res) => {
    try {
        const { headline, ...profile } = req.body;
        if (!headline) return res.status(400).json({ error: 'Missing "headline".' });
        const result = await scoreEvent(headline, profile);
        res.json({ ...result, wouldTrigger: result.riskScore >= THREAT_THRESHOLD, threshold: THREAT_THRESHOLD });
    } catch (err) {
        console.error('guardian/score error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/guardian/trigger
// Body: { headline, asset, size, dropPercent, expiryDays, riskTolerance }
// REAL execution if the score crosses the threshold. Only call after
// explicit user confirmation in the UI — same safety principle as
// /api/execute-trade.
// ---------------------------------------------------------------------------
app.post('/api/guardian/trigger', async (req, res) => {
    try {
        const { headline, ...profile } = req.body;
        if (!headline) return res.status(400).json({ error: 'Missing "headline".' });
        const result = await maybeTriggerHedge(headline, profile);
        res.json(result);
    } catch (err) {
        console.error('guardian/trigger error:', err);
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
const HOST = '127.0.0.1';
app.listen(PORT, HOST, () => {
    console.log(`HedgePilot running at http://${HOST}:${PORT}`);
    console.log(`Health check: http://${HOST}:${PORT}/api/health`);
});
