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
const BANNER_URL = process.env.BANNER_URL || "";
const DIRECTORY_CHANNEL = process.env.DIRECTORY_CHANNEL || "@apextrendingchannell";

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

function isGroup(ctx) {
  return ["group", "supergroup"].includes(ctx.chat?.type);
}

function buildSettingsKeyboard(group) {
  const s = group.settings || {};
  const minBuy = s.minBuySol ?? 0.05;
  const whale = s.whaleSol ?? 10;
  const showPrice = s.showPrice !== false;
  const active = group.active;

  return new InlineKeyboard()
    .text("Min Buy: " + minBuy + " SOL", "set_minbuy")
    .text("Whale: " + whale + " SOL", "set_whale")
    .row()
    .text("Set Emoji", "set_emoji")
    .text("Set Banner", "set_banner")
    .row()
    .text((showPrice ? "✅" : "❌") + " Show Price", "toggle_price")
    .text("📊 Stats", "show_stats")
    .row()
    .text(active ? "⏸ Pause Alerts" : "▶️ Resume Alerts", "toggle_active")
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
    "Show Price: <b>" + (s.showPrice !== false ? "ON" : "OFF") + "</b>\n" +
    "Alerts: <b>" + (group.active ? "🟢 Active" : "🔴 Paused") + "</b>\n\n" +
    "<i>Tap a button to change settings</i>"
  );
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
    .text("❓ Help", "menu_help");
}

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

bot.on("chat_member", async (ctx) => {
  const newMember = ctx.chatMember?.new_chat_member;
  if (!newMember) return;
  if (newMember.status !== "member") return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const user = newMember.user;
  const name = user.first_name + (user.last_name ? " " + user.last_name : "");
  await bot.api.sendMessage(chatId,
    "👋 Welcome <b>" + name + "</b> to <b>" + (ctx.chat.title || "the group") + "</b>!\n\n" +
    (group.mint ? "We are tracking <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b> 🚀\n\nUse /price to check the latest price!" : ""),
    { parse_mode: "HTML" }
  );
});

bot.command("start", async (ctx) => {
  if (isGroup(ctx)) {
    const chatId = String(ctx.chat.id);
    const group = store.getGroup(chatId);
    return ctx.reply(
      "<b>⚡ APEX Buy Bot</b>\n\n" +
      (group && group.mint ? "Tracking: <b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" : "") +
      "Use the menu below or type a command:",
      { parse_mode: "HTML", reply_markup: buildMainMenu() }
    );
  }
  ctx.reply(
    "<b>⚡ APEX Buy Bot</b>\n\n" +
    "Add me to your Telegram group as admin to get started!\n\n" +
    "I will send real-time buy alerts for your token.",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("menu_add", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.reply("Send your token CA:\n\n<code>/add YOUR_MINT_ADDRESS</code>", { parse_mode: "HTML" });
});

bot.callbackQuery("menu_settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added yet. Use /add first.");
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
    "<b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" +
    "SOL Price: <b>$" + solPrice.toFixed(2) + "</b>\n" +
    (mc ? "Market Cap: <b>$" + Number(mc).toLocaleString() + "</b>\n" : "") +
    "\n<a href='https://dexscreener.com/solana/" + group.mint + "'>View Chart</a>",
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
    "🔗 <a href='https://birdeye.so/token/" + group.mint + "'>Birdeye</a>",
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

bot.callbackQuery("menu_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.reply(
    "<b>❓ APEX Buy Bot Help</b>\n\n" +
    "/add CA — Add your token\n" +
    "/remove — Remove token\n" +
    "/settings — Configure bot\n" +
    "/price — Token price\n" +
    "/chart — View charts\n" +
    "/market — Market details\n" +
    "/stats — Buy statistics\n" +
    "/pause — Pause alerts\n" +
    "/resume — Resume alerts\n\n" +
    "<i>Need help? Contact support.</i>",
    { parse_mode: "HTML" }
  );
});

bot.command("add", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this command inside your Telegram group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Only group admins can add a token.");

  const mint = ctx.message.text.split(" ")[1]?.trim();
  if (!mint || mint.length < 32) {
    return ctx.reply("Send your token CA:\n\n<code>/add YOUR_MINT_ADDRESS</code>", { parse_mode: "HTML" });
  }

  const chatId = String(ctx.chat.id);
  const existing = store.getGroup(chatId);
  if (existing && existing.mint === mint) return ctx.reply("Already tracking this token.");

  await ctx.reply("🔍 Validating token...");

  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = info?.name || mint.slice(0, 6);
  const tokenSymbol = info?.symbol || "???";

  const heliusOk = await addMintToHelius(mint);
  if (!heliusOk) {
    return ctx.reply("❌ Failed to register with Helius. Check HELIUS_API_KEY and HELIUS_WEBHOOK_ID.");
  }

  store.updateGroup(chatId, {
    mint, tokenName, tokenSymbol, active: true,
    registeredAt: Date.now(), totalBuys: 0, totalVolumeSol: 0,
    biggestBuy: 0, uniqueBuyers: [], milestones: 0,
    settings: { minBuySol: 0.05, whaleSol: 10, buyEmoji: "🟢", showPrice: true, bannerUrl: BANNER_URL },
  });
  store.addMintGroup(mint, chatId);

  await ctx.reply(
    "✅ Token added!\n\n" +
    "Token: <b>" + tokenName + " [" + tokenSymbol + "]</b>\n" +
    "CA: <code>" + mint + "</code>\n\n" +
    "Buy alerts are now LIVE! 🚀\n\n" +
    "Please send your group invite link so we can list you in <a href='https://t.me/apextrendingchannell'>APEX Trending</a>:",
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
  const otherGroups = store.getGroupsForMint(mint);
  if (otherGroups.length === 0) await removeMintFromHelius(mint);
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
  if (!group || !group.mint) return ctx.reply("No token added. Use /add first.");
  const solPrice = await getSolPrice();
  const mc = await getMarketCap(group.mint).catch(() => null);
  ctx.reply(
    "<b>" + group.tokenName + " [" + group.tokenSymbol + "]</b>\n\n" +
    "SOL Price: <b>$" + solPrice.toFixed(2) + "</b>\n" +
    (mc ? "Market Cap: <b>$" + Number(mc).toLocaleString() + "</b>\n" : "") +
    "\n<a href='https://dexscreener.com/solana/" + group.mint + "'>View Chart</a>",
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("chart", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added. Use /add first.");
  ctx.reply(
    "<b>📈 " + group.tokenName + " Chart</b>\n\n" +
    "🔗 <a href='https://dexscreener.com/solana/" + group.mint + "'>DexScreener</a>\n" +
    "🔗 <a href='https://birdeye.so/token/" + group.mint + "'>Birdeye</a>",
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("market", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token added. Use /add first.");
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
  if (!group || !group.mint) return ctx.reply("No token added. Use /add first.");
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
    return (i + 1) + ". <b>" + g.title + "</b> - " + (g.tokenName || "No token") + " - Buys: " + (g.totalBuys || 0);
  });
  ctx.reply("<b>Groups (" + keys.length + ")</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
});

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

bot.callbackQuery("toggle_price", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "showPrice", group.settings?.showPrice === false ? true : false);
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
  ctx.reply("Reply with your buy emoji (e.g. 🟢 🚀 💀)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_banner", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "bannerUrl");
  ctx.reply("Reply with your banner image URL (must start with https://)", { parse_mode: "HTML" });
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
  const kb = new InlineKeyboard().text("✅ Yes, remove", "do_unregister").text("❌ Cancel", "cancel_unregister");
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
  const otherGroups = store.getGroupsForMint(mint);
  if (otherGroups.length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.editMessageText("✅ Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
});

bot.callbackQuery("cancel_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.deleteMessage();
});

bot.on("message:text", async (ctx) => {
  if (!isGroup(ctx)) return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.settings || !group.settings.awaitingInput) return;
  if (!(await isGroupAdmin(ctx))) return;

  const field = group.settings.awaitingInput;
  const text = ctx.message.text.trim();

  if (field === "groupLink") {
    store.updateGroupSetting(chatId, "groupLink", text);
    store.updateGroupSetting(chatId, "awaitingInput", null);

    const listing = formatListing(group, text);
    try {
      await bot.api.sendMessage(DIRECTORY_CHANNEL, listing, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      ctx.reply("✅ Your token has been listed in APEX Trending!\n\nhttps://t.me/apextrendingchannell", { disable_web_page_preview: true });
    } catch (e) {
      console.error("Directory post error:", e.message);
      ctx.reply("✅ Token added! Could not post to directory — make sure bot is admin in @apextrendingchannell");
    }
    return;
  }

  let value;
  if (field === "buyEmoji" || field === "bannerUrl") {
    value = text;
  } else {
    value = field === "cooldownSeconds" ? parseInt(text) : parseFloat(text);
    if (isNaN(value) || value < 0) return ctx.reply("Invalid value. Enter a number.");
  }

  store.updateGroupSetting(chatId, field, value);
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("✅ Updated! Use /settings to view.");
});

app.post("/webhook", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["authorization"] || req.headers["x-helius-secret"];
    if (secret !== WEBHOOK_SECRET) return res.sendStatus(401);
  }
  res.sendStatus(200);
  console.log("HELIUS DATA:", JSON.stringify(req.body).slice(0, 300));

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
        const updatedGroup = store.getGroup(chatId);
        const marketCap = await getMarketCap(buy.tokenMint).catch(() => null);

        const buyUrl = "https://jup.ag/swap/SOL-" + buy.tokenMint;
        const kb = new InlineKeyboard()
          .url("🟢 Buy", buyUrl)
          .url("📊 Chart", "https://dexscreener.com/solana/" + buy.tokenMint)
          .url("🐦 Birdeye", "https://birdeye.so/token/" + buy.tokenMint);

        const msg = formatBuyAlert(buy, updatedGroup, solPrice, s, isWhale, isNewHolder, marketCap);
        const bannerUrl = s.bannerUrl || BANNER_URL;

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
