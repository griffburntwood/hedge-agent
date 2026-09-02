import 'dotenv/config';
import OpenAI from 'openai';
import { pathToFileURL } from 'url';

const gonka = new OpenAI({
    baseURL: process.env.GONKA_BASE_URL,
    apiKey: process.env.GONKA_API_KEY,
});

// Same helper as parseIntent.js — DeepSeek's reasoning model sometimes
// leaks its internal <think>...</think> block into the response.
function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const SYSTEM_PROMPT = `You are a risk-scoring assistant for a crypto hedging agent.
Given a market event/headline and a user's holdings + risk tolerance, decide
whether this event is a credible, high-impact enough threat to justify
automatically executing a protective hedge on the user's behalf.

Respond with ONLY valid JSON, no other text, in this exact shape:

{
  "riskScore": number,
  "reasoning": string
}

Rules:
- riskScore is 0-100. 0 means no real threat (rumor, irrelevant, low impact).
  100 means an urgent, credible, high-impact threat to the user's holdings.
- Consider: is the event about an asset the user actually holds? Is it
  the kind of event that plausibly moves price sharply (hack, depeg,
  regulatory action, major liquidation cascade) vs. routine news?
- reasoning should be 1-2 plain-English sentences explaining the score.
- Do not include any explanation, markdown, thinking, or text outside the JSON object.`;

// Deterministic — NOT decided by the LLM, kept inspectable/tunable.
export const THREAT_THRESHOLD = 70;

/**
 * Scores a single news headline/event against a user's holdings and risk
 * tolerance. Mirrors parseIntent()'s call + stripThinking + JSON.parse
 * pattern exactly.
 *
 * @param {string} headline - the news headline/event text
 * @param {object} userRiskProfile - e.g. { asset: 'ETH', size: 1.5, riskTolerance: 'medium' }
 * @returns {Promise<{riskScore: number, reasoning: string}>}
 */
export async function scoreEvent(headline, userRiskProfile) {
    const profileText = JSON.stringify(userRiskProfile);

    const res = await gonka.chat.completions.create({
        model: process.env.GONKA_MODEL,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: `Event: ${headline}\nUser holdings/risk profile: ${profileText}`,
            },
        ],
        temperature: 0,
    });

    const raw = stripThinking(res.choices[0].message.content);

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Gonka did not return valid JSON: ${raw}`);
    }

    if (typeof parsed.riskScore !== 'number') {
        throw new Error(`Gonka response missing a numeric riskScore: ${raw}`);
    }

    return {
        riskScore: parsed.riskScore,
        reasoning: parsed.reasoning ?? '',
    };
}

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

/**
 * Guardian mode entry point. Scores an event and, if it crosses the
 * threshold, calls the SAME /api/build-trade -> /api/execute-trade
 * pipeline manual mode uses (via plain HTTP, same as a browser would).
 * Builds no new execution logic — just a new trigger into the existing one.
 *
 * @param {string} headline
 * @param {object} userRiskProfile - e.g.
 *   { asset: 'ETH', size: 1.5, dropPercent: 20, expiryDays: 7, riskTolerance: 'medium' }
 *   (asset/size/dropPercent/expiryDays are needed to call /api/build-trade —
 *   riskTolerance is only used by Gonka for scoring.)
 * @returns {Promise<{
 *   shouldTrigger: boolean,
 *   riskScore: number,
 *   reasoning: string,
 *   trade: object | null,   // the /api/execute-trade result, if triggered
 *   error: string | null,   // set if build/execute failed
 * }>}
 */
export async function maybeTriggerHedge(headline, userRiskProfile) {
    const { riskScore, reasoning } = await scoreEvent(headline, userRiskProfile);

    const result = { shouldTrigger: riskScore >= THREAT_THRESHOLD, riskScore, reasoning, trade: null, error: null };
    if (!result.shouldTrigger) return result;

    try {
        const { asset, size, dropPercent, expiryDays } = userRiskProfile;

        const buildRes = await fetch(`${SERVER_BASE_URL}/api/build-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                asset,
                size,
                dropPercent: dropPercent ?? 20,
                expiryDays: expiryDays ?? 7,
                userIntentText: `[Guardian Mode auto-trigger] Event: "${headline}" — score ${riskScore}/100. ${reasoning}`,
            }),
        });
        const built = await buildRes.json();
        if (!buildRes.ok) throw new Error(built.error || 'build-trade failed');

        const execRes = await fetch(`${SERVER_BASE_URL}/api/execute-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: built.orderId }),
        });
        const executed = await execRes.json();
        if (!execRes.ok) throw new Error(executed.error || 'execute-trade failed');

        result.trade = { built, executed };
    } catch (err) {
        result.error = err.message;
    }

    return result;
}

// Hardcoded test headlines for the demo — no live news feed in v1.
export const TEST_HEADLINES = [
    'Major exchange halts withdrawals amid reports of insolvency',
    'Stablecoin depegs to $0.88 after protocol exploit drains reserves',
    'Popular DeFi token announces routine governance vote on fee structure',
    'Analyst tweets bullish price prediction for ETH',
];

// Simple manual test runner — run with: node src/ai/guardianCheck.js
// (only runs when this file is executed directly, not when imported)
//
// SAFETY: by default this only SCORES the headlines (scoreEvent), it does
// NOT call maybeTriggerHedge — because that would fire real trades on Base
// mainnet against your teammate's server if it's running. Once scoring
// looks sensible, test the real trigger deliberately and separately (e.g.
// call maybeTriggerHedge for just ONE headline, with the server running,
// and watch for the tx hash) — don't loop it over all test headlines.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const testProfile = { asset: 'ETH', size: 1.5, dropPercent: 20, expiryDays: 7, riskTolerance: 'medium' };

    for (const headline of TEST_HEADLINES) {
        const { riskScore, reasoning } = await scoreEvent(headline, testProfile);
        const wouldTrigger = riskScore >= THREAT_THRESHOLD;
        console.log(`\n"${headline}"`);
        console.log(`  score: ${riskScore}  would trigger: ${wouldTrigger}`);
        console.log(`  reasoning: ${reasoning}`);
    }
}
