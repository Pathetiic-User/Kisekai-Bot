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

// Anti-spam tracker: Map<userId, { count, lastMessageTime }>
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

// Message listener for Anti-Spam and Commands
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
      return; // Stop processing command if spamming
    }
  }

  if (!message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Prefix config
  if (command === 'prefix' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    if (!args[0]) return message.reply(`Current prefix is: ${config.prefix}`);
    config.prefix = args[0];
    saveConfig();
    message.reply(getMessage('prefixUpdated', { prefix: config.prefix }));
  }

  // Set autorole
  if (command === 'setautorole' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[0]);
    if (!role) return message.reply(getMessage('invalidUsage'));
    config.autoRole = role.id;
    saveConfig();
    message.reply(getMessage('autoRoleSet', { role: role.name }));
  }

  // Set logs channel
  if (command === 'setlogs' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
    if (!channel) return message.reply(getMessage('invalidUsage'));
    config.logChannel = channel.id;
    saveConfig();
    message.reply(getMessage('logsSet', { channel: channel.name }));
  }

  // Set reports channel
  if (command === 'setreports' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
    if (!channel) return message.reply(getMessage('invalidUsage'));
    config.reportChannel = channel.id;
    saveConfig();
    message.reply(getMessage('reportsSet', { channel: channel.name }));
  }

  // Punish chats config
  if (command === 'punishchats' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    const channels = message.mentions.channels;
    if (channels.size === 0) return message.reply(`Current punish chats: ${config.punishChats.map(id => `<#${id}>`).join(', ') || 'None'}`);
    config.punishChats = channels.map(c => c.id);
    saveConfig();
    message.reply(getMessage('punishChatsUpdated'));
  }

  // Reportar Command
  if (command === 'reportar') {
    const target = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
    const reason = args.slice(1).join(' ');

    if (!target) return message.reply('Uso: !reportar @usuario motivo');
    if (!reason) return message.reply('Por favor, forneça um motivo.');

    try {
      if (config.dashboardUrl) {
        await fetch(config.dashboardUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guildId: message.guild.id,
            reporterId: message.author.id,
            reporterTag: message.author.tag,
            targetId: target.id,
            targetTag: target.user.tag,
            reason: reason,
            timestamp: new Date().toISOString()
          })
        });
        message.reply(getMessage('reportSuccess'));
      } else {
        // Fallback to channel if dashboardUrl is not set
        if (!config.reportChannel) return message.reply('O canal de denúncias não foi configurado.');
        const reportChannel = message.guild.channels.cache.get(config.reportChannel);
        if (!reportChannel) return message.reply('Canal de denúncias não encontrado.');

        const embed = new EmbedBuilder()
          .setTitle('Novo Relatório de Usuário')
          .addFields(
            { name: 'Reportado', value: `${target.user.tag} (${target.id})`, inline: true },
            { name: 'Autor', value: `${message.author.tag} (${message.author.id})`, inline: true },
            { name: 'Motivo', value: reason }
          )
          .setColor(0xffa500)
          .setTimestamp();

        await reportChannel.send({ embeds: [embed] });
        message.reply(getMessage('reportSuccess'));
      }
    } catch (err) {
      console.error('Error sending report:', err);
      message.reply(getMessage('reportError'));
    }
  }

  // Moderation Commands
  if (command === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply(getMessage('noPermission'));
    const target = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
    if (!target) return message.reply(getMessage('userNotFound'));
    
    const type = args.find(a => ['-v', '-t', '-a'].includes(a)) || '-a';
    const reason = args.filter(a => !['-v', '-t', '-a'].includes(a)).slice(1).join(' ') || 'No reason provided';

    try {
      if (type === '-v') {
        if (!target.voice.channel) return message.reply('User is not in a voice channel.');
        await target.voice.disconnect(reason);
        message.reply(getMessage('kickSuccess', { user: target.user.tag }));
      } else if (type === '-t' || type === '-a') {
        await target.kick(reason);
        message.reply(getMessage('kickSuccess', { user: target.user.tag }));
      }
      addLog(target.id, 'Kick', reason, message.author.tag);
      logToChannel(message.guild, 'Kick', `User: ${target.user.tag}\nType: ${type}\nReason: ${reason}\nModerator: ${message.author.tag}`);
    } catch (err) {
      message.reply('Failed to kick user.');
    }
  }

  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply(getMessage('noPermission'));
    const target = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
    if (!target) return message.reply(getMessage('userNotFound'));

    const timeArg = args.find(a => /^\d+[smhd]$/.test(a));
    const duration = timeArg ? ms(timeArg) : null;
    const reason = args.filter(a => a !== timeArg).slice(1).join(' ') || 'No reason provided';

    try {
      await target.ban({ reason });
      message.reply(getMessage('banSuccess', { user: target.user.tag, duration: duration ? ` for ${timeArg}` : '' }));
      addLog(target.id, 'Ban', reason, message.author.tag);
      logToChannel(message.guild, 'Ban', `User: ${target.user.tag}\nDuration: ${timeArg || 'Permanent'}\nReason: ${reason}\nModerator: ${message.author.tag}`);

      if (duration) {
        setTimeout(async () => {
          await message.guild.members.unban(target.id, 'Temporary ban expired').catch(() => {});
        }, duration);
      }
    } catch (err) {
      message.reply('Failed to ban user.');
    }
  }

  if (command === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply(getMessage('noPermission'));
    const target = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
    if (!target) return message.reply(getMessage('userNotFound'));

    const timeArg = args.find(a => /^\d+[smhd]$/.test(a)) || '10m';
    const duration = ms(timeArg);
    const reason = args.filter(a => a !== timeArg).slice(1).join(' ') || 'No reason provided';

    try {
      await target.timeout(duration, reason);
      message.reply(getMessage('muteSuccess', { user: target.user.tag, duration: timeArg }));
      addLog(target.id, 'Mute', reason, message.author.tag);
      logToChannel(message.guild, 'Mute', `User: ${target.user.tag}\nDuration: ${timeArg}\nReason: ${reason}\nModerator: ${message.author.tag}`);
    } catch (err) {
      message.reply('Failed to mute user.');
    }
  }

  if (command === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply(getMessage('noPermission'));
    const target = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
    if (!target) return message.reply(getMessage('userNotFound'));
    const reason = args.slice(1).join(' ') || 'No reason provided';
    
    addLog(target.id, 'Warning', reason, message.author.tag);
    message.reply(getMessage('warnSuccess', { user: target.user.tag }));
    logToChannel(message.guild, 'Warning', `User: ${target.user.tag}\nReason: ${reason}\nModerator: ${message.author.tag}`);
  }

  if (command === 'logs') {
    const target = message.mentions.users.first() || (args[0] ? await client.users.fetch(args[0]).catch(() => null) : null);
    if (!target) return message.reply('User not found.');

    const userLogs = logs[target.id] || [];
    if (userLogs.length === 0) return message.reply('No logs found for this user.');

    const embed = new EmbedBuilder()
      .setTitle(`Logs for ${target.tag}`)
      .setColor(0x00ff00);

    userLogs.slice(-10).forEach((log, i) => {
      embed.addFields({ name: `${log.action} - ${new Date(log.timestamp).toLocaleDateString()}`, value: `Reason: ${log.reason}\nModerator: ${log.moderator}` });
    });

    message.reply({ embeds: [embed] });
  }

  if (command === 'punish') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    const target = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
    if (!target) return message.reply('User not found.');

    try {
      for (const channelId of config.punishChats) {
        const channel = message.guild.channels.cache.get(channelId);
        if (channel) {
          await channel.permissionOverwrites.edit(target, {
            ViewChannel: false,
            SendMessages: false,
            Connect: false
          });
        }
      }
      message.reply(`Punished ${target.user.tag} by removing access to configured chats.`);
      addLog(target.id, 'Punishment (Restrict)', 'Channel access removed', message.author.tag);
      logToChannel(message.guild, 'Punishment', `User: ${target.user.tag}\nAction: Restricted from chats\nModerator: ${message.author.tag}`);
    } catch (err) {
      message.reply('Failed to punish user.');
    }
  }

  if (command === 'unpunish') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    const target = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
    if (!target) return message.reply('User not found.');

    try {
      for (const channelId of config.punishChats) {
        const channel = message.guild.channels.cache.get(channelId);
        if (channel) {
          await channel.permissionOverwrites.delete(target);
        }
      }
      message.reply(`Unpunished ${target.user.tag}.`);
      logToChannel(message.guild, 'Unpunish', `User: ${target.user.tag}\nModerator: ${message.author.tag}`);
    } catch (err) {
      message.reply('Failed to unpunish user.');
    }
  }

  // Custom Builder Command (Discohook JSON)
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

  // Interactive Banner Command
  if (command === 'banner' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    const embed = new EmbedBuilder()
      .setTitle('Painel Interativo')
      .setDescription('Selecione uma opção abaixo para interagir com o bot.')
      .setImage('https://i.imgur.com/u8x3N0Z.gif') // Example GIF
      .setColor(0x5865F2);

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('btn_info')
          .setLabel('Informações')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('ℹ️'),
        new ButtonBuilder()
          .setCustomId('btn_help')
          .setLabel('Ajuda')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🆘')
      );

    const menuRow = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('menu_select')
          .setPlaceholder('Escolha uma categoria...')
          .addOptions([
            { label: 'Suporte', description: 'Abra um ticket de suporte', value: 'opt_support', emoji: '🎫' },
            { label: 'Denúncia', description: 'Faça uma denúncia', value: 'opt_report', emoji: '🚫' },
            { label: 'Feedback', description: 'Envie sua sugestão', value: 'opt_feedback', emoji: '💡' }
          ])
      );

    await message.channel.send({ embeds: [embed], components: [row, menuRow] });
    if (message.deletable) message.delete().catch(() => {});
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

// API Endpoints for Lovable Integration
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'No data provided' });
  config = { ...config, ...req.body };
  saveConfig();
  res.json({ message: 'Config updated successfully', config });
});

app.get('/api/logs', (req, res) => {
  res.json(logs);
});

app.get('/api/stats', (req, res) => {
  res.json({
    guilds: client.guilds.cache.size,
    users: client.users.cache.size,
    uptime: client.uptime,
    ready: client.isReady()
  });
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Server running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
