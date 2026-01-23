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
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
app.use(helmet()); // Proteção de headers
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'http://localhost:8080',
      'https://kisekai-dashboard.vercel.app', // Adicione outros se tiver
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Limite de requisições: 1000 por 15 minutos
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});
app.use('/api/', limiter);

// Middleware de Autenticação da API
const authMiddleware = async (req, res, next) => {
  // Excluir rotas de autenticação da verificação
  if (req.path.startsWith('/auth/')) return next();

  const apiKey = req.headers['x-api-key'];
  const masterKey = process.env.API_KEY;
  const token = req.cookies.token;
  
  // 1. Verificar API Key (para chamadas externas/bot)
  if (apiKey && masterKey && apiKey === masterKey) {
    return next();
  }

  // 2. Verificar JWT (para Dashboard)
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Verificar se o usuário ainda tem o cargo obrigatório ou é o dono
      const authorizedGuildId = "1438658038612623534";
      const dashboardRoleID = "1464264578773811301";
      const guild = client.guilds.cache.get(authorizedGuildId);
      
      let hasRealTimeAccess = false;
      if (guild) {
        if (decoded.id === guild.ownerId) {
          hasRealTimeAccess = true;
        } else {
          const member = await guild.members.fetch(decoded.id).catch(() => null);
          if (member && member.roles.cache.has(dashboardRoleID)) {
            hasRealTimeAccess = true;
          }
        }
      }

      if (hasRealTimeAccess) {
        req.user = decoded;
        // Log access
        await addLog(decoded.id, 'Dashboard Access', `Acessou o dashboard`, 'System').catch(console.error);
        return next();
      }
      return res.status(403).json({ error: 'Acesso negado: Você não tem o cargo necessário para acessar o dashboard.' });
    } catch (err) {
      // Token inválido, continua para erro 401
    }
  }

  if (!masterKey && !token) {
    console.error('ERRO CRÍTICO: API_KEY não definida no arquivo .env!');
    return res.status(500).json({ error: 'Erro interno de configuração de segurança.' });
  }

  return res.status(401).json({ error: 'Acesso negado: Autenticação inválida ou ausente.' });
};

// Aplicar autenticação em todas as rotas de API
app.use('/api/', authMiddleware);

// Supabase Connection
if (!process.env.DATABASE_URL) {
  console.error('ERRO CRÍTICO: DATABASE_URL não definida nas variáveis de ambiente!');
  process.exit(1);
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERRO CRÍTICO: SUPABASE_SERVICE_ROLE_KEY não definida no arquivo .env!');
  console.error('Obtenha essa chave em: Project Settings > API > service_role (secret)');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const supabaseUrl = process.env.SUPABASE_URL || `https://${process.env.DATABASE_URL.split('@')[1].split('.')[0]}.supabase.co`;
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
let usersCache = {
  data: null,
  lastFetched: 0
};

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
      CREATE TABLE IF NOT EXISTS dashboard_access (
        user_id TEXT PRIMARY KEY,
        is_admin BOOLEAN DEFAULT FALSE,
        granted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS linked_accounts (
        user_id TEXT PRIMARY KEY,
        linked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sweepstakes (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        start_time TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMPTZ NOT NULL,
        result_time TIMESTAMPTZ,
        max_participants INTEGER,
        winners_count INTEGER DEFAULT 1,
        status TEXT DEFAULT 'active',
        winners JSONB DEFAULT '[]',
        config JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS sweepstakes_participants (
        id SERIAL PRIMARY KEY,
        sweepstake_id INTEGER REFERENCES sweepstakes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        registered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(sweepstake_id, user_id)
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
        prefix: "/",
        messages: {},
        antiSpam: { enabled: false, interval: 2000, limit: 5, action: "mute", autoPunish: true },
        punishChats: [],
        reportChannel: "1463183940809392269",
        punishmentChannel: "1463186111458443450",
        sweepstakeChannel: "1464266529058193429",
        adminRole: "",
        customEmbeds: {
          welcome: { enabled: false, channel: "1438658039656743024", title: "Bem-vindo!", description: "Bem-vindo ao servidor, {user}!", color: "#00ff00" },
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
// Interaction Handler
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.emoji.name !== '🎉') return;

  const messageId = reaction.message.id;
  try {
    const { rows } = await pool.query('SELECT * FROM sweepstakes WHERE message_id = $1 AND status = $2', [messageId, 'active']);
    if (rows.length === 0) return;
    const sweepstake = rows[0];

    const now = new Date();
    if (new Date(sweepstake.end_time) < now) {
      await reaction.users.remove(user.id).catch(() => null);
      return user.send({ content: "❌ Este sorteio já encerrou o período de inscrições." }).catch(() => null);
    }

    // Check link
    const linkCheck = await pool.query('SELECT * FROM linked_accounts WHERE user_id = $1', [user.id]);
    if (linkCheck.rows.length === 0) {
      await reaction.users.remove(user.id).catch(() => null);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
      return user.send({ content: `❌ Você precisa vincular sua conta ao bot para participar! Clique aqui: ${frontendUrl}/sweepstakes` }).catch(() => null);
    }

    // Check max participants
    if (sweepstake.max_participants) {
      const countCheck = await pool.query('SELECT COUNT(*) FROM sweepstakes_participants WHERE sweepstake_id = $1', [sweepstake.id]);
      if (parseInt(countCheck.rows[0].count) >= sweepstake.max_participants) {
        await reaction.users.remove(user.id).catch(() => null);
        return user.send({ content: "❌ O limite máximo de participantes para este sorteio foi atingido." }).catch(() => null);
      }
    }

    // Register
    await pool.query('INSERT INTO sweepstakes_participants (sweepstake_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sweepstake.id, user.id]);
    user.send({ content: "✅ Você está participando do sorteio!" }).catch(() => null);

  } catch (err) {
    console.error('Sweepstake reaction error:', err);
  }
});

app.post('/api/sweepstakes/:id/draw', async (req, res) => {
  const { id } = req.params;
  const { manualWinnerId } = req.body;

  try {
    const sweepResult = await pool.query('SELECT * FROM sweepstakes WHERE id = $1', [id]);
    if (sweepResult.rows.length === 0) return res.status(404).json({ error: 'Sorteio não encontrado' });
    const sweepstake = sweepResult.rows[0];

    let winners = [];

    if (manualWinnerId) {
      winners = [manualWinnerId];
    } else {
      const participantsResult = await pool.query('SELECT user_id FROM sweepstakes_participants WHERE sweepstake_id = $1', [id]);
      const participants = participantsResult.rows.map(r => r.user_id);
      
      if (participants.length === 0) return res.status(400).json({ error: 'Nenhum participante' });

      const count = Math.min(sweepstake.winners_count || 1, participants.length);
      for (let i = 0; i < count; i++) {
        const randomIndex = Math.floor(Math.random() * participants.length);
        winners.push(participants.splice(randomIndex, 1)[0]);
      }
    }

    await pool.query('UPDATE sweepstakes SET winners = $1, status = $2 WHERE id = $3', [JSON.stringify(winners), 'ended', id]);

    // Notifications
    for (const winnerId of winners) {
      const winner = await client.users.fetch(winnerId).catch(() => null);
      if (winner) {
        winner.send({ content: `🎊 PARABÉNS! Você ganhou o sorteio: **${sweepstake.title}**!` }).catch(() => null);
      }
    }

    // Send result to channel
    const channel = await client.channels.fetch(sweepstake.channel_id).catch(() => null);
    if (channel) {
      const winnersMention = winners.map(w => `<@${w}>`).join(', ');
      channel.send({ content: `🎉 O sorteio **${sweepstake.title}** terminou!\n🏆 Ganhadores: ${winnersMention}` });
    }

    res.json({ success: true, winners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// --- DISCORD OAUTH2 AUTHENTICATION ---
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'kisekai-secret-key';

app.get('/api/auth/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  try {
    const params = new URLSearchParams();
    params.append('client_id', DISCORD_CLIENT_ID);
    params.append('client_secret', DISCORD_CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', DISCORD_REDIRECT_URI);

    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenResponse.data.access_token;

    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const userData = userResponse.data;
    
    // Check access
    const authorizedGuildId = "1438658038612623534";
    const dashboardRoleID = "1464264578773811301";
    const guild = client.guilds.cache.get(authorizedGuildId);
    let hasAccess = false;
    let role = 'user';

    if (guild) {
      if (userData.id === guild.ownerId) {
        hasAccess = true;
        role = 'owner';
      } else {
        const member = await guild.members.fetch(userData.id).catch(() => null);
        if (member && member.roles.cache.has(dashboardRoleID)) {
          hasAccess = true;
          role = 'admin'; // Or check DB if specific admin/moderator roles are still needed
        }
      }
    }

    const token = jwt.sign({ 
      id: userData.id, 
      username: userData.username, 
      avatar: userData.avatar,
      hasAccess,
      role
    }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, { 
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 
    });

    // Redirect based on access
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
    const redirectUrl = hasAccess ? `${frontendUrl}/` : `${frontendUrl}/support`;
    res.redirect(redirectUrl);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ 
      authenticated: true, 
      id: decoded.id,
      username: decoded.username,
      avatar: decoded.avatar,
      hasAccess: decoded.hasAccess,
      role: decoded.role
    });
  } catch (err) {
    res.status(401).json({ authenticated: false });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// --- DASHBOARD ACCESS MANAGEMENT ---
app.get('/api/access', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dashboard_access ORDER BY granted_at DESC');
    
    // Enrich with user details from Discord
    const enrichedResults = await Promise.all(result.rows.map(async (row) => {
      try {
        const user = await client.users.fetch(row.user_id);
        return {
          id: row.user_id,
          username: user.username,
          avatar: user.avatar,
          grantedAt: row.granted_at,
          isAdmin: row.is_admin
        };
      } catch (err) {
        return {
          id: row.user_id,
          username: 'Usuário Desconhecido',
          avatar: null,
          grantedAt: row.granted_at,
          isAdmin: row.is_admin
        };
      }
    }));

    res.json(enrichedResults);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/access/grant', async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono do servidor pode conceder acesso.' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    await pool.query(
      'INSERT INTO dashboard_access (user_id, is_admin) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET is_admin = $2',
      [userId, true]
    );

    // Give Discord Role
    const authorizedGuildId = "1438658038612623534";
    const dashboardRoleID = "1464264578773811301";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (guild) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        await member.roles.add(dashboardRoleID).catch(console.error);
      }
    }

    res.json({ success: true, message: 'Acesso concedido e cargo atribuído.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/access/revoke', async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono do servidor pode revogar acesso.' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    await pool.query('DELETE FROM dashboard_access WHERE user_id = $1', [userId]);

    // Remove Discord Role
    const authorizedGuildId = "1438658038612623534";
    const dashboardRoleID = "1464264578773811301";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (guild) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        await member.roles.remove(dashboardRoleID).catch(console.error);
      }
    }

    res.json({ success: true, message: 'Acesso revogado e cargo removido.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.get('/api/stats', async (req, res) => {
  let dbHealthy = false;
  try {
    const dbCheck = await pool.query('SELECT 1');
    if (dbCheck) dbHealthy = true;
  } catch (e) {
    dbHealthy = false;
  }

  const gatewayStatusMap = {
    0: 'Online',
    1: 'Conectando',
    2: 'Reconectando',
    3: 'Inativo',
    4: 'Inicializando',
    5: 'Desconectado',
    6: 'Aguardando Guildas',
    7: 'Identificando',
    8: 'Retomando'
  };

  res.json({
    servers: client.guilds.cache.size,
    users: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
    uptime: client.uptime,
    uptimeFormatted: ms(client.uptime || 0, { long: true }),
    lastRestart: new Date(Date.now() - (client.uptime || 0)).toISOString(),
    apiStatus: 'Online',
    gatewayStatus: gatewayStatusMap[client.ws.status] || 'Desconhecido',
    dbStatus: dbHealthy ? 'Saudável' : 'Instável'
  });
});

app.get('/api/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  try {
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    
    if (!guild) {
      return res.status(404).json({ error: 'Servidor não encontrado ou bot não carregado.' });
    }

    const members = await guild.members.fetch({ query: q, limit: 20 });
    const results = members.map(m => ({
      id: m.user.id,
      username: m.user.username,
      globalName: m.user.globalName, // Nome da conta (Display Name global)
      displayName: m.displayName,     // Apelido no servidor
      avatarURL: m.user.displayAvatarURL({ dynamic: true, size: 256 })
    }));

    res.json(results);
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ error: 'Erro ao buscar usuários.' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos
    const now = Date.now();

    if (usersCache.data && (now - usersCache.lastFetched < CACHE_DURATION)) {
      return res.json(usersCache.data);
    }

    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    
    if (!guild) {
      return res.status(404).json({ error: 'Servidor não encontrado ou bot não carregado.' });
    }

    // Fetch all members with a timeout for safety
    const members = await guild.members.fetch({ withPresences: false }).catch(err => {
      console.error('Error fetching members:', err);
      throw err;
    });

    const results = members.map(m => ({
      id: m.user.id,
      username: m.user.username,
      globalName: m.user.globalName,
      displayName: m.displayName,
      avatar: m.user.avatar,
      avatarURL: m.user.displayAvatarURL({ size: 256 }),
      isBot: m.user.bot,
      isApp: m.user.bot, // Categorizando como APP se for bot
      isOwner: m.id === guild.ownerId
    })).sort((a, b) => {
      if (a.isOwner) return -1;
      if (b.isOwner) return 1;
      return a.username.localeCompare(b.username);
    });

    // Update cache
    usersCache.data = results;
    usersCache.lastFetched = now;

    res.json(results);
  } catch (err) {
    console.error('Get all users error details:', {
      message: err.message,
      stack: err.stack,
      code: err.code
    });

    // If fetch fails but we have old cache, return it as fallback
    if (usersCache.data) {
      console.log('Returning stale cache due to fetch error');
      return res.json(usersCache.data);
    }

    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

app.post('/api/users/reload/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const member = await guild.members.fetch(userId);
    const userData = {
      id: member.user.id,
      username: member.user.username,
      globalName: member.user.globalName,
      displayName: member.displayName,
      avatar: member.user.avatar,
      avatarURL: member.user.displayAvatarURL({ size: 256 }),
      isBot: member.user.bot,
      isApp: member.user.bot,
      isOwner: member.id === guild.ownerId
    };

    // Update specific user in cache if cache exists
    if (usersCache.data) {
      const index = usersCache.data.findIndex(u => u.id === userId);
      if (index !== -1) {
        usersCache.data[index] = userData;
      } else {
        usersCache.data.push(userData);
      }
    }

    res.json(userData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.post('/api/reports/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { action, reason, duration, moderator } = req.body;

  if (!['kick', 'ban', 'mute', 'warn', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Ação inválida' });
  }

  try {
    const reportResult = await pool.query('SELECT * FROM reports WHERE id = $1', [id]);
    if (reportResult.rows.length === 0) return res.status(404).json({ error: 'Reporte não encontrado' });
    const report = reportResult.rows[0];

    if (action === 'reject') {
      await pool.query("UPDATE reports SET status = 'rejected' WHERE id = $1", [id]);
      return res.json({ success: true, message: 'Reporte rejeitado' });
    }

    // Process moderation action
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (!guild) return res.status(500).json({ error: 'Guild not found' });

    const member = await guild.members.fetch(report.reported_id).catch(() => null);
    const user = member ? member.user : await client.users.fetch(report.reported_id).catch(() => null);

    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    let actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
    
    switch (action) {
      case 'kick':
        if (!member) return res.status(400).json({ error: 'Membro não está no servidor' });
        await member.kick(reason || 'Kicked via Report Resolution');
        break;
      case 'ban':
        await guild.members.ban(report.reported_id, { reason: reason || 'Banned via Report Resolution' });
        break;
      case 'mute':
        if (!member) return res.status(400).json({ error: 'Membro não está no servidor' });
        await member.timeout(duration ? ms(duration) : ms('10m'), reason || 'Muted via Report Resolution');
        break;
      case 'warn':
        actionLabel = 'Warning';
        break;
    }

    await addLog(report.reported_id, actionLabel, reason || 'Punição via Reporte', moderator || 'Dashboard');
    await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [id]);

    // Send to punishments channel
    if (config.punishmentChannel && config.customEmbeds?.punishment?.enabled) {
      const punChannel = guild.channels.cache.get(config.punishmentChannel);
      if (punChannel) {
        const embed = createCustomEmbed(config.customEmbeds.punishment, {
          action: actionLabel,
          user_tag: user.tag,
          user_id: report.reported_id,
          moderator: moderator || 'Dashboard',
          reason: reason || 'Punição via Reporte',
          duration: duration || 'N/A',
          reporter_id: report.reporter_id
        });
        if (report.image_url) embed.setImage(report.image_url);
        await punChannel.send({ embeds: [embed] });
      }
    }

    res.json({ success: true, message: `Reporte resolvido com ação: ${actionLabel}` });
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

app.get('/api/moderation/punishments', async (req, res) => {
  try {
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const bans = await guild.bans.fetch();
    const formattedBans = bans.map(b => ({
      type: 'ban',
      userId: b.user.id,
      username: b.user.username,
      reason: b.reason,
      avatarURL: b.user.displayAvatarURL()
    }));

    // For mutes, we need to fetch all members and check for communicationDisabledUntil
    const members = await guild.members.fetch();
    const mutes = members.filter(m => m.communicationDisabledUntil && m.communicationDisabledUntil > new Date());
    const formattedMutes = mutes.map(m => ({
      type: 'mute',
      userId: m.user.id,
      username: m.user.username,
      reason: 'N/A (Timeout ativo)',
      avatarURL: m.user.displayAvatarURL(),
      endsAt: m.communicationDisabledUntil
    }));

    res.json({ bans: formattedBans, mutes: formattedMutes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/moderation/unban', async (req, res) => {
  const { userId } = req.body;
  try {
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    await guild.members.unban(userId);
    res.json({ success: true, message: 'Usuário desbanido' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/moderation/history', async (req, res) => {
  try {
    const kicks = await pool.query("SELECT * FROM logs WHERE action = 'Kick' ORDER BY timestamp DESC");
    const warns = await pool.query("SELECT * FROM logs WHERE action = 'Warning' ORDER BY timestamp DESC");
    
    // Group warnings by user
    const warnHistory = {};
    for (const row of warns.rows) {
      if (!warnHistory[row.user_id]) {
        try {
          const user = await client.users.fetch(row.user_id);
          warnHistory[row.user_id] = {
            userId: row.user_id,
            username: user.username,
            avatarURL: user.displayAvatarURL(),
            warnings: []
          };
        } catch (e) {
          warnHistory[row.user_id] = {
            userId: row.user_id,
            username: 'Unknown',
            warnings: []
          };
        }
      }
      warnHistory[row.user_id].warnings.push({
        id: row.id,
        reason: row.reason,
        moderator: row.moderator,
        timestamp: row.timestamp
      });
    }

    res.json({ 
      kicks: kicks.rows, 
      warnHistory: Object.values(warnHistory) 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/moderation/history/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query("SELECT * FROM logs WHERE user_id = $1 AND action = 'Warning' ORDER BY timestamp DESC", [userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SWEEPSTAKES SYSTEM ---
app.get('/api/sweepstakes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sweepstakes ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sweepstakes', async (req, res) => {
  const { title, description, endTime, maxParticipants, winnersCount, channelId } = req.body;
  const authorizedGuildId = "1438658038612623534";
  const guild = client.guilds.cache.get(authorizedGuildId);
  
  if (!guild) return res.status(500).json({ error: 'Guild not found' });
  const channel = guild.channels.cache.get(channelId || config.sweepstakeChannel);
  if (!channel) return res.status(400).json({ error: 'Canal de sorteio não configurado' });

  try {
    const result = await pool.query(
      'INSERT INTO sweepstakes (guild_id, channel_id, title, description, end_time, max_participants, winners_count) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [authorizedGuildId, channel.id, title, description, endTime, maxParticipants, winnersCount]
    );
    const sweepstake = result.rows[0];

    const embed = new EmbedBuilder()
      .setTitle(`🎉 SORTEIO: ${title}`)
      .setDescription(`${description}\n\n**Ganhadores:** ${winnersCount}\n**Termina em:** <t:${Math.floor(new Date(endTime).getTime() / 1000)}:R>\n\nReaja com 🎉 para participar!`)
      .setColor('#ff00ea')
      .setFooter({ text: `ID: ${sweepstake.id} | Máx: ${maxParticipants || 'Ilimitado'}` });

    const message = await channel.send({ embeds: [embed] });
    await message.react('🎉');

    await pool.query('UPDATE sweepstakes SET message_id = $1 WHERE id = $2', [message.id, sweepstake.id]);
    sweepstake.message_id = message.id;

    res.json(sweepstake);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sweepstakes/:id/participants', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sp.*, u.username, u.avatar 
      FROM sweepstakes_participants sp
      -- Tentaremos enriquecer depois se não tivermos uma tabela de usuários, 
      -- por enquanto pegamos o que temos
      WHERE sp.sweepstake_id = $1
    `, [req.params.id]);
    
    const enriched = await Promise.all(result.rows.map(async (row) => {
      try {
        const user = await client.users.fetch(row.user_id);
        return {
          ...row,
          username: user.username,
          avatarURL: user.displayAvatarURL()
        };
      } catch (e) {
        return row;
      }
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sweepstakes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT channel_id, message_id FROM sweepstakes WHERE id = $1', [req.params.id]);
    if (rows.length > 0) {
      const { channel_id, message_id } = rows[0];
      const channel = await client.channels.fetch(channel_id).catch(() => null);
      if (channel && message_id) {
        const msg = await channel.messages.fetch(message_id).catch(() => null);
        if (msg) await msg.delete().catch(() => null);
      }
    }
    await pool.query('DELETE FROM sweepstakes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sweepstakes/link-account', async (req, res) => {
  const { userId } = req.body; // In real app, get from req.user
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    await pool.query('INSERT INTO linked_accounts (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    res.json({ success: true, message: 'Conta vinculada com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sweepstakes/check-link/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM linked_accounts WHERE user_id = $1', [req.params.userId]);
    res.json({ linked: result.rows.length > 0 });
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

app.get('/api/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM templates ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, data } = req.body;
    const result = await pool.query('INSERT INTO templates (name, data) VALUES ($1, $2) RETURNING *', [name, data]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM templates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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