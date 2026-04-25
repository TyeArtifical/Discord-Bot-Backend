const { Client, GatewayIntentBits, Events } = require("discord.js");
const axios = require("axios");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { pipeline } = require('stream');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
require("dotenv").config();
const config = require("./config.json");

// Pull secrets from environment — fail fast with a clear message if missing
const BOT_TOKEN        = process.env.BOT_TOKEN;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const ALLOWED_GUILD_ID = process.env.ALLOWED_GUILD_ID;
const ALLOWED_ROLE_ID  = process.env.ALLOWED_ROLE_ID;
const WEBHOOK_USER     = process.env.WEBHOOK_USER;
const WEBHOOK_PASS     = process.env.WEBHOOK_PASS;
const TTS_ENGINE       = process.env.TTS_ENGINE || 'piper'; // piper or espeak
const STT_ENGINE       = process.env.STT_ENGINE || 'vosk';  // vosk or whisper.cpp
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH || './models/en_US-lessac-medium.onnx';
const VOSK_MODEL_PATH  = process.env.VOSK_MODEL_PATH || './models/vosk-model-small-en-us-0.15';

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
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Track active voice sessions
const voiceSessions = new Map();

class VoiceSession extends EventEmitter {
  constructor(userId, guildId, channelId) {
    super();
    this.userId = userId;
    this.guildId = guildId;
    this.channelId = channelId;
    this.connection = null;
    this.audioPlayer = null;
    this.receiver = null;
    this.isListening = false;
    this.audioBuffer = [];
    this.silenceTimeout = null;
    this.lastAudioTime = Date.now();
  }

  async join(guild, channel) {
    this.connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.audioPlayer = createAudioPlayer();
    this.connection.subscribe(this.audioPlayer);

    this.connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`✅ Voice connection ready for user ${this.userId}`);
      this.startListening();
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (error) {
        this.disconnect();
      }
    });

    return this.connection;
  }

  startListening() {
    if (!this.connection || this.isListening) return;
    
    this.isListening = true;
    this.receiver = this.connection.receiver;
    
    this.receiver.speaking.on('start', (userId) => {
      if (userId !== this.userId) return;
      
      console.log(`🎤 User ${userId} started speaking`);
      this.audioBuffer = [];
      this.lastAudioTime = Date.now();
      
      const audioStream = this.receiver.subscribe(userId, {
        end: {
          behavior: 'manual',
        },
      });

      const opusDecoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 1,
        rate: 48000,
      });

      const decodedStream = audioStream.pipe(opusDecoder);
      
      decodedStream.on('data', (chunk) => {
        this.audioBuffer.push(chunk);
        this.lastAudioTime = Date.now();
        this.resetSilenceTimeout();
      });

      decodedStream.on('error', (err) => {
        console.error(`❌ Audio decode error:`, err);
      });

      audioStream.on('end', () => {
        console.log(`🎤 Audio stream ended for user ${userId}`);
      });

      audioStream.on('error', (err) => {
        console.error(`❌ Audio stream error:`, err);
      });
    });

    this.receiver.speaking.on('end', (userId) => {
      if (userId !== this.userId) return;
      console.log(`🎤 User ${userId} stopped speaking`);
      this.resetSilenceTimeout();
    });
  }

  resetSilenceTimeout() {
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }
    
    this.silenceTimeout = setTimeout(() => {
      if (this.audioBuffer.length > 0) {
        console.log(`🔇 Silence detected, processing audio (${this.audioBuffer.length} chunks)`);
        this.processAudio();
      }
    }, 1500); // 1.5 seconds of silence triggers processing
  }

  async processAudio() {
    if (this.audioBuffer.length === 0) return;

    const audioData = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];

    console.log(`🎵 Processing ${audioData.length} bytes of audio`);

    try {
      const text = await speechToText(audioData);
      if (text && text.trim().length > 0) {
        console.log(`📝 Transcribed: "${text}"`);
        this.emit('transcription', text);
      } else {
        console.log(`⚠️  No speech detected in audio`);
      }
    } catch (error) {
      console.error(`❌ STT error:`, error);
    }
  }

  async speak(text) {
    try {
      const audioStream = await textToSpeech(text);
      const resource = createAudioResource(audioStream, {
        inputType: StreamType.Arbitrary,
      });

      this.audioPlayer.play(resource);

      return new Promise((resolve, reject) => {
        this.audioPlayer.once(AudioPlayerStatus.Idle, resolve);
        this.audioPlayer.once('error', reject);
      });
    } catch (error) {
      console.error(`❌ TTS error:`, error);
      throw error;
    }
  }

  disconnect() {
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }
    
    if (this.audioPlayer) {
      this.audioPlayer.stop();
    }
    
    if (this.connection) {
      this.connection.destroy();
    }
    
    this.isListening = false;
    this.emit('disconnected');
  }
}

/**
 * Text-to-Speech using Piper or eSpeak
 */
async function textToSpeech(text) {
  return new Promise((resolve, reject) => {
    // Sanitize text to prevent command injection
    const sanitizedText = text.replace(/[`$\\]/g, '\\$&');
    
    if (TTS_ENGINE === 'piper') {
      // Piper: High-quality, fast, low-resource neural TTS
      // Input: text via stdin
      // Output: WAV audio to stdout
      const piper = spawn('piper', [
        '--model', PIPER_MODEL_PATH,
        '--output-raw'
      ]);

      piper.stdin.write(sanitizedText);
      piper.stdin.end();

      piper.stderr.on('data', (data) => {
        console.error('Piper stderr:', data.toString());
      });

      piper.on('error', (err) => {
        console.error('Piper TTS error:', err);
        reject(err);
      });

      piper.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`Piper exited with code ${code}`);
        }
      });

      resolve(piper.stdout);
    } else if (TTS_ENGINE === 'espeak') {
      // eSpeak: Lightweight, very low resource usage
      const espeak = spawn('espeak', [
        '--stdout',
        '-v', 'en-us',
        '-s', '150', // Speed
        '-p', '50',  // Pitch
        sanitizedText
      ]);

      espeak.stderr.on('data', (data) => {
        console.error('eSpeak stderr:', data.toString());
      });

      espeak.on('error', (err) => {
        console.error('eSpeak TTS error:', err);
        reject(err);
      });

      espeak.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`eSpeak exited with code ${code}`);
        }
      });

      resolve(espeak.stdout);
    } else {
      reject(new Error(`Unknown TTS engine: ${TTS_ENGINE}`));
    }
  });
}

/**
 * Speech-to-Text using Vosk or Whisper.cpp
 */
async function speechToText(audioBuffer) {
  return new Promise((resolve, reject) => {
    const tempFile = path.join('/tmp', `audio-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.wav`);
    
    // Convert PCM to WAV format
    const wavHeader = createWavHeader(audioBuffer.length, 48000, 1, 16);
    const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
    
    try {
      fs.writeFileSync(tempFile, wavBuffer);
    } catch (err) {
      console.error('Failed to write temp audio file:', err);
      reject(err);
      return;
    }

    const cleanup = () => {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch (err) {
        console.warn('Failed to cleanup temp file:', err);
      }
    };

    if (STT_ENGINE === 'vosk') {
      // Vosk: Offline, lightweight speech recognition
      const voskScript = `
import sys
import json
import wave
from vosk import Model, KaldiRecognizer

try:
    model = Model("${VOSK_MODEL_PATH}")
    wf = wave.open("${tempFile}", "rb")
    rec = KaldiRecognizer(model, wf.getframerate())

    result_text = ""
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        if rec.AcceptWaveform(data):
            result = json.loads(rec.Result())
            if "text" in result:
                result_text += result["text"] + " "

    final_result = json.loads(rec.FinalResult())
    if "text" in final_result:
        result_text += final_result["text"]

    print(result_text.strip())
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;
      
      const vosk = spawn('python3', ['-c', voskScript]);

      let output = '';
      let errorOutput = '';
      
      vosk.stdout.on('data', (data) => {
        output += data.toString();
      });

      vosk.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      vosk.on('close', (code) => {
        cleanup();
        if (code === 0) {
          resolve(output.trim());
        } else {
          console.error('Vosk stderr:', errorOutput);
          reject(new Error(`Vosk exited with code ${code}`));
        }
      });

      vosk.on('error', (err) => {
        cleanup();
        reject(err);
      });
    } else if (STT_ENGINE === 'whisper.cpp') {
      // Whisper.cpp: Higher accuracy, more resource intensive
      const whisperPath = path.join(__dirname, 'whisper.cpp', 'main');
      const modelPath = path.join(__dirname, 'models', 'ggml-base.en.bin');
      
      const whisper = spawn(whisperPath, [
        '-m', modelPath,
        '-f', tempFile,
        '-nt' // No timestamps
      ]);

      let output = '';
      let errorOutput = '';
      
      whisper.stdout.on('data', (data) => {
        output += data.toString();
      });

      whisper.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      whisper.on('close', (code) => {
        cleanup();
        if (code === 0) {
          // Extract transcription from whisper output
          const lines = output.split('\n');
          const transcription = lines
            .filter(line => line.trim() && !line.startsWith('['))
            .join(' ')
            .trim();
          resolve(transcription);
        } else {
          console.error('Whisper stderr:', errorOutput);
          reject(new Error(`Whisper.cpp exited with code ${code}`));
        }
      });

      whisper.on('error', (err) => {
        cleanup();
        reject(err);
      });
    } else {
      cleanup();
      reject(new Error(`Unknown STT engine: ${STT_ENGINE}`));
    }
  });
}

/**
 * Create WAV header for PCM audio
 */
function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
  const header = Buffer.alloc(44);
  
  // RIFF chunk
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28); // byte rate
  header.writeUInt16LE(channels * bitsPerSample / 8, 32); // block align
  header.writeUInt16LE(bitsPerSample, 34);
  
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  
  return header;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Bot is online as ${readyClient.user.tag}`);
  console.log(`📋 Watching guild: ${ALLOWED_GUILD_ID}`);
  console.log(`🔑 Required role:  ${ALLOWED_ROLE_ID}`);
  console.log(`🎤 TTS Engine: ${TTS_ENGINE}`);
  console.log(`🎧 STT Engine: ${STT_ENGINE}`);

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

// Handle voice state updates (user joins/leaves voice channel)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId = newState.id;
  
  // User joined a voice channel
  if (!oldState.channelId && newState.channelId) {
    console.log(`🔊 User ${userId} joined voice channel ${newState.channelId}`);
    
    const authorized = await isAuthorized(userId);
    if (!authorized) {
      console.log(`🚫 Unauthorized voice user ${userId}`);
      return;
    }

    // Create and start voice session
    const session = new VoiceSession(userId, newState.guild.id, newState.channelId);
    voiceSessions.set(userId, session);

    try {
      await session.join(newState.guild, newState.channel);
      await session.speak(config.voice_greeting || "Hello! I'm listening. Start speaking and I'll respond.");

      session.on('transcription', async (text) => {
        console.log(`💬 Processing voice message from ${userId}: "${text}"`);
        
        // Send to webhook with timeout protection
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minute timeout
          
          const response = await axios.post(WEBHOOK_BASE_URL, {
            prompt: text,
            sessionid: userId,
            voice: true,
            attachments: []
          }, {
            timeout: 180000,
            signal: controller.signal,
            auth: {
              username: WEBHOOK_USER,
              password: WEBHOOK_PASS,
            },
            headers: {
              'Content-Type': 'application/json',
            },
          }).finally(() => clearTimeout(timeoutId));

          let reply = null;
          if (response.data) {
            if (typeof response.data === "string") reply = response.data;
            else if (response.data.message) reply = response.data.message;
            else if (response.data.reply) reply = response.data.reply;
            else if (response.data.text) reply = response.data.text;
          }

          if (reply) {
            console.log(`🔊 Speaking response: "${reply.substring(0, 100)}..."`);
            await session.speak(reply);
          }
        } catch (err) {
          console.error(`❌ Webhook error in voice session:`, err.message);
          try {
            await session.speak("Sorry, I encountered an error processing your request.");
          } catch (speakErr) {
            console.error(`❌ Failed to speak error message:`, speakErr);
          }
        }
      });

      session.on('disconnected', () => {
        console.log(`🔇 Voice session ended for user ${userId}`);
        voiceSessions.delete(userId);
      });

    } catch (err) {
      console.error(`❌ Failed to start voice session:`, err);
      voiceSessions.delete(userId);
    }
  }
  
  // User left voice channel
  if (oldState.channelId && !newState.channelId) {
    console.log(`🔇 User ${userId} left voice channel`);
    const session = voiceSessions.get(userId);
    if (session) {
      session.disconnect();
      voiceSessions.delete(userId);
    }
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
    voice: false,
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
      timeout: 190000,
      auth: {
        username: WEBHOOK_USER,
        password: WEBHOOK_PASS,
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });
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
      // Delete the "processing" message if it exists
      if (ackMessage) {
        await ackMessage.delete().catch(() => {
          console.log(`   ↳ Could not delete ack message, will edit instead`);
        });
      }
      await sendLongMessage(message.author, reply).catch(console.error);
    } else {
      console.log(`   ↳ No reply body from webhook — sending default ack`);
      if (ackMessage) {
        await ackMessage.edit("✅ Your message was received and processed!").catch(console.error);
      } else {
        await message.author.send("✅ Your message was received and processed!").catch(console.error);
      }
    }
  } catch (err) {
    console.error(`❌ Webhook request failed: ${err.message}`);
    if (ackMessage) {
      await ackMessage.edit(config.error_message).catch(console.error);
    } else {
      await message.author.send(config.error_message).catch(console.error);
    }
  }
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.login(BOT_TOKEN);
