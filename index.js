require('dotenv').config();
const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
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
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(cors());

// Supabase Connection
if (!process.env.DATABASE_URL) {
  console.error('ERRO CRÍTICO: DATABASE_URL não definida nas variáveis de ambiente!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let config = {};
const spamMap = new Map();

// Database Initialization
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS configs (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        moderator TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_id TEXT NOT NULL,
        reported_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        image_url TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const res = await client.query('SELECT data FROM configs LIMIT 1');
    if (res.rows.length === 0) {
      config = {
        prefix: "!",
        messages: {},
        antiSpam: { enabled: false, interval: 2000, limit: 5, action: "mute", autoPunish: true },
        punishChats: [],
        reportChannel: "",
        punishmentChannel: "",
        customEmbeds: {
          welcome: { enabled: false, channel: "", title: "Bem-vindo!", description: "Bem-vindo ao servidor, {user}!", color: "#00ff00" },
          warmute: { enabled: false, title: "Aviso de Mute", description: "Você foi mutado por spam.", color: "#ff0000" },
          reportFeedback: { enabled: true, title: "Reporte Enviado", description: "Seu reporte contra {user} foi recebido com sucesso.", color: "#ffff00" }
        }
      };
      await client.query('INSERT INTO configs (data) VALUES ($1)', [config]);
    } else {
      config = res.rows[0].data;
    }
  } finally {
    client.release();
  }
}

async function saveConfig() {
  await pool.query('UPDATE configs SET data = $1 WHERE id = (SELECT id FROM configs LIMIT 1)', [config]);
}

async function addLog(userId, action, reason, moderator) {
  await pool.query(
    'INSERT INTO logs (user_id, action, reason, moderator) VALUES ($1, $2, $3, $4)',
    [userId, action, reason, moderator]
  );
}

function getMessage(key, placeholders = {}) {
  let msg = config.messages?.[key] || "Message not found.";
  for (const [k, v] of Object.entries(placeholders)) {
    msg = msg.replace(`{${k}}`, v);
  }
  return msg;
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

function createCustomEmbed(data, placeholders = {}) {
  const embed = new EmbedBuilder();
  
  const replacePlaceholders = (str) => {
    if (typeof str !== 'string') return str;
    let newStr = str;
    for (const [k, v] of Object.entries(placeholders)) {
      newStr = newStr.replace(new RegExp(`{${k}}`, 'g'), v);
    }
    return newStr;
  };

  if (data.title) embed.setTitle(replacePlaceholders(data.title));
  if (data.description) embed.setDescription(replacePlaceholders(data.description));
  if (data.url) embed.setURL(data.url);
  if (data.color) {
    try {
      embed.setColor(data.color);
    } catch (e) {
      embed.setColor("#7289da");
    }
  }
  if (data.timestamp) embed.setTimestamp(data.timestamp === true ? new Date() : new Date(data.timestamp));

  if (data.author) {
    embed.setAuthor({
      name: replacePlaceholders(data.author.name || ""),
      iconURL: data.author.icon_url || data.author.iconURL,
      url: data.author.url
    });
  }

  if (data.footer) {
    embed.setFooter({
      text: replacePlaceholders(data.footer.text || ""),
      iconURL: data.footer.icon_url || data.footer.iconURL
    });
  }

  if (data.image) embed.setImage(typeof data.image === 'string' ? data.image : data.image.url);
  if (data.thumbnail) embed.setThumbnail(typeof data.thumbnail === 'string' ? data.thumbnail : data.thumbnail.url);

  if (data.fields && Array.isArray(data.fields)) {
    const formattedFields = data.fields.map(f => ({
      name: replacePlaceholders(f.name || "\u200b"),
      value: replacePlaceholders(f.value || "\u200b"),
      inline: !!f.inline
    }));
    embed.addFields(formattedFields);
  }

  return embed;
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Register Slash Commands
  const commands = [
    {
      name: 'reportar',
      description: 'Reporta um usuário por má conduta',
      options: [
        {
          name: 'usuario',
          type: 6, // USER
          description: 'O usuário que você deseja reportar',
          required: true
        },
        {
          name: 'motivo',
          type: 3, // STRING
          description: 'O motivo do reporte',
          required: true
        },
        {
          name: 'prova',
          type: 11, // ATTACHMENT
          description: 'Imagem ou vídeo provando a conduta',
          required: true
        }
      ]
    }
  ];

  try {
    await client.application.commands.set(commands);
    console.log('Slash commands registered!');
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }
});

// Auto-role and Welcome on join
client.on('guildMemberAdd', async member => {
  if (config.autoRole) {
    const role = member.guild.roles.cache.get(config.autoRole);
    if (role) {
      try {
        await member.roles.add(role);
        await logToChannel(member.guild, 'Auto-Role', `Added auto-role to ${member.user.tag}`);
      } catch (err) {
        console.error('Error adding auto-role:', err);
      }
    }
  }

  if (config.customEmbeds?.welcome?.enabled && config.customEmbeds.welcome.channel) {
    const channel = member.guild.channels.cache.get(config.customEmbeds.welcome.channel);
    if (channel) {
      const embed = createCustomEmbed(config.customEmbeds.welcome, {
        user: member.user.toString(),
        username: member.user.username,
        guild: member.guild.name,
        memberCount: member.guild.memberCount.toString()
      });
      channel.send({ embeds: [embed] }).catch(console.error);
    }
  }
});

// Message listener
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (config.antiSpam && config.antiSpam.enabled && !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
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
            
            if (config.customEmbeds?.warmute?.enabled) {
              const embed = createCustomEmbed(config.customEmbeds.warmute, {
                user: message.author.toString(),
                duration: config.antiSpam.muteTime || '10m'
              });
              message.channel.send({ embeds: [embed] });
            } else {
              message.channel.send(`${message.author}, você foi mutado por spam.`);
            }
          } else if (config.antiSpam.action === 'kick') {
            await message.member.kick('Auto-Mod: Anti-Spam');
          }
          await addLog(message.author.id, 'Auto-Punish (Spam)', `Action: ${config.antiSpam.action}`, 'System');
          await logToChannel(message.guild, 'Auto-Mod', `User: ${message.author.tag} punished for spamming.\nAction: ${config.antiSpam.action}`);
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
});

// Interaction Handler
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'reportar') {
      if (config.reportChannel && interaction.channelId !== config.reportChannel) {
        return interaction.reply({ content: `Este comando só pode ser usado no canal <#${config.reportChannel}>`, ephemeral: true });
      }

      const reportedUser = interaction.options.getUser('usuario');
      const reason = interaction.options.getString('motivo');
      const attachment = interaction.options.getAttachment('prova');

      try {
        await pool.query(
          'INSERT INTO reports (reporter_id, reported_id, reason, image_url) VALUES ($1, $2, $3, $4)',
          [interaction.user.id, reportedUser.id, reason, attachment.url]
        );

        const embed = createCustomEmbed(config.customEmbeds.reportFeedback || {
          title: "Reporte Enviado",
          description: `Seu reporte contra ${reportedUser.toString()} foi recebido com sucesso.`,
          color: "#ffff00"
        }, {
          user: reportedUser.toString(),
          username: reportedUser.username
        });

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (err) {
        console.error('Report error:', err);
        await interaction.reply({ content: 'Ocorreu um erro ao processar seu reporte.', ephemeral: true });
      }
    }
  }

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

// API Endpoints
app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', async (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'No data provided' });
  config = { ...config, ...req.body };
  await saveConfig();
  res.json({ message: 'Config updated successfully', config });
});

app.get('/api/logs', async (req, res) => {
  const { startDate, endDate, limit, offset } = req.query;
  try {
    let query = 'SELECT * FROM logs';
    const params = [];
    const conditions = [];

    if (startDate) {
      params.push(startDate);
      conditions.push(`timestamp >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      conditions.push(`timestamp <= $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY timestamp DESC';

    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    }
    if (offset) {
      params.push(parseInt(offset));
      query += ` OFFSET $${params.length}`;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json({
    servers: client.guilds.cache.size,
    users: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
    uptime: client.uptime,
    uptimeFormatted: ms(client.uptime, { long: true }),
    lastRestart: new Date(Date.now() - client.uptime).toISOString()
  });
});

app.get('/api/reports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reports ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/moderate/:action', async (req, res) => {
  const { action } = req.params;
  const { userId, reason, duration, moderator, evidenceUrl, reporterId } = req.body;
  const guildId = client.guilds.cache.first()?.id;

  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const guild = client.guilds.cache.get(req.body.guildId || guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const member = await guild.members.fetch(userId).catch(() => null);
    const user = member ? member.user : await client.users.fetch(userId).catch(() => null);

    if (!user) return res.status(404).json({ error: 'User not found' });

    let actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
    
    switch (action) {
      case 'kick':
        if (!member) return res.status(400).json({ error: 'Member not in guild' });
        await member.kick(reason || 'Kicked via Dashboard');
        break;
      case 'ban':
        await guild.members.ban(userId, { reason: reason || 'Banned via Dashboard' });
        break;
      case 'mute':
        if (!member) return res.status(400).json({ error: 'Member not in guild' });
        await member.timeout(duration ? ms(duration) : ms('10m'), reason || 'Muted via Dashboard');
        break;
      case 'warn':
        actionLabel = 'Warning';
        break;
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    await addLog(userId, actionLabel, reason || 'Action via Dashboard', moderator || 'Dashboard');
    
    // Log to standard channel
    await logToChannel(guild, actionLabel, `User: ${user.tag}\nReason: ${reason || 'No reason'}\nModerator: ${moderator || 'Dashboard'}`);

    // Log to Punishments Channel
    if (config.punishmentChannel) {
      const punChannel = guild.channels.cache.get(config.punishmentChannel);
      if (punChannel) {
        const punEmbed = new EmbedBuilder()
          .setTitle(`⚖️ Nova Punição: ${actionLabel}`)
          .addFields(
            { name: '👤 Punido', value: `${user.tag} (${userId})`, inline: true },
            { name: '🛡️ Moderador', value: moderator || 'Dashboard', inline: true },
            { name: '📝 Motivo', value: reason || 'Não informado' },
            { name: '⏳ Tempo/Duração', value: duration || 'N/A', inline: true },
            { name: '🚩 Reportado por', value: reporterId ? `<@${reporterId}>` : 'N/A', inline: true }
          )
          .setColor(0xff0000)
          .setTimestamp();

        if (evidenceUrl) punEmbed.setImage(evidenceUrl);
        await punChannel.send({ embeds: [punEmbed] });
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  const { channelId, content, embeds } = req.body;
  if (!channelId) return res.status(400).json({ error: 'Missing channelId' });

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const payload = { content, embeds: embeds?.map(e => createCustomEmbed(e)) };
    await channel.send(payload);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  const { name, data } = req.body;
  const result = await pool.query('INSERT INTO templates (name, data) VALUES ($1, $2) RETURNING *', [name, data]);
  res.json(result.rows[0]);
});

app.delete('/api/templates/:id', async (req, res) => {
  await pool.query('DELETE FROM templates WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/restart', (req, res) => {
  res.status(200).json({ message: 'Reiniciando o bot...' });
  console.log('Comando de reinicialização recebido. Encerrando em 2 segundos...');
  setTimeout(() => {
    process.exit(1); // Saída com erro para forçar o Railway a reiniciar
  }, 2000);
});

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  client.login(process.env.DISCORD_TOKEN);
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});