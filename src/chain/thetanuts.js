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

// Deliberately small, fixed fill size — matches the builder doc's explicit
// guidance ("trade small... a 1 USDC fill scores exactly the same as a 100
// USDC fill"). We do NOT try to map the user's stated ETH size to a real
// notional; that's a demo-safety choice, not a limitation to fix later.
const DEMO_FILL_AMOUNT_USDC = 1_000000n; // 1 USDC (6 decimals)

const readProvider = () => new ethers.JsonRpcProvider(process.env.THETANUTS_RPC_URL);

function readOnlyClient() {
    return new ThetanutsClient({ chainId: 8453, provider: readProvider() });
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
 * Find a live PUT order on the OptionBook closest to the target strike,
 * with an expiry at or after the user's requested window.
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
    const minExpirySec = nowSec + expiryDays * 24 * 60 * 60;

    const candidates = orders.filter((o) => {
        const isPut = o.rawApiData?.isCall === false;
        const matchesAsset = o.order?.underlyingToken?.toLowerCase() === underlyingToken.toLowerCase();
        const expirySec = Number(o.order?.expiry ?? 0);
        const expiryOk = expirySec >= minExpirySec;
        const hasLiquidity = BigInt(o.availableAmount ?? '0') > 0n;
        return isPut && matchesAsset && expiryOk && hasLiquidity;
    });

    if (candidates.length === 0) {
        throw new Error(
            `No live PUT orders found for ${asset} with expiry >= ${expiryDays} days out. Try a shorter expiry or check fetchOrders() manually.`
        );
    }

    // Pick the order whose strike is closest to our computed target strike.
    // strikePrice is 8-decimal fixed point — divide by 1e8 to get a USD number.
    const targetStrike8dp = targetStrike * 1e8;
    candidates.sort((a, b) => {
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
    const client = readOnlyClient();
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
        collateralDecimals,
        optionBookAddress: order.rawApiData?.optionBookAddress,
        fillAmountUsdc: DEMO_FILL_AMOUNT_USDC.toString(),
    };
}

/**
 * Real, signed execution. Only call this after the user has explicitly
 * confirmed — this moves real (small) funds on Base mainnet.
 */
export async function executeOrder(order) {
    const client = signerClient();

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
