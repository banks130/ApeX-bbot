require("dotenv").config();
const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { parseHeliusWebhook } = require("./parser");
const { formatBuyAlert, formatMilestoneAlert, formatWelcome, formatListing } = require("./formatter");
const { getSolPrice, getTokenInfo, getMarketCap } = require("./data");
const { addMintToHelius, removeMintFromHelius } = require("./helius");
const store = require("./store");

const app = express();
app.use(express.json());

const bot = new Bot(process.env.BOT_TOKEN);
const SUPER_ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((id) => id.trim());
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || "";
const MILESTONE_COUNTS = [10, 25, 50, 100, 250, 500, 1000];
const DIRECTORY_CHANNEL = process.env.DIRECTORY_CHANNEL || "@apextrendingchannell";

const SCAM_KEYWORDS = [
  "gempump", "wtf trending", "cherry trending",
  "all holders", "holders dm", "dm all", "dm holders",
  "pump trending", "fast trending", "rank now",
  "boosting service", "volume service"
];

function isSuperAdmin(ctx) {
  return SUPER_ADMIN_IDS.includes(String(ctx.from?.id));
}

async function isGroupAdmin(ctx) {
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

async function isGroupAdminById(chatId, userId) {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

function isGroup(ctx) {
  return ["group", "supergroup"].includes(ctx.chat?.type);
}

function hasLink(text) {
  return /https?:\/\/|t\.me\/|@\w+/i.test(text);
}

function hasScamKeyword(text) {
  const lower = text.toLowerCase();
  return SCAM_KEYWORDS.some((kw) => lower.includes(kw));
}

function buildMainMenu() {
  return new InlineKeyboard()
    .text("➕ Add Token", "menu_add")
    .text("⚙️ Settings", "menu_settings")
    .row()
    .text("📊 Price", "menu_price")
    .text("📈 Chart", "menu_chart")
    .row()
    .text("🌊 Market", "menu_market")
    .text("🏆 Top Buyers", "menu_top")
    .row()
    .text("🛡️ Mod Mode", "menu_mod")
    .text("🚀 Boost", "menu_boost")
    .row()
    .text("❓ Help", "menu_help");
}

function buildSettingsKeyboard(group) {
  const s = group.settings || {};
  const minBuy = s.minBuySol ?? 0.05;
  const whale = s.whaleSol ?? 10;
  const active = group.active;
  const modMode = s.modMode || false;

  return new InlineKeyboard()
    .text("Min Buy: " + minBuy + " SOL", "set_minbuy")
    .text("Whale: " + whale + " SOL", "set_whale")
    .row()
    .text("Set Emoji", "set_emoji")
    .text("🖼 Buy Image", "set_banner")
    .row()
    .text((modMode ? "🛡️ Mod: ON" : "⚪ Mod: OFF"), "toggle_mod")
    .text("📊 Stats", "show_stats")
    .row()
    .text(active ? "⏸ Pause" : "▶️ Resume", "toggle_active")
    .text("❌ Remove Token", "confirm_unregister");
}

function buildSettingsText(group) {
  const s = group.settings || {};
  return (
    "<b>⚙️ APEX Buy Bot Settings</b>\n\n" +
    "Token: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n" +
    "CA: <code>" + group.mint + "</code>\n\n" +
    "Min Buy: <b>" + (s.minBuySol ?? 0.05) + " SOL</b>\n" +
    "Whale Alert: <b>" + (s.whaleSol ?? 10) + " SOL</b>\n" +
    "Emoji: <b>" + (s.buyEmoji ?? "🟢") + "</b>\n" +
    "Alerts: <b>" + (group.active ? "🟢 Active" : "🔴 Paused") + "</b>\n" +
    "Mod Mode: <b>" + (s.modMode ? "🛡️ ON" : "⚪ OFF") + "</b>\n\n" +
    "<i>Tap a button to change settings</i>"
  );
}

// ─── MODERATION ───
bot.on("message", async (ctx, next) => {
  if (!isGroup(ctx)) return next();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.settings || !group.settings.modMode) return next();

  const userId = ctx.from?.id;
  if (!userId) return next();

  const isAdmin = await isGroupAdminById(chatId, userId);
  if (isAdmin) return next();

  const msg = ctx.message;
  let shouldBan = false;
  let reason = "";

  // No forwarding
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) {
    shouldBan = true;
    reason = "forwarding messages";
  }

  // No links
  if (!shouldBan && msg.text && hasLink(msg.text)) {
    shouldBan = true;
    reason = "sending links";
  }

  // Scam keywords
  if (!shouldBan && msg.text && hasScamKeyword(msg.text)) {
    shouldBan = true;
    reason = "scam promotion";
  }

  // Anti-spam: check last message time
  if (!shouldBan && msg.text) {
    const spamKey = chatId + "_" + userId;
    const lastTime = store.getSpamTime(spamKey);
    const now = Date.now();
    if (lastTime && now - lastTime < 1500) {
      shouldBan = true;
      reason = "spamming";
    }
    store.setSpamTime(spamKey, now);
  }

  if (shouldBan) {
    try {
      await ctx.deleteMessage();
      await bot.api.banChatMember(chatId, userId);
      await bot.api.sendMessage(chatId,
        "🚫 <b>User banned</b> for " + reason + ".\n\n" +
        "<i>This group is protected by APEX Buy Bot</i>",
        { parse_mode: "HTML" }
      );
    } catch (e) {
      console.error("Ban error:", e.message);
    }
    return;
  }

  return next();
});

// ─── WELCOME NEW MEMBERS ───
bot.on("chat_member", async (ctx) => {
  const newMember = ctx.chatMember?.new_chat_member;
  if (!newMember || newMember.status !== "member") return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const user = newMember.user;
  const name = user.first_name + (user.last_name ? " " + user.last_name : "");
  await bot.api.sendMessage(chatId,
    "👋 Welcome <b>" + name + "</b>!\n\n" +
    (group.mint
      ? "We are tracking <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b> 🚀\n\nUse /price for latest info!"
      : "Use /start to get started!"),
    { parse_mode: "HTML" }
  );
});

bot.on("my_chat_member", async (ctx) => {
  const newStatus = ctx.myChatMember?.new_chat_member?.status;
  const chatId = String(ctx.chat.id);
  const chatTitle = ctx.chat.title || "your group";
  if (newStatus === "administrator" || newStatus === "member") {
    if (!["group", "supergroup"].includes(ctx.chat.type)) return;
    store.addGroup(chatId, { title: chatTitle, addedAt: Date.now(), mint: null, active: false });
    await bot.api.sendMessage(chatId, formatWelcome(chatTitle), { parse_mode: "HTML" });
  }
  if (newStatus === "kicked" || newStatus === "left") {
    store.removeGroup(chatId);
  }
});

// ─── COMMANDS ───
bot.command("start", async (ctx) => {
  if (isGroup(ctx)) {
    const chatId = String(ctx.chat.id);
    const group = store.getGroup(chatId);
    return ctx.reply(
      "<b>⚡ APEX Buy Bot</b>\n\n" +
      (group && group.mint ? "Tracking: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" : "") +
      "Use the menu below:",
      { parse_mode: "HTML", reply_markup: buildMainMenu() }
    );
  }
  ctx.reply(
    "<b>⚡ APEX Buy Bot</b>\n\nAdd me to your group as admin to get started!",
    { parse_mode: "HTML" }
  );
});

bot.command("add", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const mint = ctx.message.text.split(" ")[1]?.trim();
  if (!mint || mint.length < 32) {
    return ctx.reply("Send your token CA:\n\n<code>/add YOUR_MINT</code>", { parse_mode: "HTML" });
  }
  const chatId = String(ctx.chat.id);
  const existing = store.getGroup(chatId);
  if (existing && existing.mint === mint) return ctx.reply("Already tracking this token.");
  await ctx.reply("🔍 Validating token...");
  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = info?.name || mint.slice(0, 6);
  const tokenSymbol = info?.symbol || "???";
  const heliusOk = await addMintToHelius(mint);
  if (!heliusOk) return ctx.reply("❌ Failed to register with Helius.");
  store.updateGroup(chatId, {
    mint, tokenName, tokenSymbol, active: true,
    registeredAt: Date.now(), totalBuys: 0, totalVolumeSol: 0,
    biggestBuy: 0, uniqueBuyers: [], milestones: 0,
    settings: { minBuySol: 0.05, whaleSol: 10, buyEmoji: "🟢", bannerUrl: "", modMode: false },
  });
  store.addMintGroup(mint, chatId);
  await ctx.reply(
    "✅ Token added!\n\nToken: <b>" + tokenName + " [" + tokenSymbol + "]</b>\n" +
    "CA: <code>" + mint + "</code>\n\nBuy alerts are LIVE! 🚀\n\n" +
    "Send your group invite link to list in <a href='https://t.me/apextrendingchannell'>APEX Trending</a>:",
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
  store.updateGroupSetting(chatId, "awaitingInput", "groupLink");
});

bot.command("remove", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token registered.");
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  if (store.getGroupsForMint(mint).length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.reply("✅ Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
});

bot.command("settings", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added. Use /add first.");
  ctx.reply(buildSettingsText(group), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(group) });
});

bot.command("price", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added.");
  const solPrice = await getSolPrice();
  const mc = await getMarketCap(group.mint).catch(() => null);
  ctx.reply(
    "<b>💰 " + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" +
    "SOL Price: <b>$" + solPrice.toFixed(2) + "</b>\n" +
    (mc ? "Market Cap: <b>$" + Number(mc).toLocaleString() + "</b>\n" : "") +
    "\n<a href='https://dexscreener.com/solana/" + group.mint + "'>📊 View Chart</a>",
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("chart", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added.");
  ctx.reply(
    "<b>📈 " + group.tokenName + " Chart</b>\n\n" +
    "🔗 <a href='https://dexscreener.com/solana/" + group.mint + "'>DexScreener</a>\n" +
    "🔗 <a href='https://birdeye.so/token/" + group.mint + "'>Birdeye</a>\n" +
    "🔗 <a href='https://pump.fun/coin/" + group.mint + "'>Pump.fun</a>",
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("market", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added.");
  const solPrice = await getSolPrice();
  const mc = await getMarketCap(group.mint).catch(() => null);
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>🌊 " + group.tokenName + " Market</b>\n\n" +
    (mc ? "Market Cap: <b>$" + Number(mc).toLocaleString() + "</b>\n" : "") +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("stats", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added.");
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>📊 " + group.tokenName + " Stats</b>\n\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>\n" +
    "Milestones: <b>" + (group.milestones || 0) + "</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("top", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added.");
  const leaderboard = store.getLeaderboard(chatId);
  if (!leaderboard || !leaderboard.length) return ctx.reply("No buys recorded yet.");
  const medals = ["🥇", "🥈", "🥉"];
  const lines = leaderboard.slice(0, 10).map(function(entry, i) {
    const medal = medals[i] || (i + 1) + ".";
    const addr = entry.buyer.slice(0, 4) + "..." + entry.buyer.slice(-4);
    return medal + " <a href='https://solscan.io/account/" + entry.buyer + "'>" + addr + "</a> — <b>" + entry.totalSol.toFixed(2) + " SOL</b>";
  });
  ctx.reply(
    "<b>🏆 Top Buyers — " + group.tokenName + "</b>\n\n" + lines.join("\n"),
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("boost", async (ctx) => {
  ctx.reply(
    "<b>🚀 Boost Your Token!</b>\n\n" +
    "Want more volume and ranking?\n\n" +
    "Contact <b>@boostslegends_bot</b> for:\n" +
    "• Volume boosting\n" +
    "• DEX ranking\n" +
    "• Trending support\n" +
    "• Momentum building\n\n" +
    "<i>Support the momentum — keep buying! 💪</i>",
    { parse_mode: "HTML" }
  );
});

bot.command("mod", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const current = group.settings?.modMode || false;
  store.updateGroupSetting(chatId, "modMode", !current);
  ctx.reply(
    !current
      ? "🛡️ <b>Mod Mode ON</b>\n\nInstant ban for:\n• Forwarding\n• Links\n• Spam\n• Scam keywords"
      : "⚪ <b>Mod Mode OFF</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "<b>❓ APEX Buy Bot Commands</b>\n\n" +
    "/add CA — Add your token\n" +
    "/remove — Remove token\n" +
    "/settings — Configure bot\n" +
    "/price — Token price\n" +
    "/chart — View charts\n" +
    "/market — Market details\n" +
    "/stats — Buy statistics\n" +
    "/top — Top buyers\n" +
    "/boost — Boost your token\n" +
    "/mod — Toggle mod mode\n" +
    "/pause — Pause alerts\n" +
    "/resume — Resume alerts",
    { parse_mode: "HTML" }
  );
});

bot.command("pause", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  store.updateGroup(String(ctx.chat.id), { active: false });
  ctx.reply("⏸ Buy alerts paused.");
});

bot.command("resume", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  store.updateGroup(String(ctx.chat.id), { active: true });
  ctx.reply("▶️ Buy alerts resumed.");
});

bot.command("groups", (ctx) => {
  if (!isSuperAdmin(ctx)) return;
  const groups = store.getAllGroups();
  const keys = Object.keys(groups);
  if (!keys.length) return ctx.reply("No groups.");
  const lines = keys.map(function(id, i) {
    const g = groups[id];
    return (i + 1) + ". <b>" + g.title + "</b> — " + (g.tokenName || "No token") + " — Buys: " + (g.totalBuys || 0);
  });
  ctx.reply("<b>Groups (" + keys.length + ")</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
});

// ─── MENU CALLBACKS ───
bot.callbackQuery("menu_add", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.reply("Send:\n\n<code>/add YOUR_MINT_ADDRESS</code>", { parse_mode: "HTML" });
});

bot.callbackQuery("menu_settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added yet.");
  ctx.reply(buildSettingsText(group), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(group) });
});

bot.callbackQuery("menu_price", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added yet.");
  const solPrice = await getSolPrice();
  const mc = await getMarketCap(group.mint).catch(() => null);
  ctx.reply(
    "<b>💰 " + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" +
    "SOL Price: <b>$" + solPrice.toFixed(2) + "</b>\n" +
    (mc ? "Market Cap: <b>$" + Number(mc).toLocaleString() + "</b>\n" : "") +
    "\n<a href='https://dexscreener.com/solana/" + group.mint + "'>📊 View Chart</a>",
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.callbackQuery("menu_chart", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added yet.");
  ctx.reply(
    "<b>📈 " + group.tokenName + " Chart</b>\n\n" +
    "🔗 <a href='https://dexscreener.com/solana/" + group.mint + "'>DexScreener</a>\n" +
    "🔗 <a href='https://birdeye.so/token/" + group.mint + "'>Birdeye</a>\n" +
    "🔗 <a href='https://pump.fun/coin/" + group.mint + "'>Pump.fun</a>",
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.callbackQuery("menu_market", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added yet.");
  const solPrice = await getSolPrice();
  const mc = await getMarketCap(group.mint).catch(() => null);
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>🌊 " + group.tokenName + " Market</b>\n\n" +
    (mc ? "Market Cap: <b>$" + Number(mc).toLocaleString() + "</b>\n" : "") +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("menu_top", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added yet.");
  const leaderboard = store.getLeaderboard(chatId);
  if (!leaderboard || !leaderboard.length) return ctx.reply("No buys recorded yet.");
  const medals = ["🥇", "🥈", "🥉"];
  const lines = leaderboard.slice(0, 10).map(function(entry, i) {
    const medal = medals[i] || (i + 1) + ".";
    const addr = entry.buyer.slice(0, 4) + "..." + entry.buyer.slice(-4);
    return medal + " <a href='https://solscan.io/account/" + entry.buyer + "'>" + addr + "</a> — <b>" + entry.totalSol.toFixed(2) + " SOL</b>";
  });
  ctx.reply(
    "<b>🏆 Top Buyers — " + group.tokenName + "</b>\n\n" + lines.join("\n"),
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.callbackQuery("menu_mod", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return ctx.answerCallbackQuery("Admins only.");
  const group = store.getGroup(chatId);
  if (!group) return;
  const current = group.settings?.modMode || false;
  store.updateGroupSetting(chatId, "modMode", !current);
  ctx.reply(
    !current
      ? "🛡️ <b>Mod Mode ON</b>\n\nInstant ban for:\n• Forwarding\n• Links\n• Spam\n• Scam keywords"
      : "⚪ <b>Mod Mode OFF</b>",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("menu_boost", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.reply(
    "<b>🚀 Boost Your Token!</b>\n\n" +
    "Contact <b>@boostslegends_bot</b> for:\n" +
    "• Volume boosting\n" +
    "• DEX ranking\n" +
    "• Trending support\n\n" +
    "<i>Keep the momentum going! 💪</i>",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("menu_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.reply(
    "<b>❓ APEX Buy Bot Commands</b>\n\n" +
    "/add CA — Add your token\n" +
    "/remove — Remove token\n" +
    "/settings — Configure bot\n" +
    "/price — Token price\n" +
    "/chart — View charts\n" +
    "/market — Market details\n" +
    "/stats — Buy statistics\n" +
    "/top — Top buyers\n" +
    "/boost — Boost your token\n" +
    "/mod — Toggle mod mode\n" +
    "/pause — Pause alerts\n" +
    "/resume — Resume alerts",
    { parse_mode: "HTML" }
  );
});

// ─── SETTINGS CALLBACKS ───
bot.callbackQuery("toggle_active", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroup(chatId, { active: !group.active });
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(updated) });
});

bot.callbackQuery("toggle_mod", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "modMode", !group.settings?.modMode);
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), { parse_mode: "HTML", reply_markup: buildSettingsKeyboard(updated) });
});

bot.callbackQuery("set_minbuy", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "minBuySol");
  ctx.reply("Reply with minimum buy in SOL (e.g. <code>0.1</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_whale", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "whaleSol");
  ctx.reply("Reply with whale threshold in SOL (e.g. <code>10</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_emoji", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "buyEmoji");
  ctx.reply("Reply with your buy emoji (e.g. 🟢 🚀 💀 🔥)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_banner", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "bannerUrl");
  ctx.reply("Reply with your buy image URL (must start with https://)\n\nTip: Upload to imgur.com and copy the image link.", { parse_mode: "HTML" });
});

bot.callbackQuery("show_stats", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>📊 " + group.tokenName + " Stats</b>\n\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("confirm_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await isGroupAdmin(ctx))) return;
  const kb = new InlineKeyboard().text("✅ Yes", "do_unregister").text("❌ Cancel", "cancel_unregister");
  ctx.reply("Are you sure you want to remove your token?", { reply_markup: kb });
});

bot.callbackQuery("do_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return;
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  if (store.getGroupsForMint(mint).length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.editMessageText("✅ Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
});

bot.callbackQuery("cancel_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.deleteMessage();
});

// ─── TEXT INPUT HANDLER ───
bot.on("message:text", async (ctx, next) => {
  if (!isGroup(ctx)) return next();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.settings || !group.settings.awaitingInput) return next();
  if (!(await isGroupAdmin(ctx))) return next();

  const field = group.settings.awaitingInput;
  const text = ctx.message.text.trim();

  if (field === "groupLink") {
    store.updateGroupSetting(chatId, "groupLink", text);
    store.updateGroupSetting(chatId, "awaitingInput", null);
    const listing = formatListing(group, text);
    try {
      await bot.api.sendMessage(DIRECTORY_CHANNEL, listing, { parse_mode: "HTML", disable_web_page_preview: true });
      ctx.reply("✅ Listed in APEX Trending!\n\nhttps://t.me/apextrendingchannell", { disable_web_page_preview: true });
    } catch (e) {
      console.error("Directory error:", e.message);
      ctx.reply("✅ Token active! Could not post to directory.");
    }
    return;
  }

  let value;
  if (field === "buyEmoji" || field === "bannerUrl") {
    value = text;
  } else {
    value = parseFloat(text);
    if (isNaN(value) || value < 0) return ctx.reply("Invalid value. Enter a number.");
  }

  store.updateGroupSetting(chatId, field, value);
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Updated!");
});

// ─── HELIUS WEBHOOK ───
app.post("/webhook", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["authorization"] || req.headers["x-helius-secret"];
    if (secret !== WEBHOOK_SECRET) return res.sendStatus(401);
  }
  res.sendStatus(200);

  const events = req.body;
  if (!Array.isArray(events) || !events.length) return;

  const solPrice = await getSolPrice();

  for (const event of events) {
    try {
      const buy = parseHeliusWebhook(event);
      if (!buy) continue;

      const chatIds = store.getGroupsForMint(buy.tokenMint);
      if (!chatIds.length) continue;

      for (const chatId of chatIds) {
        const group = store.getGroup(chatId);
        if (!group || !group.active) continue;

        const s = group.settings || {};
        const minBuy = s.minBuySol ?? 0.05;
        const whaleSol = s.whaleSol ?? 10;

        if (buy.solSpent !== null && buy.solSpent < minBuy) continue;

        const isWhale = buy.solSpent !== null && buy.solSpent >= whaleSol;
        const isNewHolder = !(group.uniqueBuyers || []).includes(buy.buyer);

        store.recordGroupBuy(chatId, buy.solSpent || 0, buy.buyer);
        store.updateLeaderboard(chatId, buy.buyer, buy.solSpent || 0);
        const updatedGroup = store.getGroup(chatId);
        const marketCap = await getMarketCap(buy.tokenMint).catch(() => null);

        const buyUrl = "https://jup.ag/swap/SOL-" + buy.tokenMint;
        const kb = new InlineKeyboard()
          .url("🟢 Buy", buyUrl)
          .url("📊 Chart", "https://dexscreener.com/solana/" + buy.tokenMint)
          .url("🐦 Bird", "https://birdeye.so/token/" + buy.tokenMint);

        const msg = formatBuyAlert(buy, updatedGroup, solPrice, s, isWhale, isNewHolder, marketCap);
        const bannerUrl = s.bannerUrl || "";

        if (bannerUrl) {
          try {
            await bot.api.sendPhoto(chatId, bannerUrl, { caption: msg, parse_mode: "HTML", reply_markup: kb });
          } catch {
            await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
          }
        } else {
          await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
        }

        const nextMilestoneIdx = updatedGroup.milestones || 0;
        if (nextMilestoneIdx < MILESTONE_COUNTS.length && updatedGroup.totalBuys >= MILESTONE_COUNTS[nextMilestoneIdx]) {
          const milestoneMsg = formatMilestoneAlert(updatedGroup, MILESTONE_COUNTS[nextMilestoneIdx], solPrice);
          await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML" });
          store.recordMilestone(chatId);
        }
      }
    } catch (err) {
      console.error("Webhook error:", err.message);
    }
  }
});

app.get("/", function(req, res) { res.send("APEX Buy Bot running"); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("APEX Buy Bot on port " + PORT); });

process.once("SIGTERM", () => bot.stop());
process.once("SIGINT", () => bot.stop());

async function startBot() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("Cleared previous session");
  } catch (e) {
    console.log("Clear error:", e.message);
  }
  await new Promise((r) => setTimeout(r, 3000));
  bot.start({ onStart: () => console.log("Bot polling started") });
}

startBot();
