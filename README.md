## Getting Started

1. Install dependencies:
   npm install

2. Copy the env template and fill in your own keys:
   cp .env.example .env

3. Get a free Base mainnet RPC key from alchemy.com (Base Mainnet) or infura.io.

4. Get your Gonka base URL, API key, and model name from the Gonka Router site.

5. Verify Thetanuts connectivity (no wallet needed):
   node check.mjs

6. Verify Gonka connectivity:
   node src/ai/test.mjs
