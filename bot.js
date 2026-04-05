const { Client, GatewayIntentBits, Events } = require("discord.js");
const axios = require("axios");
require("dotenv").config();
const config = require("./config.json");

// Pull secrets from environment — fail fast with a clear message if missing
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");
if (!WEBHOOK_BASE_URL) throw new Error("Missing WEBHOOK_BASE_URL in .env");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`✅ Bot is online as ${readyClient.user.tag}`);
  console.log(`📋 Watching guild: ${config.allowed_guild_id}`);
  console.log(`🔑 Required role:  ${config.allowed_role_id}`);
});

// Fire when a guild member's roles (or other details) change
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  // Only care about the configured guild
  if (newMember.guild.id !== config.allowed_guild_id) return;

  const hadRole = oldMember.roles.cache.has(config.allowed_role_id);
  const hasRole = newMember.roles.cache.has(config.allowed_role_id);

  // Only trigger when the role was just added (not already there before)
  if (!hadRole && hasRole) {
    console.log(`🎉 Role granted to ${newMember.user.tag} (${newMember.user.id}) — sending DM`);
    try {
      await newMember.user.send(config.role_granted_message);
      console.log(`✅ Role-granted DM sent to ${newMember.user.tag}`);
    } catch (err) {
      // User may have DMs closed — log but don't crash
      console.warn(`⚠️  Could not DM ${newMember.user.tag}: ${err.message}`);
    }
  }
});

/**
 * Check whether a user is in the allowed guild AND has the required role.
 * Returns true/false.
 */
async function isAuthorized(userId) {
  try {
    const guild = await client.guilds.fetch(config.allowed_guild_id);
    const member = await guild.members.fetch(userId);
    return member.roles.cache.has(config.allowed_role_id);
  } catch {
    // User not in guild, or guild/member fetch failed
    return false;
  }
}

client.on(Events.MessageCreate, async (message) => {
  // Only handle DMs from real users
  if (message.author.bot) return;
  if (message.guild) return; // Ignore messages in servers

  const userId = message.author.id;
  const userTag = message.author.tag;

  console.log(`📩 DM from ${userTag} (${userId}): ${message.content}`);

  // Check authorization
  const authorized = await isAuthorized(userId);
  if (!authorized) {
    console.log(`🚫 Unauthorized user: ${userTag} (${userId})`);
    await message.author.send(config.unauthorized_message).catch(console.error);
    return;
  }

  // Build the webhook URL with encoded params
  const encodedPrompt = encodeURIComponent(message.content);
  const encodedSessionId = encodeURIComponent(userId);
  const webhookUrl = `${WEBHOOK_BASE_URL}?prompt=${encodedPrompt}&sessionid=${encodedSessionId}`;

  try {
    console.log(`🌐 Sending GET request for ${userTag}...`);
    const response = await axios.get(webhookUrl, { timeout: 10000 });

    // Try to forward any text response from the webhook back to the user
    let reply = null;
    if (response.data) {
      if (typeof response.data === "string") {
        reply = response.data;
      } else if (response.data.message) {
        reply = response.data.message;
      } else if (response.data.reply) {
        reply = response.data.reply;
      } else if (response.data.text) {
        reply = response.data.text;
      }
    }

    if (reply) {
      await message.author.send(reply).catch(console.error);
    } else {
      // Acknowledge receipt if webhook returned no text body
      await message.author.send("✅ Your message was received and processed!").catch(console.error);
    }

    console.log(`✅ Webhook responded with status ${response.status} for ${userTag}`);
  } catch (err) {
    console.error(`❌ Webhook request failed for ${userTag}:`, err.message);
    await message.author.send(config.error_message).catch(console.error);
  }
});

// Log unhandled promise rejections so the process doesn't silently die
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.login(BOT_TOKEN);
