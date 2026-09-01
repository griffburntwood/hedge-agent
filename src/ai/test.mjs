import 'dotenv/config';
import { parseIntent, computeStrike, explainTrade } from './parseIntent.js';

const testInputs = [
    'protect my ETH from a 20% drop, I have 1.5 ETH',
    'hedge 0.5 BTC for the next 2 weeks against a 15% crash',
    'I want downside protection on 2 ETH',
];

for (const input of testInputs) {
    console.log('\n--- Input:', input);
    const intent = await parseIntent(input);
    console.log('Parsed intent:', intent);

    const mockSpotPrice = 2900; // replace with a real Thetanuts market data call later
    const strike = computeStrike(mockSpotPrice, intent.dropPercent);
    console.log('Computed strike:', strike.toFixed(2));

    const explanation = await explainTrade({
        asset: intent.asset,
        size: intent.size,
        strike,
        expiryDays: intent.expiryDays,
        premium: 12.5, // mock — replace with a real quote later
    });
    console.log('Explanation:', explanation);
}