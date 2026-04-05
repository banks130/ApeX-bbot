function parseHeliusWebhook(event) {
  try {
    const type = event.type;
    if (type !== "SWAP") return null;

    const buyer = event.feePayer || "Unknown";
    const signature = event.signature || "";
    const timestamp = event.timestamp ? new Date(event.timestamp * 1000) : new Date();

    // Try events.swap first
    const swap = event.events && event.events.swap ? event.events.swap : null;

    let solSpent = null;
    let tokenMint = null;
    let tokenAmount = 0;
    let tokenSymbol = "???";
    let tokenName = "???";

    if (swap) {
      const nativeInput = swap.nativeInput;
      const tokenOutputs = swap.tokenOutputs || [];
      const tokenInputs = swap.tokenInputs || [];

      if (nativeInput && tokenOutputs.length) {
        solSpent = nativeInput.amount / 1e9;
        const out = tokenOutputs[0];
        tokenMint = out.mint;
        tokenAmount = safeAmount(out);
      } else if (tokenInputs.length && tokenOutputs.length) {
        const out = tokenOutputs[0];
        tokenMint = out.mint;
        tokenAmount = safeAmount(out);
      } else {
        return null;
      }
    } else {
      // Fallback: use tokenTransfers
      const transfers = event.tokenTransfers || [];
      const nativeTransfers = event.nativeTransfers || [];

      // Find token received by buyer
      const tokenOut = transfers.find(function(t) {
        return t.toUserAccount === buyer;
      });

      if (!tokenOut) return null;

      tokenMint = tokenOut.mint;
      tokenAmount = tokenOut.tokenAmount || 0;
      tokenSymbol = tokenOut.symbol || "???";
      tokenName = tokenOut.tokenName || (tokenMint ? tokenMint.slice(0, 6) + "..." : "???");

      // Find SOL spent by buyer
      const solOut = nativeTransfers.find(function(t) {
        return t.fromUserAccount === buyer;
      });
      solSpent = solOut ? solOut.amount / 1e9 : null;
    }

    if (!tokenMint) return null;

    // Get symbol/name from tokenTransfers if not set
    if (tokenSymbol === "???" || tokenName === "???") {
      const transfers = event.tokenTransfers || [];
      const transfer = transfers.find(function(t) { return t.mint === tokenMint; });
      if (transfer) {
        tokenSymbol = transfer.symbol || tokenSymbol;
        tokenName = transfer.tokenName || tokenName;
      }
    }

    return {
      buyer,
      tokenMint,
      tokenAmount,
      solSpent,
      signature,
      timestamp,
      tokenSymbol,
      tokenName,
    };
  } catch (err) {
    console.error("Parser error:", err.message);
    return null;
  }
}

function safeAmount(out) {
  try {
    const raw = out.rawTokenAmount;
    if (raw) return raw.tokenAmount / Math.pow(10, raw.decimals);
    return out.tokenAmount || 0;
  } catch {
    return 0;
  }
}

module.exports = { parseHeliusWebhook };
