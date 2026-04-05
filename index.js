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
  const emoji = s.buyEmoji ?? "🟢";
  const active = group.active;
  const showPrice = s.showPrice !== false;
  const ignoreMevs = s.ignoreMevs !== false;

  return new InlineKeyboard()
    .text(`🎯 Min Buy: ${minBuy} SOL`, "set_minbuy")
    .text(`🐳 Whale: ${whale} SOL`, "set_whale")
    .row()
    .text(`${emoji} Emoji`, "set_emoji")
    .text(`⏱ Cooldown: ${cooldown}s`, "set_cooldown")
    .row()
    .text(`${showPrice ? "✅" : "❌"} Show Price`, "toggle_price")
    .text(`${ignoreMevs ? "✅" : "❌"} Ignore MEVs`, "toggle_mevs")
    .row()
    .text(`${active ? "⏸ Pause Alerts" : "▶️ Resume Alerts"}`, "toggle_active")
    .text("📊 Stats", "show_stats")
    .row()
    .text("🗑 Unregister Token", "confirm_unregister");
}

function buildSettingsText(group) {
  const s = group.settings || {};
  return (
    `⚙️ <b>APEX Settings</b>\n\n` +
    `🪙 Token: <b>${group.tokenName} (${group.tokenSymbol})</b>\n` +
    `📍 Mint: <code>${group.mint}</code>\n\n` +
    `• Min buy: <b>${s.minBuySol ?? 0.05} SOL</b>\n` +
    `• Whale at: <b>${s.whaleSol ?? 10} SOL</b>\n` +
    `• Cooldown: <b>${s.cooldownSeconds ?? 30}s</b>\n` +
    `• Emoji: <b>${s.buyEmoji ?? "🟢"}</b>\n` +
    `• Show Price: <b>${s.showPrice !== false ? "✅" : "❌"}</b>\n` +
    `• Ignore MEVs: <b>${s.ignoreMevs !== false ? "✅" : "❌"}</b>\n` +
    `• Alerts: <b>${group.active ? "▶️ Active" : "⏸ Paused"}</b>\n\n` +
    `<i>Tap a button below to change settings</i>`
  );
}

bot.command("start", async (ctx) => {
  if (isGroup(ctx)) {
    const chatId = String(ctx.chat.id);
    const group = store.getGroup(chatId);

    if (group?.mint) {
      return ctx.reply(
        `🔺 <b>APEX Buy Bot</b> is active!\n\nTracking: <b>${group.tokenName || group.mint}</b>\n\nUse /settings to customize.`,
        { parse_mode: "HTML" }
      );
    }

    return ctx.reply(
      `👋 <b>APEX Buy Bot is here!</b>\n\nTo start receiving buy alerts, a group admin must register your token:\n\n<code>/register YOUR_TOKEN_MINT_ADDRESS</code>`,
      { parse_mode: "HTML" }
    );
  }

  ctx.reply(
    `🔺 <b>APEX Buy Bot</b>\n\nAdd me to your Telegram group as an <b>admin</b>, then use:\n\n<code>/register YOUR_TOKEN_MINT</code>\n\nto start tracking buys instantly.`,
    { parse_mode: "HTML" }
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    `🔺 <b>APEX Buy Bot Commands</b>\n\n` +
    `<b>Setup (Group Admins)</b>\n` +
    `/register &lt;mint&gt; — Register your token\n` +
    `/unregister — Stop tracking\n\n` +
    `<b>Settings (Group Admins)</b>\n` +
    `/settings — Open settings panel\n` +
    `/setmin &lt;SOL&gt; — Min buy to alert\n` +
    `/setwhale &lt;SOL&gt; — Whale threshold\n` +
    `/setcooldown &lt;sec&gt; — Per-wallet cooldown\n` +
    `/setemoji &lt;emoji&gt; — Custom buy emoji\n` +
    `/pause — Pause alerts\n` +
    `/resume — Resume alerts\n\n` +
    `<b>Public</b>\n` +
    `/stats — Buy stats\n` +
    `/status — Bot status`,
    { parse_mode: "HTML" }
  );
});

bot.command("register", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this command inside your Telegram group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("⛔ Only group admins can register a token.");

  const mint = ctx.message.text.split(" ")[1]?.trim();
  if (!mint || mint.length < 32) {
    return ctx.reply(
      `❌ Please provide a valid token mint address.\n\nUsage:\n<code>/register YOUR_MINT_ADDRESS</code>`,
      { parse_mode: "HTML" }
    );
  }

  const chatId = String(ctx.chat.id);
  const existing = store.getGroup(chatId);
  if (existing?.mint === mint) return ctx.reply(`⚠️ Already tracking this token in this group.`);

  await ctx.reply("🔍 Fetching token info...");

  const info = await getTokenInfo(mint).catch(() => null);
  const tokenName = info?.name || "Unknown Token";
  const tokenSymbol = info?.symbol || "???";

  const heliusOk = await addMintToHelius(mint);
  if (!heliusOk) {
    return ctx.reply("❌ Failed to register with Helius. Check your HELIUS_API_KEY and HELIUS_WEBHOOK_ID.");
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
      buyEmoji: "🟢",
      showPrice: true,
      ignoreMevs: true,
    },
  });

  store.addMintGroup(mint, chatId);

  ctx.reply(
    `✅ <b>APEX Buy Bot activated!</b>\n\n` +
    `🪙 Token: <b>${tokenName} (${tokenSymbol})</b>\n` +
    `📍 Mint: <code>${mint}</code>\n\n` +
    `Buy alerts will now be posted here in real-time.\n\n` +
    `⚙️ Customize with /settings`,
    { parse_mode: "HTML" }
  );
});

bot.command("unregister", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("⛔ Admins only.");

  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group?.mint) return ctx.reply("No token registered in this group.");

  const mint = group.mint;
  store.removeMintGroup(mint, chatId);

  const otherGroups = store.getGroupsForMint(mint);
  if (otherGroups.length === 0) await removeMintFromHelius(mint);

  store.updateGroup(chatId, { mint: null, active: false });
  ctx.reply(`✅ Stopped tracking <b>${group.tokenName}</b> in this group.`, { parse_mode: "HTML" });
});

bot.command("settings", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Use this in your group.");
  if (!(await isGroupAdmin(ctx))) return ctx.reply("⛔ Admins only.");

  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group?.mint) return ctx.reply("No token registered. Use /register first.");

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
  store.updateGroupSetting(chatId, "showPrice", !(group.settings?.showPrice !== false));
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
  store.updateGroupSetting(chatId, "ignoreMevs", !(group.settings?.ignoreMevs !== false));
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
  ctx.reply("💬 Reply with the minimum buy amount in SOL (e.g. <code>0.1</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_whale", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "whaleSol");
  ctx.reply("💬 Reply with the whale threshold in SOL (e.g. <code>10</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_cooldown", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "cooldownSeconds");
  ctx.reply("💬 Reply with the cooldown in seconds (e.g. <code>30</code>)", { parse_mode: "HTML" });
});

bot.callbackQuery("set_emoji", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  store.updateGroupSetting(chatId, "awaitingInput", "buyEmoji");
  ctx.reply("💬 Reply with your buy emoji (e.g. 🚀)", { parse_mode: "HTML" });
});

bot.callbackQuery("show_stats", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group) return;
  const solPrice = await getSolPrice();
  const usdVol = ((group.totalVolumeSol || 0) * solPrice).toFixed(0);
  ctx.reply(
    `📊 <b>${group.tokenName} (${group.tokenSymbol}) Stats</b>\n\n` +
    `📦 Total Buys: <b>${group.totalBuys || 0}</b>\n` +
    `👥 Unique Buyers: <b>${(group.uniqueBuyers || []).length}</b>\n` +
    `💧 Volume: <b>${(group.totalVolumeSol || 0).toFixed(2)} SOL ($${usdVol})</b>\n` +
    `🐳 Biggest Buy: <b>${(group.biggestBuy || 0).toFixed(2)} SOL</b>\n` +
    `🏆 Milestones: <b>${group.milestones || 0}</b>`,
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("confirm_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const kb = new InlineKeyboard()
    .text("✅ Yes, unregister", "do_unregister")
    .text("❌ Cancel", "cancel_unregister");
  ctx.reply("⚠️ Are you sure you want to unregister your token? Buy alerts will stop.", { reply_markup: kb });
});

bot.callbackQuery("do_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat.id);
  if (!(await isGroupAdmin(ctx))) return;
  const group = store.getGroup(chatId);
  if (!group?.mint) return;
  const mint = group.mint;
  store.removeMintGroup(mint, chatId);
  const otherGroups = store.getGroupsForMint(mint);
  if (otherGroups.length === 0) await removeMintFromHelius(mint);
  store.updateGroup(chatId, { mint: null, active: false });
  ctx.editMessageText(`✅ Stopped tracking <b>${group.tokenName}</b>.`, { parse_mode: "HTML" });
});

bot.callbackQuery("cancel_unregister", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.deleteMessage();
});

bot.on("message:text", async (ctx) => {
  if (!isGroup(ctx)) return;
  const chatId = String(ctx.chat.id);
  const group = store.getGroup(chatId);
  if (!group?.settings?.awaitingInput) return;
  if (!(await isGroupAdmin(ctx))) return;

  const field = group.settings.awaitingInput;
  const text = ctx.message.text.trim();

  let value;
  if (field === "buyEmoji") {
    value = text;
  } else {
    value = field === "cooldownSeconds" ? parseInt(text) : parseFloat(text);
    if (isNaN(value) || value < 0) {
      return ctx.reply("❌ Invalid value. Please enter a number.");
    }
  }

  store.updateGroupSetting(chatId, field, value);
  store.updateGroupSetting(chatId, "awaitingInput", null);
  ctx.reply(`✅ Updated! Use /settings to see your full configuration.`, { parse_mode: "HTML" });
});

bot.command("setmin", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("⛔ Group admins only.");
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (isNaN(val)) return ctx.reply("Usage: /setmin 0.1");
  store.updateGroupSetting(String(ctx.chat.id), "minBuySol", val);
  ctx.reply(`✅ Min buy → <b>${val} SOL</b>`, { parse_mode: "HTML" });
});

bot.command("setwhale", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("⛔ Group admins only.");
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (isNaN(val) || val <= 0) return ctx.reply("Usage: /setwhale 10");
  store.updateGroupSetting(String(ctx.chat.id), "whaleSol", val);
  ctx.reply(`✅ Whale threshold → <b>${val} SOL</b>`, { parse_mode: "HTML" });
});

bot.command("setcooldown", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("⛔ Group admins only.");
  const val = parseInt(ctx.message.text.split(" ")[1]);
  if (isNaN(val)) return ctx.reply("Usage: /setcooldown 30");
  store.updateGroupSetting(String(ctx.chat.id), "cooldownSeconds", val);
  ctx.reply(`✅ Cooldown → <b>${val}s</b>`, { parse_mode: "HTML" });
});

bot.command("setemoji", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("⛔ Group admins only.");
  const emoji = ctx.message.text.split(" ")[1];
  if (!emoji) return ctx.reply("Usage: /setemoji 🚀");
  store.updateGroupSetting(String(ctx.chat.id), "buyEmoji", emoji);
  ctx.reply(`✅ Buy emoji → ${emoji}`);
});

bot.command("pause", async (ctx) => {
  if (!isGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.reply("⛔ Group admins only.");
  store.updateGroup(String(ctx.chat.id), { active​​​​​​​​​​​​​​​​
