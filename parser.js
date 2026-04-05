function parseHeliusWebhook(event) {
  if (event.type !== "SWAP") return null;

  const swap = event?.events?.swap;
  if (!swap) return null;

  const { tokenInputs = [], tokenOutputs = [], nativeInput, nativeOutput } = swap;

  let solSpent = null;
  let tokenMint = null;
  let tokenAmount = 0;

  if (nativeInput && tokenOutputs.length) {
    solSpent = nativeInput.amount / 1e9;
    const out = tokenOutputs[0];
    tokenMint = out.mint;
    tokenAmount = safeAmount(out);
  } else if (tokenInputs.length && nativeOutput) {
    return null;
  } else if (tokenInputs.length && tokenOutputs.length) {
    const out = tokenOutputs[0];
    tokenMint = out.mint;
    tokenAmount = safeAmount(out);
    solSpent = null;
  } else {
    return null;
  }

  const buyer = event.feePayer || event.accountData?.[0]?.account || "Unknown";
  const signature = event.signature || "";
  const timestamp = event.timestamp ? new Date(event.timestamp * 1000) : new Date();
  const transfer = event.tokenTransfers?.find((t) => t.mint === tokenMint);

  return {
    buyer,
    tokenMint,
    tokenAmount,
    solSpent,
    signature,
    timestamp,
    tokenSymbol: transfer?.symbol || "???",
    tokenName: transfer?.tokenName || tokenMint?.slice(0, 6) + "...",
  };
}

function safeAmount(out) {
  try {
    const raw = out.rawTokenAmount;
    return raw.tokenAmount / Math.pow(10, raw.decimals);
  } catch {
    return 0;
  }
}

module.exports = { parseHeliusWebhook };
