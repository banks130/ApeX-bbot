function formatBuyAlert(buy, group, solPrice, settings, isWhale, isNewHolder, marketCap) {
  const emoji = settings.buyEmoji || "🟢";
  const solAmt = buy.solSpent !== null ? buy.solSpent.toFixed(3) : "?";
  const usdAmt = buy.solSpent !== null ? (buy.solSpent * solPrice).toFixed(2) : "?";
  const tokenAmt = buy.tokenAmount ? Number(buy.tokenAmount.toFixed(0)).toLocaleString() : "?";
  const mcStr = marketCap ? "$" + Number(marketCap).toLocaleString() : "N/A";
  const position = group.uniqueBuyers && group.uniqueBuyers.length > 0
    ? ((1 / group.uniqueBuyers.length) * 100).toFixed(2) + "%"
    : "New";

  const barCount = isWhale ? 20 : Math.min(20, Math.max(1, Math.round((buy.solSpent || 0.1) * 10)));
  const bars = emoji.repeat(barCount);

  const buyerShort = buy.buyer ? buy.buyer.slice(0, 4) + "..." + buy.buyer.slice(-4) : "Unknown";
  const buyerLink = "<a href='https://solscan.io/account/" + buy.buyer + "'>Buyer</a>";
  const txnLink = "<a href='https://solscan.io/tx/" + buy.signature + "'>Txn</a>";
  const dexLink = "<a href='https://dexscreener.com/solana/" + buy.tokenMint + "'>DexS</a>";
  const tgInfo = group.settings && group.settings.groupLink
    ? "<a href='" + group.settings.groupLink + "'>Tg</a>"
    : "";

  return (
    "<b>" + group.tokenName + " [" + group.tokenSymbol + "] Buy!</b>\n\n" +
    bars + "\n\n" +
    (isWhale ? "🐳 <b>WHALE ALERT!</b>\n\n" : "") +
    "💰 | <b>" + solAmt + " SOL</b> ($" + usdAmt + ")\n" +
    "🪙 | Got: <b>" + tokenAmt + " " + group.tokenSymbol + "</b>\n" +
    "👤 | " + buyerLink + " | " + txnLink + "\n" +
    "📍 | Position: <b>" + (isNewHolder ? "New" : position) + "</b>\n" +
    "📊 | Market Cap: <b>" + mcStr + "</b>\n" +
    dexLink + (tgInfo ? " " + tgInfo : "")
  );
}

function formatMilestoneAlert(group, count, solPrice) {
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  return (
    "🎉 <b>" + group.tokenName + " [" + group.tokenSymbol + "] Milestone!</b>\n\n" +
    "🏆 <b>" + count + " Buys</b> reached!\n\n" +
    "👥 Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "💎 Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n\n" +
    "Keep buying! 🚀"
  );
}

function formatWelcome(chatTitle) {
  return (
    "<b>⚡ APEX Buy Bot</b>\n\n" +
    "Thanks for adding me to <b>" + chatTitle + "</b>!\n\n" +
    "To start getting buy alerts, use:\n" +
    "<code>/add YOUR_TOKEN_MINT_ADDRESS</code>\n\n" +
    "Type /help to see all commands."
  );
}

function formatListing(group, groupLink) {
  return (
    "🆕 <b>New Token Listed!</b>\n\n" +
    "Token: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n" +
    "CA: <code>" + group.mint + "</code>\n\n" +
    "🔗 <a href='" + groupLink + "'>Join Group</a>\n" +
    "📊 <a href='https://dexscreener.com/solana/" + group.mint + "'>DexScreener</a>\n" +
    "🐦 <a href='https://birdeye.so/token/" + group.mint + "'>Birdeye</a>\n\n" +
    "#apex #solana #newlisting"
  );
}

module.exports = { formatBuyAlert, formatMilestoneAlert, formatWelcome, formatListing };
