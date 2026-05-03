const { Client, GatewayIntentBits, Events } = require("discord.js");
const axios = require("axios");
require("dotenv").config();
const config = require("./config.json");

// Pull secrets from environment — fail fast with a clear message if missing
const BOT_TOKEN        = process.env.BOT_TOKEN;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const ALLOWED_GUILD_ID = process.env.ALLOWED_GUILD_ID;
const ALLOWED_ROLE_ID  = process.env.ALLOWED_ROLE_ID;
const WEBHOOK_USER     = process.env.WEBHOOK_USER;
const WEBHOOK_PASS     = process.env.WEBHOOK_PASS;
const WEBHOOK_TIMEOUT  = parseInt(process.env.WEBHOOK_TIMEOUT || "180000", 10);

if (!BOT_TOKEN)        throw new Error("Missing BOT_TOKEN in .env");
if (!WEBHOOK_BASE_URL) throw new Error("Missing WEBHOOK_BASE_URL in .env");
if (!ALLOWED_GUILD_ID) throw new Error("Missing ALLOWED_GUILD_ID in .env");
if (!ALLOWED_ROLE_ID)  throw new Error("Missing ALLOWED_ROLE_ID in .env");
if (!WEBHOOK_USER)     throw new Error("Missing WEBHOOK_USER in .env");
if (!WEBHOOK_PASS)     throw new Error("Missing WEBHOOK_PASS in .env");

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
  console.log(`⏱️  Webhook timeout: ${WEBHOOK_TIMEOUT}ms`);

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
 * Uses force:true to always get fresh role data from Discord, not stale cache.
 */
async function isAuthorized(userId) {
  try {
    console.log(`🔍 Checking authorization for user ${userId}...`);
    const guild = await client.guilds.fetch(ALLOWED_GUILD_ID);
    // force: true bypasses local cache and fetches fresh data from Discord API
    const member = await guild.members.fetch({ user: userId, force: true });
    const hasRole = member.roles.cache.has(ALLOWED_ROLE_ID);
    console.log(`   ↳ Member found: ${member.user.tag} | Has required role: ${hasRole}`);
    return hasRole;
  } catch (err) {
    console.log(`   ↳ User not in guild or fetch failed: ${err.message}`);
    return false;
  }
}

async function sendLongMessage(user, text) {
  const chunks = [];

  for (let i = 0; i < text.length; i += 2000) {
    chunks.push(text.slice(i, i + 2000));
  }

  for (const chunk of chunks) {
    await user.send(chunk);
  }
}

/**
 * Extract reply text from webhook response.
 * Tries multiple common response formats to handle different webhook implementations.
 */
function extractReply(responseData) {
  if (!responseData) {
    console.log(`   ↳ No response data received`);
    return null;
  }

  console.log(`   ↳ Response data type: ${typeof responseData}`);
  console.log(`   ↳ Response data: ${JSON.stringify(responseData).substring(0, 500)}`);

  // Direct string response
  if (typeof responseData === "string") {
    const trimmed = responseData.trim();
    console.log(`   ↳ Extracted direct string reply (length: ${trimmed.length})`);
    return trimmed || null;
  }

  // Object response - try common fields
  if (typeof responseData === "object") {
    const possibleFields = [
      'message',
      'reply',
      'text',
      'response',
      'content',
      'output',
      'result',
      'data'
    ];

    for (const field of possibleFields) {
      if (responseData[field]) {
        const value = responseData[field];
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed) {
            console.log(`   ↳ Extracted reply from field '${field}' (length: ${trimmed.length})`);
            return trimmed;
          }
        } else if (typeof value === "object" && value.text) {
          // Nested text field (e.g., response.data.text)
          const trimmed = value.text.trim();
          if (trimmed) {
            console.log(`   ↳ Extracted nested reply from '${field}.text' (length: ${trimmed.length})`);
            return trimmed;
          }
        }
      }
    }

    // If it's an object but no recognized field, log all keys for debugging
    console.log(`   ↳ No recognized reply field found. Available keys: [${Object.keys(responseData).join(', ')}]`);
  }

  return null;
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

  console.log(`✅ Authorized — processing message and attachments`);

  // Send immediate acknowledgment to avoid timeout appearance
  let ackMessage = null;
  try {
    ackMessage = await message.author.send("⏳ Processing your message...");
    console.log(`   ↳ Sent acknowledgment message`);
  } catch (err) {
    console.warn(`⚠️  Could not send acknowledgment: ${err.message}`);
  }

  // Prepare the payload with text and attachments
  const payload = {
    prompt: message.content || "",
    sessionid: userId,
    attachments: []
  };

  // Process attachments (images, files, etc.)
  if (message.attachments.size > 0) {
    console.log(`📎 Processing ${message.attachments.size} attachment(s)`);
    for (const [id, attachment] of message.attachments) {
      payload.attachments.push({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
        size: attachment.size,
        contentType: attachment.contentType,
        width: attachment.width || null,
        height: attachment.height || null,
      });
      console.log(`   ↳ ${attachment.name} (${attachment.contentType}) - ${attachment.url}`);
    }
  }

  console.log(`🌐 POST ${WEBHOOK_BASE_URL}`);
  console.log(`   ↳ Payload: ${JSON.stringify(payload, null, 2)}`);

  try {
    const response = await axios.post(WEBHOOK_BASE_URL, payload, {
      timeout: WEBHOOK_TIMEOUT,
      auth: {
        username: WEBHOOK_USER,
        password: WEBHOOK_PASS,
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });
    console.log(`   ↳ Webhook status: ${response.status}`);

    const reply = extractReply(response.data);

    if (reply) {
      console.log(`   ↳ Sending webhook reply to user (length: ${reply.length} chars)`);
      console.log(`   ↳ Reply preview: ${reply.substring(0, 200)}${reply.length > 200 ? '...' : ''}`);
      
      // Delete the "processing" message before sending the actual reply
      if (ackMessage) {
        try {
          await ackMessage.delete();
          console.log(`   ↳ Deleted acknowledgment message`);
        } catch (delErr) {
          console.log(`   ↳ Could not delete ack message: ${delErr.message}`);
        }
      }
      
      // Send the actual reply
      await sendLongMessage(message.author, reply);
      console.log(`✅ Reply sent successfully to ${userTag}`);
    } else {
      console.log(`⚠️  No valid reply extracted from webhook response`);
      console.log(`   ↳ Full response for debugging: ${JSON.stringify(response.data)}`);
      
      // Update or send fallback message
      if (ackMessage) {
        try {
          await ackMessage.edit("✅ Your message was received and processed, but no response was generated.");
        } catch (editErr) {
          console.error(`   ↳ Could not edit ack message: ${editErr.message}`);
        }
      } else {
        await message.author.send("✅ Your message was received and processed, but no response was generated.").catch(console.error);
      }
    }
  } catch (err) {
    console.error(`❌ Webhook request failed: ${err.message}`);
    if (err.response) {
      console.error(`   ↳ Response status: ${err.response.status}`);
      console.error(`   ↳ Response data: ${JSON.stringify(err.response.data)}`);
    }
    
    if (ackMessage) {
      try {
        await ackMessage.edit(config.error_message);
      } catch (editErr) {
        console.error(`   ↳ Could not edit ack message: ${editErr.message}`);
        await message.author.send(config.error_message).catch(console.error);
      }
    } else {
      await message.author.send(config.error_message).catch(console.error);
    }
  }
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.login(BOT_TOKEN);

// redeploy
