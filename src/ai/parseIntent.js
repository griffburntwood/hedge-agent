import OpenAI from 'openai';

const gonka = new OpenAI({
    baseURL: process.env.GONKA_BASE_URL,
    apiKey: process.env.GONKA_API_KEY,
});

// DeepSeek's reasoning models sometimes emit their internal chain-of-thought
// wrapped in <think>...</think> before the real answer. Strip it out before
// using any response as JSON or as user-facing text.
function stripThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const SYSTEM_PROMPT = `You extract hedging intent from a user's message.
Respond with ONLY valid JSON, no other text, in this exact shape:

{
  "asset": "ETH" | "BTC" | null,
  "dropPercent": number | null,
  "expiryPreference": "short" | "medium" | "long" | null,
  "size": number | null
}

Rules:
- dropPercent: the downside percentage they want protection against (e.g. "20% drop" -> 20).
- expiryPreference: "short" for about 1 day/urgent, "medium" for about 2 days, and "long" for about 3 days or unspecified urgency.
- size: the amount of the asset they mention (e.g. "1.5 ETH" -> 1.5). null if not stated.
- If a field isn't mentioned, use null. Never guess a number that wasn't stated or implied.
- Do not include any explanation, markdown, thinking, or text outside the JSON object.`;

const EXPIRY_DAYS = { short: 1, medium: 2, long: 3 };

export async function parseIntent(userText) {
    const res = await gonka.chat.completions.create({
        model: process.env.GONKA_MODEL,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userText },
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

    const dropPercent = parsed.dropPercent ?? 20;
    const expiryPreference = parsed.expiryPreference ?? 'short';
    const expiryDays = EXPIRY_DAYS[expiryPreference] ?? EXPIRY_DAYS.short;
    const asset = parsed.asset ?? 'ETH';

    if (parsed.size == null) {
        throw new Error('Could not determine position size from the request — ask the user to state an amount (e.g. "1.5 ETH").');
    }

    return {
        asset,
        dropPercent,
        expiryDays,
        size: parsed.size,
    };
}

// Deterministic — NOT done by the LLM, kept inspectable.
// A strike BELOW spot is correct and expected here: protecting against an
// X% drop means the insurance should only pay out once the price has
// actually fallen that far, not at the current price.
export function computeStrike(spotPrice, dropPercent) {
    return spotPrice * (1 - dropPercent / 100);
}

export async function explainTrade({ asset, size, strike, expiryDays, premium }) {
    const prompt = `Explain this hedge trade to a non-expert user in 2-3 plain sentences.
Asset: ${asset}, Size: ${size}, Strike: $${strike.toFixed(2)}, Expiry: ${expiryDays} days, Premium cost: $${premium}.
Mention what happens if the price stays above the strike (they lose only the premium, like insurance) and that the option gains value if the price drops below the strike.
Important: this hackathon transaction is a deliberately small proof-of-execution fill. Do not say it fully protects the stated position or pays back the user's entire loss; actual protection depends on the number of contracts purchased.
Respond with ONLY the explanation text — no reasoning, no <think> tags, no preamble.`;

    const res = await gonka.chat.completions.create({
        model: process.env.GONKA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
    });

    return stripThinking(res.choices[0].message.content);
}
