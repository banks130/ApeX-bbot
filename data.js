const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

let _solPriceCache = { price: 150, fetchedAt: 0 };

async function getSolPrice() {
  if (Date.now() - _solPriceCache.fetchedAt < 60_000) return _solPriceCache.price;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();
    const price = data?.solana?.usd;
    if (price) { _solPriceCache = { price, fetchedAt: Date.now() }; return price; }
  } catch {}
  return _solPriceCache.price;
}

const _tokenCache = {};

async function getTokenInfo(mint) {
  if (_tokenCache[mint]) return _tokenCache[mint];

  // 1. Helius DAS
  try {
    const res = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "apex",
        method: "getAsset",
        params: { id: mint },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const asset = data?.result;
    if (asset?.content?.metadata?.name) {
      const info = {
        name: asset.content.metadata.name,
        symbol: asset.content.metadata.symbol || "???",
        decimals: asset.token_info?.decimals || 6,
        image: asset.content?.files?.[0]?.uri || null,
      };
      _tokenCache[mint] = info;
      return info;
    }
  } catch {}

  // 2. pump.fun API
  try {
    const res = await fetch(`https://pump.fun/api/token/${mint}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.name) {
        const info = {
          name: data.name,
          symbol: data.symbol || "???",
          decimals: 6,
          image: data.image_uri || null,
        };
        _tokenCache[mint] = info;
        return info;
      }
    }
  } catch {}

  // 3. DexScreener
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    const pair = data?.pairs?.[0];
    if (pair?.baseToken?.name) {
      const info = {
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol || "???",
        decimals: 6,
        image: null,
        priceUsd: pair.priceUsd || null,
        marketCap: pair.fdv || null,
      };
      _tokenCache[mint] = info;
      return info;
    }
  } catch {}

  return null;
}

const _walletCache = {};

async function getWalletProfile(wallet) {
  if (wallet === "Unknown") return null;
  if (_walletCache[wallet] && Date.now() - _walletCache[wallet].fetchedAt < 300_000) {
    return _walletCache[wallet];
  }

  const balRes = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "apex",
      method: "getBalance",
      params: [wallet],
    }),
    signal: AbortSignal.timeout(6000),
  });
  const balData = await balRes.json();
  const solBalance = (balData?.result?.value || 0) / 1e9;

  let totalTransactions = null;
  let accountCreatedAt = null;

  try {
    const sigRes = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "apex",
        method: "getSignaturesForAddress",
        params: [wallet, { limit: 1000 }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    const sigData = await sigRes.json();
    const sigs = sigData?.result || [];
    totalTransactions = sigs.length < 1000 ? sigs.length : "1000+";
    const oldest = sigs[sigs.length - 1];
    if (oldest?.blockTime) accountCreatedAt = oldest.blockTime * 1000;
  } catch {}

  const ageDays = accountCreatedAt
    ? Math.floor((Date.now() - accountCreatedAt) / 86_400_000)
    : null;

  const profile = {
    solBalance,
    totalTransactions,
    isNewWallet: ageDays !== null && ageDays < 7,
    age: ageDays !== null
      ? ageDays < 1 ? "< 1 day old"
        : ageDays === 1 ? "1 day old"
        : `${ageDays}d old`
      : null,
    fetchedAt: Date.now(),
  };

  _walletCache[wallet] = profile;
  return profile;
}

module.exports = { getSolPrice, getTokenInfo, getWalletProfile };
