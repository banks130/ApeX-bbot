require("dotenv").config();
const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const { parseHeliusWebhook } = require("./parser");
const { formatBuyAlert, formatMilestoneAlert, formatWelcome } = require("./formatter");
const { getSolPrice, getTokenInfo, getWalletProfile } = require("./data");
const { addMintToHelius, removeMintFromHelius } = require("./helius");
const store = require("./store");

const app = express();
app.use(express.json());

const bot = new Bot(process.env.BOT_TOKEN);
const SUPER_ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((id) => id.trim());
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || "";
const MILESTONE_COUNTS = [10, 25, 50, 100, 250, 500, 1000];

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
  const cooldown = s.cooldownSeconds ?? 30;
  const active = group.active;
  const showPrice = s.showPrice !== false;
  const ignoreMevs = s.ignoreMevs !== false;

  return new InlineKeyboard()
    .text("Min Buy: " + minBuy + " SOL", "set_minbuy")
    .text("Whale: " + whale + " SOL", "set_whale")
    .row()
    .text("Set Emoji", "set_emoji")
    .text("Cooldown: " + cooldown + "s", "set_cooldown")
    .row()
    .text((showPrice ? "ON" : "OFF") + " Show Price", "toggle_price")
    .text((ignoreMevs ? "ON" : "OFF") + " Ignore MEVs", "toggle_mevs")
    .row()
    .text(active ? "Pause Alerts" : "Resume Alerts", "toggle_active")
    .text("Stats", "show_stats")
    .row()
    .text("Unregister Token", "confirm_unregister");
}

function buildSettingsText(group) {
  const s = group.settings || {};
  return (
    "<b>APEX Settings</b>\n\n" +
    "Token: <b>" + group.tokenName + " (" + group.tokenSymbol + ")</b>\n" +
    "Mint: <code>" + group.mint + "</code>\n\n" +
    "Min buy: <b>" + (s.minBuySol ?? 0.05) + " SOL</b>\n" +
    "Whale at: <b>" + (s.whaleSol ?? 10) + " SOL</b>\n" +
    "Cooldown: <b>" + (s.cooldownSeconds ?? 30) + "s</b>\n" +
    "Emoji: <b>" + (s.buyEmoji ?? "green") + "</b>\n" +
    "Show Price: <b>" + (s.showPrice !== false ? "ON" : "OFF") + "</b>\n" +
    "Ignore MEVs: <b>" + (s.ignoreMevs !== false ? "ON" : "OFF") + "</b>\n" +
    "Alerts: <b>" + (group.active ? "Active" : "Paused") + "</b>\n\n" +
    "<i>Tap a button below to change settings</i>"
  );
}

bot.command("start", async (ctx) => {
  if (isGroup(ctx)) {
    const chatId = String(ctx.chat.id);
    const group = store.getGroup(chatId);
    if (group && group.mint) {
      return ctx.reply(
        "<b>APEX Buy Bot</b> is active!\n\nTracking: <b>" + (group.tokenName || group.mint) + "</b>\n\nUse /settings to customize.",
        { parse_mode: "HTML" }
      );
    }
    return ctx.reply(
      "<b>APEX Buy Bot is here!</b>\n\nTo start receiving buy alerts, a group admin must register your token:\n\n<code>/register YOUR_TOKEN_MINT_ADDRESS</code>",
      { parse_mode: "HTML" }
    );
  }
  ctx.reply(
    "<b>APEX Buy Bot</b>\n\nAdd me to your Telegram group as an admin, then use:\n\n<code>/register YOUR_TOKEN_MINT</code>\n\nto start tracking buys instantly.",
    { parse_mode: "HTML" }
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "<b>APEX Buy Bot Commands</b>\n\n" +
    "<b>Setup (Group Admins)</b>\n" +
    "/register mint - Register your token\n" +
    "/unregister - Stop tracking\n\n" +
    "<b>Settings (Group Admins)</b>\n" +
    "/settings - Open settings panel\n" +
    "/setmin SOL - Min buy to alert\n" +
    "/setwhale SOL - Whale threshold\n" +
    "/setcooldown sec - Per-wallet cooldown\n" +
    "/setemoji emoji - Custom buy emoji\n" +
    "/pause - Pause alerts\n" +
    "/resume - Resume alerts\n\n" +
    "<b>Public</b>\n" +
    "/stats - Buy stats\n" +
    "/status - Bot status",
    { parse_mode: "HTML" }
  );
});

bot.command("register", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this command inside your Telegram group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Only group admins can register a token.");

  const mint = ctx.message.text.split(" ")[1] ? ctx.message.text.split(" ")[1].trim() : null;
  if (!mint || mint.length < 32) {
    return ctx.reply(
      "Please provide a valid token mint address.\n\nUsage:\n<code>/register YOUR_MINT_ADDRESS</code>",
      { parse_mode: "HTML" }
    );
  }

  const chatId = String(ctx.chat.id);
  const existing = store.getGroup(chatId);
  if (existing && existing.mint === mint) return ctx.reply("Already tracking this token in this group.");

  await ctx.reply("Fetching token info...");

  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = (info && info.name) ? info.name : "Unknown Token";
  const tokenSymbol = (info && info.symbol) ? info.symbol : "???";

  const heliusOk = await addMintToHelius(mint);
  if (!heliusOk) {
    return ctx.reply("Failed to register with Helius. Check your HELIUS_API_KEY and HELIUS_WEBHOOK_ID.");
  }

  store.updateGroup(chatId, {
    mint,
    tokenName,
    tokenSymbol,
    active: true,
    registeredAt: Date.now(),
    totalBuys: 0,
    totalVolumeSol: 0,
    biggestBuy: 0,
    uniqueBuyers: [],
    milestones: 0,
    settings: {
      minBuySol: 0.05,
      whaleSol: 10,
      cooldownSeconds: 30,
      buyEmoji: "green",
      showPrice: true,
      ignoreMevs: true,
    },
  });

  store.addMintGroup(mint, chatId);

  ctx.reply(
    "APEX Buy Bot activated!\n\n" +
    "Token: <b>" + tokenName + " (" + tokenSymbol + ")</b>\n" +
    "Mint: <code>" + mint + "</code>\n\n" +
    "Buy alerts will now be posted here in real-time.\n\n" +
    "Customize with /settings",
    { parse_mode: "HTML" }
  );
});

bot.command("unregister", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token registered in this group.");
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  const otherGroups = store.getGroupsForMint(mint);
  if (otherGroups.length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.reply("Stopped tracking <b>" + group.tokenName + "</b> in this group.", { parse_mode: "HTML" });
});

bot.command("settings", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("Admins only.");
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token registered. Use /register first.");
  ctx.reply(buildSettingsText(group), {
    parse_mode: "HTML",
    reply_markup: buildSettingsKeyboard(group),
  });
});

bot.callbackQuery("toggle_active", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroup(chatId, { active: !group.active });
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), {
    parse_mode: "HTML",
    reply_markup: buildSettingsKeyboard(updated),
  });
});

bot.callbackQuery("toggle_price", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "showPrice", !(group.settings && group.settings.showPrice !== false));
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), {
    parse_mode: "HTML",
    reply_markup: buildSettingsKeyboard(updated),
  });
});

bot.callbackQuery("toggle_mevs", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group) return;
  store.updateGroupSetting(chatId, "ignoreMevs", !(group.settings && group.settings.ignoreMevs !== false));
  const updated = store.getGroup(chatId);
  ctx.editMessageText(buildSettingsText(updated), {
    parse_mode: "HTML",
    reply_markup: buildSettingsKeyboard(updated),
  });
});

bot.callbackQuery("set_minbuy", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "minBuySol");
  ctx.reply("Reply with the minimum buy amount in SOL (e.g. <code>0.1</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_whale", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "whaleSol");
  ctx.reply("Reply with the whale threshold in SOL (e.g. <code>10</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_cooldown", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "cooldownSeconds");
  ctx.reply("Reply with the cooldown in seconds (e.g. <code>30</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_emoji", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "buyEmoji");
  ctx.reply("Reply with your buy emoji (e.g. rocket, green, fire)", { parse_mode: "HTML" });
});

bot.callbackQuery("show_stats", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>" + group.tokenName + " (" + group.tokenSymbol + ") Stats</b>\n\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>\n" +
    "Milestones: <b>" + (group.milestones || 0) + "</b>",
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("confirm_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const kb = new InlineKeyboard()
    .text("Yes, unregister", "do_unregister")
    .text("Cancel", "cancel_unregister");
  ctx.reply("Are you sure you want to unregister your token? Buy alerts will stop.", { reply_markup: kb });
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
  ctx.editMessageText("Stopped tracking <b>" + group.tokenName + "</b>.", { parse_mode: "HTML" });
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
  let value;

  if (field === "buyEmoji") {
    value = text;
  } else {
    value = field === "cooldownSeconds" ? parseInt(text) : parseFloat(text);
    if (isNaN(value) || value < 0) {
      return ctx.reply("Invalid value. Please enter a number.");
    }
  }

  store.updateGroupSetting(chatId, field, value);
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply("Updated! Use /settings to see your full configuration.");
});

bot.command("setmin", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Group admins only.");
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (isNaN(val)) return ctx.reply("Usage: /setmin 0.1");
  store.updateGroupSetting(String(ctx.chat.id), "minBuySol", val);
  ctx.reply("Min buy set to <b>" + val + " SOL</b>", { parse_mode: "HTML" });
});

bot.command("setwhale", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Group admins only.");
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (isNaN(val) || val <= 0) return ctx.reply("Usage: /setwhale 10");
  store.updateGroupSetting(String(ctx.chat.id), "whaleSol", val);
  ctx.reply("Whale threshold set to <b>" + val + " SOL</b>", { parse_mode: "HTML" });
});

bot.command("setcooldown", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Group admins only.");
  const val = parseInt(ctx.message.text.split(" ")[1]);
  if (isNaN(val)) return ctx.reply("Usage: /setcooldown 30");
  store.updateGroupSetting(String(ctx.chat.id), "cooldownSeconds", val);
  ctx.reply("Cooldown set to <b>" + val + "s</b>", { parse_mode: "HTML" });
});

bot.command("setemoji", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Group admins only.");
  const emoji = ctx.message.text.split(" ")[1];
  if (!emoji) return ctx.reply("Usage: /setemoji rocket");
  store.updateGroupSetting(String(ctx.chat.id), "buyEmoji", emoji);
  ctx.reply("Buy emoji set to " + emoji);
});

bot.command("pause", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Group admins only.");
  store.updateGroup(String(ctx.chat.id), { active: false });
  ctx.reply("Buy alerts paused.");
});

bot.command("resume", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("Group admins only.");
  store.updateGroup(String(ctx.chat.id), { active: true });
  ctx.reply("Buy alerts resumed.");
});

bot.command("stats", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) return ctx.reply("No token registered. Use /register first.");
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    "<b>" + group.tokenName + " (" + group.tokenSymbol + ") Stats</b>\n\n" +
    "Total Buys: <b>" + (group.totalBuys || 0) + "</b>\n" +
    "Unique Buyers: <b>" + (group.uniqueBuyers || []).length + "</b>\n" +
    "Volume: <b>" + (group.totalVolumeSol || 0).toFixed(2) + " SOL ($" + usdVol + ")</b>\n" +
    "Biggest Buy: <b>" + (group.biggestBuy || 0).toFixed(2) + " SOL</b>\n" +
    "Milestones: <b>" + (group.milestones || 0) + "</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("status", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group || !group.mint) {
    return ctx.reply(
      "<b>APEX Buy Bot</b>\n\nNot configured yet.\nUse /register mint to get started.",
      { parse_mode: "HTML" }
    );
  }
  const s = group.settings || {};
  ctx.reply(
    "<b>APEX Status</b>\n\n" +
    "Token: <b>" + group.tokenName + " (" + group.tokenSymbol + ")</b>\n" +
    "Alerts: <b>" + (group.active ? "Active" : "Paused") + "</b>\n" +
    "Min buy: <b>" + (s.minBuySol ?? 0.05) + " SOL</b>\n" +
    "Whale at: <b>" + (s.whaleSol ?? 10) + " SOL</b>\n" +
    "Cooldown: <b>" + (s.cooldownSeconds ?? 30) + "s</b>",
    { parse_mode: "HTML" }
  );
});

bot.command("groups", (ctx) => {
  if (!isSuperAdmin(ctx)) return;
  const groups = store.getAllGroups();
  const keys = Object.keys(groups);
  if (!keys.length) return ctx.reply("No groups registered.");
  const lines = keys.map(function(id, i) {
    const g = groups[id];
    return (i + 1) + ". <b>" + g.title + "</b>\n   Token: " + (g.tokenName || "None") + "\n   Buys: " + (g.totalBuys || 0);
  });
  ctx.reply("<b>All Groups (" + keys.length + ")</b>\n\n" + lines.join("\n\n"), { parse_mode: "HTML" });
});

bot.on("my_chat_member", async (ctx) => {
  const newStatus = ctx.myChatMember && ctx.myChatMember.new_chat_member ? ctx.myChatMember.new_chat_member.status : null;
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

      const walletProfile = await getWalletProfile(buy.buyer).catch(() => null);

      for (const chatId of chatIds) {
        const group = store.getGroup(chatId);
        if (!group || !group.active) continue;

        const s = group.settings || {};

        if (s.ignoreMevs !== false && walletProfile && walletProfile.totalTransactions === "1000+") continue;

        const minBuy = s.minBuySol ?? 0.05;
        const whaleSol = s.whaleSol ?? 10;
        const cooldown = s.cooldownSeconds ?? 30;

        if (buy.solSpent !== null && buy.solSpent < minBuy) continue;

        const cooldownKey = chatId + ":" + buy.buyer;
        const lastAlert = store.getWalletLastAlert(cooldownKey);
        if (lastAlert && Date.now() - lastAlert < cooldown * 1000) continue;
        store.setWalletLastAlert(cooldownKey);

        const isWhale = buy.solSpent !== null && buy.solSpent >= whaleSol;
        const isNewHolder = !(group.uniqueBuyers || []).includes(buy.buyer);

        store.recordGroupBuy(chatId, buy.solSpent || 0, buy.buyer);
        const updatedGroup = store.getGroup(chatId);

        const msg = formatBuyAlert(buy, updatedGroup, walletProfile, solPrice, s, isWhale, isNewHolder);
        await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true });

        const nextMilestoneIdx = updatedGroup.milestones || 0;
        if (
          nextMilestoneIdx < MILESTONE_COUNTS.length &&
          updatedGroup.totalBuys >= MILESTONE_COUNTS[nextMilestoneIdx]
        ) {
          const milestoneMsg = formatMilestoneAlert(updatedGroup, MILESTONE_COUNTS[nextMilestoneIdx], solPrice);
          await bot.api.sendMessage(chatId, milestoneMsg, { parse_mode: "HTML", disable_web_page_preview: true });
          store.recordMilestone(chatId);
        }
      }
    } catch (err) {
      console.error("Webhook event error:", err.message);
    }
  }
});

app.get("/", function(req, res) { res.send("APEX Buy Bot running"); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("APEX Buy Bot on port " + PORT); });
bot.start();
