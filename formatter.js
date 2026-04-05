function shortAddr(addr) {
  if (!addr || addr === "Unknown") return "Unknown";
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function formatNum(n) {
  if (!n && n !== 0) return "?";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function getBuyTier(sol) {
  if (sol === null || sol === undefined) return { emoji: "🐟", label: "Buy",         bar: "🟩" };
  if (sol < 0.5)  return { emoji: "🐟", label: "Minnow Buy",  bar: "🟩" };
  if (sol < 2)    return { emoji: "🐬", label: "Dolphin Buy", bar: "🟩🟩🟩" };
  if (sol < 5)    return { emoji: "🦈", label: "Shark Buy",   bar: "🟨🟨🟨🟨🟨" };
  if (sol < 10)   return { emoji: "🦈", label: "Shark Buy",   bar: "🟧🟧🟧🟧🟧🟧" };
  if (sol < 50)   return { emoji: "🐳", label: "Whale Buy",   bar: "🟥🟥🟥🟥🟥🟥🟥" };
  return           { emoji: "🐳🐳", label: "MEGA WHALE",      bar: "🚨🚨🚨🚨🚨🚨🚨🚨" };
}

function walletLabel(profile) {
  if (!profile) return null;
  const parts = [];
  if (profile.solBalance !== undefined) parts.push(`💎 ${profile.solBalance.toFixed(2)} SOL`);
  if (profile.age) parts.push(`🕐 ${profile.age}`);
  if (profile.isNewWallet) parts.push(`🆕 New wallet`);
  if (profile.totalTransactions) parts.push(`📝 ${String(profile.totalTransactions)} txns`);
  return parts.length ? parts.join(" | ") : null;
}

function formatWelcome(groupName) {
  return (
    `👋 <b>APEX Buy Bot has joined ${groupName}!</b>\n\n` +
    `🔺 Real-time Solana buy alerts — whale detection, wallet profiling, milestones & more.\n\n` +
    `<b>To get started, a group admin must type:</b>\n` +
    `<code>/register YOUR_TOKEN_MINT_ADDRESS</code>\n\n` +
    `Need help? Type /help`
  );
}

function formatBuyAlert(buy, group, wallet, solPrice, settings, isWhale, isNewHolder) {
  const { buyer, tokenMint, tokenAmount, solSpent, signature, timestamp } = buy;
  const tokenName = group?.tokenName || buy.tokenName;
  const tokenSymbol = group?.tokenSymbol || buy.tokenSymbol;

  const tier = getBuyTier(solSpent);
  const emoji = settings?.buyEmoji || tier.emoji;
  const usdValue = solSpent && solPrice ? `~$${(solSpent * solPrice).toFixed(2)}` : null;
  const solLine = solSpent !== null
    ? `${solSpent.toFixed(4)} SOL${usdValue ? ` (${usdValue})` : ""}`
    : "Token swap";

  const walletUrl = `https://solscan.io/account/${buyer}`;
  const txUrl = `https://solscan.io/tx/${signature}`;
  const dexUrl = `https://dexscreener.com/solana/${tokenMint}`;

  const totalBuys = group?.totalBuys || 1;
  const totalVol = (group?.totalVolumeSol || 0).toFixed(2);
  const uniqueCount = (group?.uniqueBuyers || []).length || 1;
  const walletInfo = walletLabel(wallet);
  const timeStr = timestamp.toUTCString().replace(" GMT", " UTC");

  const header = isWhale
    ? `🚨 <b>WHALE ALERT</b> 🚨\n${tier.bar}`
    : `${emoji} <b>${tier.label.toUpperCase()}</b> ${emoji}\n${tier.bar}`;

  const newHolderLine = isNewHolder ? `\n🆕 <b>New Holder!</b>` : "";

  return [
    header,
    "",
    `🪙 <b><a href="${dexUrl}">${tokenName} (${tokenSymbol})</a></b>`,
    `💰 <b>Spent:</b> ${solLine}`,
    `🎯 <b>Got:</b> ${formatNum(tokenAmount)} ${tokenSymbol}`,
    "",
    `👤 <b>Buyer:</b> <a href="${walletUrl}">${shortAddr(buyer)}</a>${newHolderLine}`,
    walletInfo ? `📊 <b>Wallet:</b> ${walletInfo}` : null,
    "",
    `📦 <b>Total Buys:</b> ${totalBuys} | <b>Holders:</b> ${uniqueCount}`,
    `💧 <b>Volume:</b> ${totalVol} SOL`,
    "",
    `🔗 <a href="${txUrl}">View Tx</a> • <a href="${dexUrl}">Chart</a>`,
    `⏱ ${timeStr}`,
    "",
    `<i>🔺 Powered by APEX</i>`,
  ].filter((l) => l !== null).join("\n");
}

function formatMilestoneAlert(group, milestone, solPrice) {
  const usdVol = solPrice ? `$${((group.totalVolumeSol || 0) * solPrice).toFixed(0)}` : null;
  return [
    `🏆 <b>MILESTONE UNLOCKED!</b> 🏆`,
    "",
    `🎉 <b>${group.tokenName} (${group.tokenSymbol})</b> just hit <b>${milestone} buys!</b>`,
    "",
    `📦 Total Buys: <b>${group.totalBuys}</b>`,
    `👥 Unique Holders: <b>${(group.uniqueBuyers || []).length}</b>`,
    `💧 Volume: <b>${(group.totalVolumeSol || 0).toFixed(2)} SOL${usdVol ? ` (${usdVol})` : ""}</b>`,
    `🐳 Biggest Buy: <b>${(group.biggestBuy || 0).toFixed(2)} SOL</b>`,
    "",
    `<i>🔺 APEX Buy Bot</i>`,
  ].join("\n");
}

module.exports = { formatBuyAlert, formatMilestoneAlert, formatWelcome };
