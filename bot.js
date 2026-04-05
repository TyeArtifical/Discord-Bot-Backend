const { Client, GatewayIntentBits, Events } = require("discord.js");
const axios = require("axios");
require("dotenv").config();
const config = require("./config.json");

// Pull secrets from environment — fail fast with a clear message if missing
const BOT_TOKEN        = process.env.BOT_TOKEN;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const ALLOWED_GUILD_ID = process.env.ALLOWED_GUILD_ID;
const ALLOWED_ROLE_ID  = process.env.ALLOWED_ROLE_ID;

if (!BOT_TOKEN)        throw new Error("Missing BOT_TOKEN in .env");
if (!WEBHOOK_BASE_URL) throw new Error("Missing WEBHOOK_BASE_URL in .env");
if (!ALLOWED_GUILD_ID) throw new Error("Missing ALLOWED_GUILD_ID in .env");
if (!ALLOWED_ROLE_ID)  throw new Error("Missing ALLOWED_ROLE_ID in .env");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Bot is online as ${readyClient.user.tag}`);
  console.log(`📋 Watching guild: ${ALLOWED_GUILD_ID}`);
  console.log(`🔑 Required role:  ${ALLOWED_ROLE_ID}`);

  // Force-fetch all guild members into cache so GuildMemberUpdate fires reliably
  try {
    const guild = await client.guilds.fetch(ALLOWED_GUILD_ID);
    await guild.members.fetch();
    console.log(`✅ Cached ${guild.memberCount} members from guild "${guild.name}"`);
  } catch (err) {
    console.error(`❌ Failed to fetch guild members on startup: ${err.message}`);
  }
});

// Fire when a guild member's roles (or other details) change
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  console.log(`🔄 GuildMemberUpdate fired for ${newMember.user.tag} (guild: ${newMember.guild.id})`);

  if (newMember.guild.id !== ALLOWED_GUILD_ID) {
    console.log(`   ↳ Ignoring — wrong guild`);
    return;
  }

  const oldRoles = [...oldMember.roles.cache.keys()];
  const newRoles = [...newMember.roles.cache.keys()];
  console.log(`   ↳ Old roles: [${oldRoles.join(", ")}]`);
  console.log(`   ↳ New roles: [${newRoles.join(", ")}]`);

  const hadRole = oldMember.roles.cache.has(ALLOWED_ROLE_ID);
  const hasRole = newMember.roles.cache.has(ALLOWED_ROLE_ID);
  console.log(`   ↳ Had required role: ${hadRole} | Has required role: ${hasRole}`);

  if (!hadRole && hasRole) {
    console.log(`🎉 Required role just granted to ${newMember.user.tag} — sending DM`);
    try {
      await newMember.user.send(config.role_granted_message);
      console.log(`✅ Role-granted DM sent to ${newMember.user.tag}`);
    } catch (err) {
      console.warn(`⚠️  Could not DM ${newMember.user.tag}: ${err.message}`);
    }
  } else {
    console.log(`   ↳ No role change of interest — skipping`);
  }
});

/**
 * Check whether a user is in the allowed guild AND has the required role.
 */
async function isAuthorized(userId) {
  try {
    console.log(`🔍 Checking authorization for user ${userId}...`);
    const guild = await client.guilds.fetch(ALLOWED_GUILD_ID);
    const member = await guild.members.fetch(userId);
    const hasRole = member.roles.cache.has(ALLOWED_ROLE_ID);
    console.log(`   ↳ Member found: ${member.user.tag} | Has required role: ${hasRole}`);
    return hasRole;
  } catch (err) {
    console.log(`   ↳ User not in guild or fetch failed: ${err.message}`);
    return false;
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guild) return;

  const userId = message.author.id;
  const userTag = message.author.tag;

  console.log(`📩 DM received from ${userTag} (${userId}): "${message.content}"`);

  const authorized = await isAuthorized(userId);
  if (!authorized) {
    console.log(`🚫 Unauthorized — sending rejection message to ${userTag}`);
    await message.author.send(config.unauthorized_message).catch(console.error);
    return;
  }

  console.log(`✅ Authorized — forwarding message to webhook`);

  const encodedPrompt    = encodeURIComponent(message.content);
  const encodedSessionId = encodeURIComponent(userId);
  const webhookUrl = `${WEBHOOK_BASE_URL}?prompt=${encodedPrompt}&sessionid=${encodedSessionId}`;

  console.log(`🌐 GET ${webhookUrl}`);

  try {
    const response = await axios.get(webhookUrl, { timeout: 10000 });
    console.log(`   ↳ Webhook status: ${response.status}`);
    console.log(`   ↳ Webhook response: ${JSON.stringify(response.data)}`);

    let reply = null;
    if (response.data) {
      if (typeof response.data === "string")  reply = response.data;
      else if (response.data.message)         reply = response.data.message;
      else if (response.data.reply)           reply = response.data.reply;
      else if (response.data.text)            reply = response.data.text;
    }

    if (reply) {
      console.log(`   ↳ Sending webhook reply to user: "${reply}"`);
      await message.author.send(reply).catch(console.error);
    } else {
      console.log(`   ↳ No reply body from webhook — sending default ack`);
      await message.author.send("✅ Your message was received and processed!").catch(console.error);
    }
  } catch (err) {
    console.error(`❌ Webhook request failed: ${err.message}`);
    await message.author.send(config.error_message).catch(console.error);
  }
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.login(BOT_TOKEN);
