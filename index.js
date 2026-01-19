require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  Collection, 
  EmbedBuilder, 
  PermissionFlagsBits, 
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');
const fs = require('fs');
const ms = require('ms');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let config;
try {
  config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
} catch (err) {
  config = {
    prefix: "!",
    messages: {},
    antiSpam: { enabled: false, interval: 2000, limit: 5, action: "mute", autoPunish: true },
    punishChats: []
  };
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
}

let logs;
try {
  logs = JSON.parse(fs.readFileSync('./logs.json', 'utf8'));
} catch (err) {
  logs = {};
  fs.writeFileSync('./logs.json', JSON.stringify(logs, null, 2));
}

const spamMap = new Map();

function saveConfig() {
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
}

function saveLogs() {
  fs.writeFileSync('./logs.json', JSON.stringify(logs, null, 2));
}

function getMessage(key, placeholders = {}) {
  let msg = config.messages[key] || "Message not found.";
  for (const [k, v] of Object.entries(placeholders)) {
    msg = msg.replace(`{${k}}`, v);
  }
  return msg;
}

function addLog(userId, action, reason, moderator) {
  if (!logs[userId]) logs[userId] = [];
  logs[userId].push({
    action,
    reason,
    moderator,
    timestamp: new Date().toISOString()
  });
  saveLogs();
}

async function logToChannel(guild, type, description) {
  if (!config.logChannel) return;
  const channel = guild.channels.cache.get(config.logChannel);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`[${type}]`)
    .setDescription(description)
    .setColor(type === 'Ban' || type === 'Kick' ? 0xff0000 : 0xffff00)
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Error sending log:', err);
  }
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

// Auto-role on join
client.on('guildMemberAdd', async member => {
  if (config.autoRole) {
    const role = member.guild.roles.cache.get(config.autoRole);
    if (role) {
      try {
        await member.roles.add(role);
        logToChannel(member.guild, 'Auto-Role', `Added auto-role to ${member.user.tag}`);
      } catch (err) {
        console.error('Error adding auto-role:', err);
      }
    }
  }
});

// Message listener
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // Anti-Spam Logic
  if (config.antiSpam && config.antiSpam.enabled && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    const now = Date.now();
    const userData = spamMap.get(message.author.id) || { count: 0, lastMessageTime: now };
    
    if (now - userData.lastMessageTime < config.antiSpam.interval) {
      userData.count++;
    } else {
      userData.count = 1;
    }
    userData.lastMessageTime = now;
    spamMap.set(message.author.id, userData);

    if (userData.count >= config.antiSpam.limit) {
      if (config.antiSpam.autoPunish) {
        try {
          if (config.antiSpam.action === 'mute') {
            const duration = ms(config.antiSpam.muteTime || '10m');
            await message.member.timeout(duration, 'Auto-Mod: Anti-Spam');
            message.channel.send(`${message.author}, você foi mutado por spam.`);
          } else if (config.antiSpam.action === 'kick') {
            await message.member.kick('Auto-Mod: Anti-Spam');
          }
          addLog(message.author.id, 'Auto-Punish (Spam)', `Action: ${config.antiSpam.action}`, 'System');
          logToChannel(message.guild, 'Auto-Mod', `User: ${message.author.tag} punished for spamming.\nAction: ${config.antiSpam.action}`);
        } catch (err) {
          console.error('Anti-spam punishment failed:', err);
        }
      }
      return;
    }
  }

  if (!message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Custom Builder Command (Mantido conforme solicitado)
  if (command === 'builder' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    const jsonStr = message.content.slice(config.prefix.length + command.length).trim();
    if (!jsonStr) return message.reply('Por favor, forneça o JSON da mensagem (estilo Discohook).');

    try {
      const data = JSON.parse(jsonStr);
      await message.channel.send(data);
      if (message.deletable) message.delete().catch(() => {});
    } catch (err) {
      message.reply('Erro ao processar JSON: ' + err.message);
    }
  }
});

// Interaction Handler
client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    if (interaction.customId === 'btn_info') {
      await interaction.reply({ content: 'Este é um bot multifuncional desenvolvido para Kisekai.', ephemeral: true });
    } else if (interaction.customId === 'btn_help') {
      await interaction.reply({ content: 'Use `!help` para ver a lista de comandos ou entre em contato com a staff.', ephemeral: true });
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'menu_select') {
      const selected = interaction.values[0];
      await interaction.reply({ content: `Você selecionou: ${selected}. Esta função será implementada em breve!`, ephemeral: true });
    }
  }
});

// API Endpoints for Dashboard Integration
app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'No data provided' });
  config = { ...config, ...req.body };
  saveConfig();
  res.json({ message: 'Config updated successfully', config });
});

app.get('/api/logs', (req, res) => res.json(logs));

app.get('/api/stats', (req, res) => {
  res.json({
    guilds: client.guilds.cache.size,
    users: client.users.cache.size,
    uptime: client.uptime,
    ready: client.isReady()
  });
});

// Moderation API Endpoints
app.post('/api/moderate/:action', async (req, res) => {
  const { action } = req.params;
  const { guildId, userId, reason, duration, moderator } = req.body;

  if (!guildId || !userId) return res.status(400).json({ error: 'Missing guildId or userId' });

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const member = await guild.members.fetch(userId).catch(() => null);
    const user = member ? member.user : await client.users.fetch(userId).catch(() => null);

    if (!user) return res.status(404).json({ error: 'User not found' });

    let actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
    let successMessage = `User ${user.tag} was ${action}ed.`;

    switch (action) {
      case 'kick':
        if (!member) return res.status(400).json({ error: 'Member not in guild' });
        await member.kick(reason || 'Kicked via Dashboard');
        break;

      case 'ban':
        await guild.members.ban(userId, { reason: reason || 'Banned via Dashboard' });
        if (duration) {
          const time = ms(duration);
          if (time) {
            setTimeout(async () => {
              await guild.members.unban(userId, 'Temporary ban expired').catch(() => {});
            }, time);
          }
        }
        break;

      case 'mute':
        if (!member) return res.status(400).json({ error: 'Member not in guild' });
        const muteTime = duration ? ms(duration) : ms('10m');
        await member.timeout(muteTime, reason || 'Muted via Dashboard');
        break;

      case 'warn':
        addLog(userId, 'Warning', reason || 'Warned via Dashboard', moderator || 'Dashboard');
        logToChannel(guild, 'Warning', `User: ${user.tag}\nReason: ${reason || 'No reason'}\nModerator: ${moderator || 'Dashboard'}`);
        return res.json({ success: true, message: `Warned ${user.tag}` });

      case 'punish':
        if (!member) return res.status(400).json({ error: 'Member not in guild' });
        for (const channelId of config.punishChats) {
          const channel = guild.channels.cache.get(channelId);
          if (channel) {
            await channel.permissionOverwrites.edit(member, {
              ViewChannel: false,
              SendMessages: false,
              Connect: false
            });
          }
        }
        actionLabel = 'Punishment (Restrict)';
        break;

      case 'unpunish':
        if (!member) return res.status(400).json({ error: 'Member not in guild' });
        for (const channelId of config.punishChats) {
          const channel = guild.channels.cache.get(channelId);
          if (channel) {
            await channel.permissionOverwrites.delete(member);
          }
        }
        break;

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    addLog(userId, actionLabel, reason || 'Action via Dashboard', moderator || 'Dashboard');
    logToChannel(guild, actionLabel, `User: ${user.tag}\nReason: ${reason || 'No reason'}\nModerator: ${moderator || 'Dashboard'}${duration ? `\nDuration: ${duration}` : ''}`);

    res.json({ success: true, message: successMessage });
  } catch (err) {
    console.error(`Moderation error (${action}):`, err);
    res.status(500).json({ error: err.message });
  }
});

// Broadcast/Builder API (To allow dashboard to send messages)
app.post('/api/broadcast', async (req, res) => {
  const { channelId, message, embed } = req.body;
  if (!channelId || (!message && !embed)) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const payload = {};
    if (message) payload.content = message;
    if (embed) payload.embeds = [new EmbedBuilder(embed)];

    await channel.send(payload);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart API Endpoint
app.post('/api/restart', (req, res) => {
  res.json({ message: 'Restarting bot...' });
  console.log('Restart triggered via API. Exiting process...');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Server running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
