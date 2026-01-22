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
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(helmet()); // Proteção de headers
app.use(express.json());
app.use(cors());

// Limite de requisições: 100 por 15 minutos
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});
app.use('/api/', limiter);

// Middleware de Autenticação da API
const authMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const masterKey = process.env.API_KEY;
  
  if (!masterKey) {
    console.error('ERRO CRÍTICO: API_KEY não definida no arquivo .env!');
    return res.status(500).json({ error: 'Erro interno de configuração de segurança.' });
  }

  if (!apiKey || apiKey !== masterKey) {
    return res.status(401).json({ error: 'Acesso negado: API Key inválida ou ausente.' });
  }
  next();
};

// Aplicar autenticação em todas as rotas de API
app.use('/api/', authMiddleware);

// Supabase Connection
if (!process.env.DATABASE_URL) {
  console.error('ERRO CRÍTICO: DATABASE_URL não definida nas variáveis de ambiente!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const supabase = createClient(
  process.env.SUPABASE_URL || `https://${process.env.DATABASE_URL.split('@')[1].split('.')[0]}.supabase.co`,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
        status TEXT DEFAULT 'pending',
        deleted_at TIMESTAMPTZ,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      -- Migration for existing tables
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='status') THEN
          ALTER TABLE reports ADD COLUMN status TEXT DEFAULT 'pending';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='deleted_at') THEN
          ALTER TABLE reports ADD COLUMN deleted_at TIMESTAMPTZ;
        END IF;
      END $$;
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
          reportFeedback: { enabled: true, title: "Reporte Enviado", description: "Seu reporte contra {user} foi recebido com sucesso.", color: "#ffff00" },
          resolvedReport: { enabled: true, title: "✅ Reporte Bem-Sucedido", description: "Um reporte foi analisado e o usuário foi punido.", color: "#00ff00", fields: [{ name: "👤 Usuário Punido", value: "{reported_tag}", inline: true }, { name: "🚩 Motivo", value: "{reason}", inline: false }] },
          punishment: { enabled: true, title: "⚖️ Nova Punição: {action}", color: "#ff0000", fields: [{ name: "👤 Punido", value: "{user_tag}", inline: true }, { name: "🛡️ Moderador", value: "{moderator}", inline: true }, { name: "📝 Motivo", value: "{reason}", inline: false }, { name: "⏳ Duração", value: "{duration}", inline: true }] },
          logs: { enabled: true, title: "[{type}]", description: "{description}", color: "#ffff00" }
        }
      };
      await client.query('INSERT INTO configs (data) VALUES ($1)', [config]);
    } else {
      config = res.rows[0].data;
    }

    // Limpeza periódica de reportes (30 dias na lixeira)
    const cleanupReports = async () => {
      try {
        const { rows: reportsToDelete } = await pool.query(
          "SELECT image_url FROM reports WHERE status = 'deleted' AND deleted_at < NOW() - INTERVAL '30 days'"
        );

        for (const report of reportsToDelete) {
          if (report.image_url && report.image_url.includes('storage/v1/object/public/reports/')) {
            const fileName = report.image_url.split('/').pop();
            await supabase.storage.from('reports').remove([fileName]);
          }
        }

        await pool.query("DELETE FROM reports WHERE status = 'deleted' AND deleted_at < NOW() - INTERVAL '30 days'");
        console.log('Limpeza de lixeira de reportes concluída.');
      } catch (err) {
        console.error('Erro na limpeza da lixeira:', err);
      }
    };

    cleanupReports();
    setInterval(cleanupReports, 24 * 60 * 60 * 1000); // A cada 24 horas

    // Ensure storage bucket exists
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find(b => b.name === 'reports')) {
      await supabase.storage.createBucket('reports', { public: true });
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
  if (!config.logChannel || !config.customEmbeds?.logs?.enabled) return;
  const channel = guild.channels.cache.get(config.logChannel);
  if (!channel) return;

  const embed = createCustomEmbed(config.customEmbeds.logs, {
    type,
    description,
    guild: guild.name
  });

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
  
  // Security: Leave unauthorized guilds
  const authorizedGuildId = "1438658038612623534";
  client.guilds.cache.forEach(guild => {
    if (guild.id !== authorizedGuildId) {
      console.log(`Saindo de servidor não autorizado: ${guild.name} (${guild.id})`);
      guild.leave();
    }
  });

  // Register Slash Commands... (mantendo o resto igual)
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

// Security: Block joining new guilds
client.on('guildCreate', guild => {
  if (guild.id !== "1438658038612623534") {
    console.log(`Tentativa de entrada em servidor não autorizado: ${guild.name}`);
    guild.leave();
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
            const duration = config.antiSpam.muteTime || '10m';
            await message.member.timeout(ms(duration), 'Auto-Mod: Anti-Spam');
            
            if (config.customEmbeds?.warmute?.enabled) {
              const embed = createCustomEmbed(config.customEmbeds.warmute, {
                user: message.author.toString(),
                duration: duration
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
      if (!config.reportChannel) {
        return interaction.reply({ content: "O sistema de reportes não está configurado. Por favor, configure um canal no dashboard.", ephemeral: true });
      }

      if (interaction.channelId !== config.reportChannel) {
        return interaction.reply({ content: `Este comando só pode ser usado no canal <#${config.reportChannel}>`, ephemeral: true });
      }

      const reportedUser = interaction.options.getUser('usuario');
      const reason = interaction.options.getString('motivo');
      const attachment = interaction.options.getAttachment('prova');

      try {
        await interaction.deferReply({ ephemeral: true });

        let finalImageUrl = attachment.url;

        // Download and Upload to Supabase
        try {
          const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
          const fileExt = attachment.name.split('.').pop();
          const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
          
          const { error } = await supabase.storage
            .from('reports')
            .upload(fileName, response.data, {
              contentType: attachment.contentType,
              upsert: false
            });

          if (error) throw error;

          const { data: { publicUrl } } = supabase.storage
            .from('reports')
            .getPublicUrl(fileName);
          
          finalImageUrl = publicUrl;
        } catch (uploadError) {
          console.error('Error uploading to Supabase:', uploadError);
          // Fallback to original URL if upload fails
        }

        await pool.query(
          'INSERT INTO reports (reporter_id, reported_id, reason, image_url) VALUES ($1, $2, $3, $4)',
          [interaction.user.id, reportedUser.id, reason, finalImageUrl]
        );

        const embed = createCustomEmbed(config.customEmbeds.reportFeedback || {
          title: "Reporte Enviado",
          description: `Seu reporte contra ${reportedUser.toString()} foi recebido com sucesso.`,
          color: "#ffff00"
        }, {
          user: reportedUser.toString(),
          username: reportedUser.username
        });

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('Report error:', err);
        if (interaction.deferred) {
          await interaction.editReply({ content: 'Ocorreu um erro ao processar seu reporte.' });
        } else {
          await interaction.reply({ content: 'Ocorreu um erro ao processar seu reporte.', ephemeral: true });
        }
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
    const { status } = req.query;
    let query = 'SELECT * FROM reports';
    const params = [];

    if (status) {
      params.push(status);
      query += ' WHERE status = $1';
    } else {
      query += " WHERE status != 'deleted'";
    }

    query += ' ORDER BY timestamp DESC';
    const result = await pool.query(query, params);
    
    const reportsWithDetails = await Promise.all(result.rows.map(async (report) => {
      const reporter = await client.users.fetch(report.reporter_id).catch(() => null);
      const reported = await client.users.fetch(report.reported_id).catch(() => null);

      return {
        ...report,
        reporter: reporter ? {
          username: reporter.username,
          avatarURL: reporter.displayAvatarURL(),
          id: reporter.id
        } : { username: "Desconhecido", id: report.reporter_id },
        reported: reported ? {
          username: reported.username,
          avatarURL: reported.displayAvatarURL(),
          id: reported.id
        } : { username: "Desconhecido", id: report.reported_id }
      };
    }));

    res.json(reportsWithDetails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/reports/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'pending', 'resolved', 'rejected'

  if (!['pending', 'resolved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }

  try {
    const result = await pool.query(
      'UPDATE reports SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reporte não encontrado' });
    }

    const report = result.rows[0];

    // Se resolvido, notificar no canal de punidos
    if (status === 'resolved' && config.punishmentChannel && config.customEmbeds?.resolvedReport?.enabled) {
      const guild = client.guilds.cache.get(config.guildId || "1438658038612623534");
      if (guild) {
        const punChannel = guild.channels.cache.get(config.punishmentChannel);
        if (punChannel) {
          const reportedUser = await client.users.fetch(report.reported_id).catch(() => null);
          
          const embed = createCustomEmbed(config.customEmbeds.resolvedReport, {
            reported_tag: reportedUser ? reportedUser.tag : report.reported_id,
            reported_id: report.reported_id,
            reason: report.reason
          });

          if (report.image_url) embed.setImage(report.image_url);
          
          await punChannel.send({ embeds: [embed] });
        }
      }
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reports/:id', async (req, res) => {
  const { id } = req.params;
  const { permanent } = req.query;

  try {
    if (permanent === 'true') {
      // Hard delete: delete image from storage and then delete from DB
      const { rows } = await pool.query('SELECT image_url FROM reports WHERE id = $1', [id]);
      
      if (rows.length > 0 && rows[0].image_url && rows[0].image_url.includes('storage/v1/object/public/reports/')) {
        const fileName = rows[0].image_url.split('/').pop();
        await supabase.storage.from('reports').remove([fileName]);
      }

      const result = await pool.query('DELETE FROM reports WHERE id = $1 RETURNING *', [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reporte não encontrado' });
      }

      return res.json({ message: 'Reporte deletado permanentemente', report: result.rows[0] });
    } else {
      // Soft delete (trash)
      const result = await pool.query(
        "UPDATE reports SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reporte não encontrado' });
      }

      return res.json({ message: 'Reporte enviado para a lixeira', report: result.rows[0] });
    }
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
    if (config.punishmentChannel && config.customEmbeds?.punishment?.enabled) {
      const punChannel = guild.channels.cache.get(config.punishmentChannel);
      if (punChannel) {
        const embed = createCustomEmbed(config.customEmbeds.punishment, {
          action: actionLabel,
          user_tag: user.tag,
          user_id: userId,
          moderator: moderator || 'Dashboard',
          reason: reason || 'Não informado',
          duration: duration || 'N/A',
          reporter_id: reporterId || 'N/A'
        });

        if (evidenceUrl) embed.setImage(evidenceUrl);
        await punChannel.send({ embeds: [embed] });
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