import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

// --- Confirmed from a real fetchOrders() call — see conversation log -------
// Base mainnet WETH, used as underlyingToken for ETH options.
const UNDERLYING_TOKENS = {
    ETH: '0x4200000000000000000000000000000000000006',
    // TODO: BTC's underlyingToken address hasn't been confirmed yet from a
    // real order — filter fetchOrders() for a BTC/cbBTC order and read its
    // underlyingToken field, then fill this in. Leaving BTC unsupported
    // until then rather than guessing.
};

// The short-dated ETH PUT inventory settles in native USDC on Base. Keeping
// the demo path on this token avoids requiring a separate Aave deposit before
// a new user can buy protection.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EXPIRY_TOLERANCE_SEC = 12 * 60 * 60;
// Market-maker signatures are much shorter-lived than the option itself.
// Leave enough time for the API response and the user's confirmation click.
const MIN_ORDER_VALIDITY_SEC = 30;
const PUBLIC_BASE_RPC_URL = 'https://mainnet.base.org';

// Deliberately small, fixed fill size — matches the builder doc's explicit
// guidance ("trade small... a 1 USDC fill scores exactly the same as a 100
// USDC fill"). We do NOT try to map the user's stated ETH size to a real
// notional; that's a demo-safety choice, not a limitation to fix later.
const DEMO_FILL_AMOUNT_USDC = 1_000000n; // 1 USDC (6 decimals)

const readProvider = (rpcUrl = process.env.THETANUTS_RPC_URL) => {
    if (!rpcUrl) throw new Error('THETANUTS_RPC_URL is not set. Add a Base mainnet RPC URL to your .env file.');
    return new ethers.JsonRpcProvider(rpcUrl);
};

function readOnlyClient(rpcUrl) {
    return new ThetanutsClient({ chainId: 8453, provider: readProvider(rpcUrl) });
}

function isTemporaryNetworkError(error) {
    const code = error?.code || error?.cause?.code;
    const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'NETWORK_ERROR', 'SERVER_ERROR'].includes(code)
        || /socket|network|timeout|TLS connection|failed to fetch/i.test(message);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withReadRpcRetry(operation) {
    const rpcUrls = [...new Set([process.env.THETANUTS_RPC_URL, PUBLIC_BASE_RPC_URL].filter(Boolean))];
    let lastError;
    for (const rpcUrl of rpcUrls) {
        const attempts = rpcUrl === process.env.THETANUTS_RPC_URL ? 2 : 1;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await operation(readOnlyClient(rpcUrl));
            } catch (error) {
                lastError = error;
                if (!isTemporaryNetworkError(error)) throw error;
                if (attempt < attempts) await delay(400 * attempt);
            }
        }
    }
    throw new Error(
        `Base RPC is temporarily unavailable after retrying. Check your internet/RPC provider and try again. (${lastError?.cause?.code || lastError?.code || 'network error'})`,
        { cause: lastError }
    );
}

function signerClient() {
    if (!process.env.THETANUTS_PRIVATE_KEY) {
        throw new Error('THETANUTS_PRIVATE_KEY is not set — required to execute a real trade.');
    }
    const provider = readProvider();
    const signer = new ethers.Wallet(process.env.THETANUTS_PRIVATE_KEY, provider);
    return new ThetanutsClient({ chainId: 8453, provider, signer });
}

/**
 * Find a live native-USDC PUT order closest to the requested duration and
 * target strike. OptionBook expiries use fixed timestamps, so a nominal
 * "3 day" expiry can be slightly under 72 hours away; allow a 12-hour drift.
 *
 * Confirmed real order shape (from a live fetchOrders() call):
 *   order.order.strikePrice   -> string, 8-decimal fixed point (e.g. "232000000000" = $2320)
 *   order.order.expiry        -> string, unix seconds
 *   order.order.underlyingToken -> token address
 *   order.rawApiData.isCall   -> boolean (false = PUT)
 */
export async function findMatchingPutOrder({ asset, targetStrike, expiryDays }) {
    const underlyingToken = UNDERLYING_TOKENS[asset];
    if (!underlyingToken) {
        throw new Error(`Unsupported asset "${asset}" — no known underlyingToken address yet.`);
    }

    const client = readOnlyClient();
    const orders = await client.api.fetchOrders();

    const nowSec = Math.floor(Date.now() / 1000);
    const targetExpirySec = nowSec + expiryDays * 24 * 60 * 60;

    const candidates = orders.filter((o) => {
        const isPut = o.rawApiData?.isCall === false;
        const matchesAsset = o.order?.underlyingToken?.toLowerCase() === underlyingToken.toLowerCase();
        const expirySec = Number(o.order?.expiry ?? 0);
        const expiryOk = expirySec > nowSec && Math.abs(expirySec - targetExpirySec) <= EXPIRY_TOLERANCE_SEC;
        const orderValidUntil = Number(o.rawApiData?.orderExpiryTimestamp ?? 0);
        const signatureHasTime = orderValidUntil > nowSec + MIN_ORDER_VALIDITY_SEC;
        const usesNativeUsdc = o.order?.collateralToken?.toLowerCase() === BASE_USDC.toLowerCase();
        const hasLiquidity = BigInt(o.availableAmount ?? '0') > 0n;
        return isPut && matchesAsset && expiryOk && signatureHasTime && usesNativeUsdc && hasLiquidity;
    });

    if (candidates.length === 0) {
        throw new Error(
            `No live native-USDC PUT orders found near the ${expiryDays}-day duration. Live inventory changes; try another duration.`
        );
    }

    // Prefer the closest expiry first, then the closest strike within it.
    // strikePrice is 8-decimal fixed point — divide by 1e8 to get a USD number.
    const targetStrike8dp = targetStrike * 1e8;
    candidates.sort((a, b) => {
        const expiryDiffA = Math.abs(Number(a.order.expiry) - targetExpirySec);
        const expiryDiffB = Math.abs(Number(b.order.expiry) - targetExpirySec);
        if (expiryDiffA !== expiryDiffB) return expiryDiffA - expiryDiffB;
        const diffA = Math.abs(Number(a.order.strikePrice) - targetStrike8dp);
        const diffB = Math.abs(Number(b.order.strikePrice) - targetStrike8dp);
        return diffA - diffB;
    });

    return candidates[0];
}

/**
 * Dry-run preview — no signer, no gas, no funds moved.
 * Always call this before previewOrExecute('execute', ...).
 */
export async function previewOrder(order) {
    return withReadRpcRetry(async (client) => {
        const preview = await client.optionBook.previewFillOrder(order, DEMO_FILL_AMOUNT_USDC);
        const totalCollateralRaw = preview.totalCollateral?.toString?.() ?? preview.totalCollateral;
        const [collateralSymbol, collateralDecimals] = await Promise.all([
            client.erc20.getSymbol(preview.collateralToken),
            client.erc20.getDecimals(preview.collateralToken),
        ]);
        return {
            numContracts: preview.numContracts?.toString?.() ?? preview.numContracts,
            totalCollateral: totalCollateralRaw,
            // USDC has 6 decimals — convert the raw integer to a human dollar amount
            // for anything shown to the user (explanations, UI). Keep the raw value
            // above for anything that talks to the chain.
            totalCollateralUsd: Number(totalCollateralRaw) / 1e6,
            totalCollateralFormatted: ethers.formatUnits(totalCollateralRaw, collateralDecimals),
            collateralToken: preview.collateralToken,
            collateralSymbol,
            // Some SDK/provider versions return ERC-20 decimals as a bigint.
            // Express' JSON serializer cannot encode bigint values, so normalize
            // this display-only metadata before returning the preview to the UI.
            collateralDecimals: Number(collateralDecimals),
            expiryTimestamp: Number(order.order.expiry),
            expiryIso: new Date(Number(order.order.expiry) * 1000).toISOString(),
            optionBookAddress: order.rawApiData?.optionBookAddress,
            fillAmountUsdc: DEMO_FILL_AMOUNT_USDC.toString(),
        };
    });
}

/**
 * Real, signed execution. Only call this after the user has explicitly
 * confirmed — this moves real (small) funds on Base mainnet.
 */
export async function executeOrder(order) {
    const client = signerClient();

    // Check the short-lived marketplace signature before allowance or any
    // other write. The SDK also validates this at fill time, but doing it here
    // prevents paying approval gas for a quote that has already expired.
    const orderValidUntil = Number(order.rawApiData?.orderExpiryTimestamp ?? 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (orderValidUntil <= nowSec + 10) {
        throw new Error('The live marketplace quote expired before confirmation. Generate a fresh quote and confirm it promptly.');
    }

    const preview = await client.optionBook.previewFillOrder(order, DEMO_FILL_AMOUNT_USDC);
    const [collateralBalance, collateralSymbol, collateralDecimals] = await Promise.all([
        client.erc20.getBalance(preview.collateralToken),
        client.erc20.getSymbol(preview.collateralToken),
        client.erc20.getDecimals(preview.collateralToken),
    ]);

    if (collateralBalance < preview.totalCollateral) {
        const required = ethers.formatUnits(preview.totalCollateral, collateralDecimals);
        const available = ethers.formatUnits(collateralBalance, collateralDecimals);
        throw new Error(
            `Insufficient ${collateralSymbol} balance: this trade requires ${required}, but the wallet has ${available}.`
        );
    }

    // Approve exact amount only — never MaxUint256, per the builder doc's
    // trading safety rules.
    await client.erc20.ensureAllowance(
        preview.collateralToken,
        client.chainConfig.contracts.optionBook,
        preview.totalCollateral
    );

    const receipt = await client.optionBook.fillOrder(order, DEMO_FILL_AMOUNT_USDC);
    return {
        txHash: receipt.hash,
        basescanUrl: `https://basescan.org/tx/${receipt.hash}`,
    };
}

export async function getSpotPrice(asset) {
    const client = readOnlyClient();
    const market = await client.api.getMarketData();
    const price = market?.prices?.[asset];
    if (price == null) throw new Error(`No spot price found for asset "${asset}" in market data.`);
    return price;
}
