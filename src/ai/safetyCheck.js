import OpenAI from 'openai';

const gonka = new OpenAI({
    baseURL: process.env.GONKA_BASE_URL,
    apiKey: process.env.GONKA_API_KEY,
});

// Hardcoded allow-list of known-good Thetanuts contract addresses on Base.
// TODO: replace with the real deployed addresses from Thetanuts docs
// (docs.thetanuts.finance) before the demo — these are placeholders.
const ALLOWED_CONTRACTS = new Set([
    '0x1bDff855d6811728acaDC00989e79143a2bdfDed', // placeholder — replace with real address
].map((a) => a.toLowerCase()));

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

// DeepSeek's reasoning models sometimes emit their internal chain-of-thought
// wrapped in <think>...</think> before the real answer. Strip it out before
// parsing JSON.
function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Deterministic checks — run in plain code, not by the LLM.
 * These are the checks that MUST be reliable, so they're not left to model judgment.
 */
function runDeterministicChecks(tx) {
    const findings = [];

    // 1. Contract address allow-list
    const target = (tx.to || '').toLowerCase();
    if (!ALLOWED_CONTRACTS.has(target)) {
        findings.push({
            check: 'contract_address',
            risk: 'high',
            reason: `Transaction target ${tx.to} is not in the known Thetanuts contract allow-list.`,
        });
    } else {
        findings.push({ check: 'contract_address', risk: 'low', reason: 'Target contract is allow-listed.' });
    }

    // 2. Approval scope — never unlimited
    if (tx.approvalAmount != null) {
        if (String(tx.approvalAmount) === MAX_UINT256) {
            findings.push({
                check: 'approval_scope',
                risk: 'high',
                reason: 'Approval is unlimited (MaxUint256) — should be scoped to the exact trade size.',
            });
        } else if (tx.tradeSize != null && Number(tx.approvalAmount) > Number(tx.tradeSize) * 1.05) {
            // more than 5% above trade size — loose but simple sanity margin
            findings.push({
                check: 'approval_scope',
                risk: 'medium',
                reason: `Approval amount (${tx.approvalAmount}) is larger than the trade size (${tx.tradeSize}).`,
            });
        } else {
            findings.push({ check: 'approval_scope', risk: 'low', reason: 'Approval is scoped to the trade size.' });
        }
    }

    return findings;
}

/**
 * AI-scored check — does the built transaction actually match what the user asked for?
 * This is the one check that genuinely benefits from Gonka's reasoning, since it's
 * comparing free-text intent against structured parameters, not a fixed rule.
 */
async function checkParameterMatch(userIntentText, builtParams) {
    const prompt = `A user made this hedging request:
"${userIntentText}"

The system built this transaction:
${JSON.stringify(builtParams, null, 2)}

Important context on how strike prices work for this kind of protection:
to protect against an X% price drop, the correct strike is X% BELOW the
current spot price (e.g. protecting against a 20% drop on a $2400 asset
means a strike around $1920). A strike below spot is EXPECTED and CORRECT
for downside protection — it is not a red flag. Only flag parameter_match
risk if the asset, size, or drop percentage genuinely don't match what the
user asked for — not because the strike is below spot.

Does the built transaction reasonably match what the user asked for?

Respond with ONLY valid JSON, no other text, no reasoning, no <think> tags:
{
  "risk": "low" | "medium" | "high",
  "reason": "one short sentence explaining why"
}`;

    const res = await gonka.chat.completions.create({
        model: process.env.GONKA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
    });

    const raw = stripThinking(res.choices[0].message.content);
    try {
        const parsed = JSON.parse(raw);
        return { check: 'parameter_match', risk: parsed.risk, reason: parsed.reason };
    } catch (err) {
        return {
            check: 'parameter_match',
            risk: 'medium',
            reason: 'Could not verify parameter match automatically — flagged for manual review.',
        };
    }
}

/**
 * Main entry point. Call this right before showing the wallet-sign prompt.
 *
 * @param {string} userIntentText - the original plain-language request
 * @param {object} builtParams - the structured params the trade was built from ({asset, size, strike, expiryDays})
 * @param {object} tx - the transaction object about to be sent ({ to, approvalAmount, tradeSize })
 * @returns {{ overallRisk: 'low'|'medium'|'high', findings: object[] }}
 */
export async function checkTransactionSafety(userIntentText, builtParams, tx) {
    const deterministicFindings = runDeterministicChecks(tx);
    const parameterFinding = await checkParameterMatch(userIntentText, builtParams);

    const findings = [...deterministicFindings, parameterFinding];

    const riskOrder = { low: 0, medium: 1, high: 2 };
    const overallRisk = findings.reduce(
        (worst, f) => (riskOrder[f.risk] > riskOrder[worst] ? f.risk : worst),
        'low'
    );

    return { overallRisk, findings };
}