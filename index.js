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
  ComponentType,
  MessageFlags
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
const multer = require('multer');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Confiar no proxy (Cloudflare, Vercel, etc.)
app.use(helmet()); // Proteção de headers
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'http://localhost:8080',
      'http://localhost:3000',
      'https://kisekai-dashboard.vercel.app', // Adicione outros se tiver
      process.env.FRONTEND_URL,
      process.env.DASHBOARD_URL
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Multer setup for temporary storage
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Limite de requisições: 1000 por 15 minutos
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});
app.use('/api/', limiter);

// Middleware de Autenticação da API
const authMiddleware = async (req, res, next) => {
  // Excluir apenas rotas de login da verificação
  if (
    req.path.startsWith('/auth/login') ||
    req.path.startsWith('/auth/callback') ||
    req.path.startsWith('/auth/me') ||
    req.path.startsWith('/auth/logout')
  ) return next();

  const apiKey = req.headers['x-api-key'];
  const masterKey = process.env.API_KEY;
  const token = getSessionTokenFromRequest(req);
  
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
      const dashboardRoleID = config.adminRole || "1464264578773811301";
      const guild = client.guilds.cache.get(authorizedGuildId);
      
      let hasRealTimeAccess = false;
      let discordAccessCheckUnavailable = false;

      if (!guild) {
        // O bot pode estar iniciando/reconectando: evita falso negativo temporário.
        discordAccessCheckUnavailable = true;
      } else {
        if (decoded.id === guild.ownerId) {
          hasRealTimeAccess = true;
        } else {
          // 1. Verificar cargo no Discord
          const member = await guild.members.fetch(decoded.id).catch(() => null);
          if (member && member.roles.cache.has(dashboardRoleID)) {
            hasRealTimeAccess = true;
          }
          // 2. Fallback: verificar tabela dashboard_access no banco
          if (!hasRealTimeAccess) {
            const dbCheck = await pool.query('SELECT user_id FROM dashboard_access WHERE user_id = $1', [decoded.id]).catch(() => null);
            if (dbCheck && dbCheck.rows.length > 0) {
              hasRealTimeAccess = true;
              // Tentar re-adicionar o cargo se o membro estiver no servidor
              if (member) {
                member.roles.add(dashboardRoleID).catch(() => null);
              }
            }
          }
        }
      }

      // Fallback extra: validação por banco mesmo sem guild em cache.
      if (!hasRealTimeAccess) {
        const dbCheck = await pool.query('SELECT user_id FROM dashboard_access WHERE user_id = $1', [decoded.id]).catch(() => null);
        if (dbCheck && dbCheck.rows.length > 0) {
          hasRealTimeAccess = true;
        }
      }

      if (hasRealTimeAccess) {
        req.user = decoded;
        return next();
      }

      // Se a checagem do Discord estiver indisponível (startup/reconnect),
      // não bloquear temporariamente usuários já autenticados no JWT.
      if (discordAccessCheckUnavailable && decoded.hasAccess) {
        req.user = decoded;
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

// Lógica corrigida para extrair a URL do Supabase do DATABASE_URL se não estiver definida
let supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl && process.env.DATABASE_URL) {
  const match = process.env.DATABASE_URL.match(/postgres\.([^@:]+)/);
  if (match && match[1]) {
    supabaseUrl = `https://${match[1]}.supabase.co`;
  }
}

if (!supabaseUrl) {
  console.error('ERRO: SUPABASE_URL não definida e não pôde ser extraída do DATABASE_URL');
}

const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences
  ]
});

let config = {};
const spamMap = new Map();
let usersCache = {
  data: null,
  lastFetched: 0
};
const userProfileCache = new Map();
const USER_PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 min
let statsCache = {
  data: null,
  lastFetched: 0
};
const STATS_CACHE_TTL = 15 * 1000; // 15s

function getSessionTokenFromRequest(req) {
  const cookieToken = req.cookies?.token;
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
  const headerToken = req.headers['x-session-token'];

  return cookieToken || bearerToken || headerToken || null;
}

function getCookieOptions(req, maxAge = 7 * 24 * 60 * 60 * 1000) {
  const requestHost = (req.get('host') || '').toLowerCase();

  // Regra robusta:
  // - Backend local (localhost/127.0.0.1): usa Lax para funcionar sem HTTPS local
  // - Backend remoto (ex: Railway): força None+Secure para permitir cookies cross-site no dashboard
  const isLocalBackend = requestHost.includes('localhost') || requestHost.includes('127.0.0.1');

  if (!isLocalBackend) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge
    };
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const frontendUrl = process.env.FRONTEND_URL || process.env.DASHBOARD_URL;
  let isCrossSite = false;

  try {
    if (origin && requestHost) {
      const originHost = new URL(origin).host;
      isCrossSite = originHost !== requestHost;
    } else if (referer && requestHost) {
      const refererHost = new URL(referer).host;
      isCrossSite = refererHost !== requestHost;
    } else if (frontendUrl && requestHost) {
      // Importante para OAuth callback: normalmente não há Origin no redirect final.
      const frontendHost = new URL(frontendUrl).host;
      isCrossSite = frontendHost !== requestHost;
    }
  } catch (e) {
    isCrossSite = false;
  }

  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';

  return {
    httpOnly: true,
    secure: isCrossSite ? true : (process.env.NODE_ENV === 'production' || isHttps),
    sameSite: isCrossSite ? 'none' : 'lax',
    maxAge
  };
}

function getClearCookieOptions(req) {
  const options = getCookieOptions(req, 0);
  return {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
  };
}

async function getCachedDiscordUserSummary(userId) {
  const cached = userProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const user = await client.users.fetch(userId).catch(() => null);
  const value = {
    username: user ? user.username : 'Desconhecido',
    avatarURL: user ? user.displayAvatarURL() : null,
  };

  userProfileCache.set(userId, {
    value,
    expiresAt: Date.now() + USER_PROFILE_CACHE_TTL,
  });

  return value;
}

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
        data JSONB NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        hidden_for TEXT[] DEFAULT '{}',
        deletion_requested_by TEXT[] DEFAULT '{}'
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
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='logs' AND column_name='type') THEN
          ALTER TABLE logs ADD COLUMN type TEXT DEFAULT 'Administrativa';
        ELSE
          UPDATE logs SET type = 'Administrativa' WHERE type = 'Admin' OR type = 'Administrador';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='storage_path') THEN
          ALTER TABLE reports ADD COLUMN storage_path TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='rejected_at') THEN
          ALTER TABLE reports ADD COLUMN rejected_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='logs' AND column_name='duration') THEN
          ALTER TABLE logs ADD COLUMN duration TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='created_by') THEN
          ALTER TABLE templates ADD COLUMN created_by TEXT;
          UPDATE templates SET created_by = 'legacy' WHERE created_by IS NULL;
          ALTER TABLE templates ALTER COLUMN created_by SET NOT NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='created_by_username') THEN
          ALTER TABLE templates ADD COLUMN created_by_username TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='created_at') THEN
          ALTER TABLE templates ADD COLUMN created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
          UPDATE templates SET created_at = NOW() WHERE created_at IS NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='updated_at') THEN
          ALTER TABLE templates ADD COLUMN updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
          UPDATE templates SET updated_at = NOW() WHERE updated_at IS NULL;
        END IF;
      END $$;
    `);

    const res = await client.query('SELECT data FROM configs LIMIT 1');
    if (res.rows.length === 0) {
      config = {
        prefix: "/",
        autoRole: "1464397173167882334",
        messages: {},
        antiSpam: { enabled: false, interval: 2000, limit: 5, action: "mute", autoPunish: true },
        punishChats: [],
        reportChannel: "1463183940809392269",
        punishmentChannel: "1463186111458443450",
        sweepstakeChannel: "1464266529058193429",
        adminRole: "1464264578773811301",
        customEmbeds: {
          welcome: { enabled: false, channel: "1438658039656743024", title: "Bem-vindo!", description: "Bem-vindo ao servidor, {user}!", color: "#00ff00" },
          reportFeedback: { enabled: true, title: "Reporte Enviado", description: "Seu reporte contra {user} foi recebido com sucesso.", color: "#ffff00" },
          resolvedReport: { enabled: true, title: "✅ Reporte Bem-Sucedido", description: "Um reporte foi analisado e o usuário foi punido.", color: "#00ff00", fields: [{ name: "👤 Usuário Punido", value: "{reported_tag}", inline: true }, { name: "🚩 Motivo", value: "{reason}", inline: false }] }
        }
      };
      await client.query('INSERT INTO configs (data) VALUES ($1)', [config]);
    } else {
      config = res.rows[0].data;
      // Ensure requested defaults are set even in existing config if they were empty
      let updated = false;
      if (!config.adminRole || config.adminRole === "") {
        config.adminRole = "1464264578773811301";
        updated = true;
      }
      if (!config.autoRole || config.autoRole === "") {
        config.autoRole = "1464397173167882334";
        updated = true;
      }
      if (updated) {
        await saveConfig();
      }
    }

    // Limpeza periódica de reportes
    const cleanupReports = async () => {
      try {
        // 1. Mover reportes para a lixeira após 7 dias
        await pool.query(
          "UPDATE reports SET status = 'deleted', deleted_at = NOW() WHERE status != 'deleted' AND timestamp < NOW() - INTERVAL '7 days'"
        );
        console.log('Limpeza automática concluída: reportes antigos enviados para a lixeira.');
      } catch (err) {
        console.error('Erro na limpeza de reportes:', err);
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

async function addLog(userId, action, reason, moderator, type = 'Administrativa', duration = null) {
  try {
    await pool.query(
      'INSERT INTO logs (user_id, action, reason, moderator, type, duration) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, action, reason, moderator, type, duration]
    );
  } catch (err) {
    console.error('Error in addLog:', err);
    throw err;
  }
}

function getMessage(key, placeholders = {}) {
  let msg = config.messages?.[key] || "Message not found.";
  for (const [k, v] of Object.entries(placeholders)) {
    msg = msg.replace(`{${k}}`, v);
  }
  return msg;
}

async function uploadToSupabase(fileBuffer, fileName, contentType) {
  try {
    const { data, error } = await supabase.storage
      .from('reports')
      .upload(fileName, fileBuffer, {
        contentType: contentType,
        upsert: true
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('reports')
      .getPublicUrl(fileName);

    return { publicUrl, storagePath: fileName };
  } catch (err) {
    console.error('Supabase upload error:', err);
    return null;
  }
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
  
  const authorizedGuildId = "1438658038612623534";
  const guild = client.guilds.cache.get(authorizedGuildId);
  if (guild) {
    try {
      await guild.members.fetch({ withPresences: true });
      console.log(`Membros e presenças carregados para a guilda: ${guild.name}`);
    } catch (err) {
      console.error(`Erro ao carregar membros da guilda ${guild.name}:`, err);
    }
  }

  // Security: Leave unauthorized guilds
  client.guilds.cache.forEach(g => {
    if (g.id !== authorizedGuildId) {
      console.log(`Saindo de servidor não autorizado: ${g.name} (${g.id})`);
      g.leave();
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
client.on('guildCreate', async guild => {
  if (guild.id !== "1438658038612623534") {
    console.log(`Tentativa de entrada em servidor não autorizado: ${guild.name}`);
    guild.leave();
    return;
  }
});

// Auto-role and Welcome on join
client.on('guildMemberAdd', async member => {
  // Nunca alterar cargos de bots (inclusive o próprio bot convidado com permissões de admin)
  if (member.user.bot) return;

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
      const botCount = member.guild.members.cache.filter(m => m.user.bot).size;
      const humanCount = member.guild.memberCount - botCount;
      
      const embed = createCustomEmbed(config.customEmbeds.welcome, {
        user: member.user.toString(),
        username: member.user.username,
        userId: member.user.id,
        userType: member.user.bot ? 'APP' : 'Membro',
        botTag: member.user.bot ? ' [APP]' : '',
        guild: member.guild.name,
        memberCount: humanCount.toString(),
        botCount: botCount.toString(),
        totalCount: member.guild.memberCount.toString()
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
          await addLog(message.author.id, 'Auto-Punish (Spam)', `Action: ${config.antiSpam.action}`, 'System', 'System');
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
        return interaction.reply({ content: "O sistema de reportes não está configurado. Por favor, configure um canal no dashboard.", flags: [MessageFlags.Ephemeral] });
      }

      if (interaction.channelId !== config.reportChannel) {
        return interaction.reply({ content: `Este comando só pode ser usado no canal <#${config.reportChannel}>`, flags: [MessageFlags.Ephemeral] });
      }

      const reportedUser = interaction.options.getUser('usuario');
      const reason = interaction.options.getString('motivo');
      const attachment = interaction.options.getAttachment('prova');

      try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        let finalImageUrl = attachment.url;
        let storagePath = null;

        // Download and Upload to Supabase
        try {
          const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
          const fileExt = attachment.name.split('.').pop();
          const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
          
          const uploadResult = await uploadToSupabase(response.data, fileName, attachment.contentType);
          if (uploadResult) {
            finalImageUrl = uploadResult.publicUrl;
            storagePath = uploadResult.storagePath;
          }
        } catch (uploadError) {
          console.error('Error processing attachment:', uploadError);
        }

        await pool.query(
          'INSERT INTO reports (reporter_id, reported_id, reason, image_url, storage_path) VALUES ($1, $2, $3, $4, $5)',
          [interaction.user.id, reportedUser.id, reason, finalImageUrl, storagePath]
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
          await interaction.reply({ content: 'Ocorreu um erro ao processar seu reporte.', flags: [MessageFlags.Ephemeral] });
        }
      }
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'btn_info') {
      await interaction.reply({ content: 'Este é um bot multifuncional desenvolvido para Kisekai.', flags: [MessageFlags.Ephemeral] });
    } else if (interaction.customId === 'btn_help') {
      await interaction.reply({ content: 'Use `!help` para ver a lista de comandos ou entre em contato com a staff.', flags: [MessageFlags.Ephemeral] });
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'menu_select') {
      const selected = interaction.values[0];
      await interaction.reply({ content: `Você selecionou: ${selected}. Esta função será implementada em breve!`, flags: [MessageFlags.Ephemeral] });
    }
  }
});

// --- DISCORD OAUTH2 AUTHENTICATION ---
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'kisekai-secret-key';

async function getLiveDashboardAccess(userId) {
  const authorizedGuildId = "1438658038612623534";
  const dashboardRoleID = config.adminRole || "1464264578773811301";
  const guild = client.guilds.cache.get(authorizedGuildId);

  let hasAccess = false;
  let role = 'user';

  if (guild) {
    if (userId === guild.ownerId) {
      hasAccess = true;
      role = 'owner';
    } else {
      const member = await guild.members.fetch(userId).catch(() => null);

      // 1. Verificar cargo no Discord
      if (member && member.roles.cache.has(dashboardRoleID)) {
        hasAccess = true;
        role = 'admin';
      }

      // 2. Fallback: verificar tabela dashboard_access no banco
      if (!hasAccess) {
        const dbCheck = await pool.query('SELECT user_id FROM dashboard_access WHERE user_id = $1', [userId]).catch(() => null);
        if (dbCheck && dbCheck.rows.length > 0) {
          hasAccess = true;
          role = 'admin';

          // Tentar re-adicionar o cargo se o membro estiver no servidor
          if (member) {
            member.roles.add(dashboardRoleID).catch(() => null);
          }
        }
      }
    }
  } else {
    // Bot pode estar reiniciando/reconectando: manter fallback por banco.
    const dbCheck = await pool.query('SELECT user_id FROM dashboard_access WHERE user_id = $1', [userId]).catch(() => null);
    if (dbCheck && dbCheck.rows.length > 0) {
      hasAccess = true;
      role = 'admin';
    }
  }

  return {
    hasAccess,
    role,
    guildAvailable: !!guild
  };
}

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
    
    // Check access (tempo real)
    const { hasAccess, role } = await getLiveDashboardAccess(userData.id);

    if (hasAccess) {
      await addLog(userData.id, 'Login Dashboard', `Admin logou no dashboard`, 'System', 'System').catch(console.error);
    }

    const token = jwt.sign({ 
      id: userData.id, 
      username: userData.username, 
      avatar: userData.avatar,
      hasAccess,
      role
    }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, getCookieOptions(req));

    // Redirect based on access
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
    const redirectUrl = hasAccess
      ? `${frontendUrl}/?session=${encodeURIComponent(token)}`
      : `${frontendUrl}/suporte?session=${encodeURIComponent(token)}`;
    res.redirect(redirectUrl);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const liveAccess = await getLiveDashboardAccess(decoded.id);

    let hasAccess = liveAccess.hasAccess;
    let role = liveAccess.role;

    // Se Discord ainda não estiver disponível, evita falso negativo temporário
    // usando o estado já conhecido no token.
    if (!liveAccess.guildAvailable && !liveAccess.hasAccess) {
      hasAccess = Boolean(decoded.hasAccess);
      role = decoded.role || 'user';
    }

    // Atualizar token quando o acesso mudar (ex: recebeu cargo após login)
    if (hasAccess !== Boolean(decoded.hasAccess) || role !== (decoded.role || 'user')) {
      const refreshedToken = jwt.sign({
        id: decoded.id,
        username: decoded.username,
        avatar: decoded.avatar,
        hasAccess,
        role
      }, JWT_SECRET, { expiresIn: '7d' });

      res.cookie('token', refreshedToken, getCookieOptions(req));
    }

    res.json({ 
      authenticated: true, 
      id: decoded.id,
      username: decoded.username,
      avatar: decoded.avatar,
      hasAccess,
      role
    });
  } catch (err) {
    res.status(401).json({ authenticated: false });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      await addLog(decoded.id, 'Logout Dashboard', `Usuário saiu do dashboard`, 'System', 'System').catch(console.error);
    } catch (e) {}
  }
  res.clearCookie('token', getClearCookieOptions(req));
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
          globalName: user.globalName,
          avatar: user.avatar,
          avatarURL: user.displayAvatarURL({ size: 256 }),
          grantedAt: row.granted_at,
          isAdmin: row.is_admin
        };
      } catch (err) {
        return {
          id: row.user_id,
          username: 'Usuário Desconhecido',
          globalName: null,
          avatar: null,
          avatarURL: null,
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
  // Somente o dono do servidor pode conceder acesso
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono do servidor pode conceder acesso ao dashboard.' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    await pool.query(
      'INSERT INTO dashboard_access (user_id, is_admin) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET is_admin = $2',
      [userId, true]
    );

    // Give Discord Role - forçar fetch para garantir que o membro está atualizado
    const authorizedGuildId = "1438658038612623534";
    const dashboardRoleID = config.adminRole || "1464264578773811301";
    const guild = client.guilds.cache.get(authorizedGuildId);
    let roleAdded = false;
    if (guild) {
      try {
        const member = await guild.members.fetch({ user: userId, force: true });
        if (member) {
          await member.roles.add(dashboardRoleID);
          roleAdded = true;
        }
      } catch (roleErr) {
        console.error(`Erro ao adicionar cargo para ${userId}:`, roleErr.message);
      }
    }

    res.json({ 
      success: true, 
      message: roleAdded 
        ? 'Acesso concedido e cargo atribuído com sucesso.' 
        : 'Acesso concedido no banco, mas o cargo não pôde ser atribuído (usuário pode não estar no servidor).'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/access/revoke', async (req, res) => {
  // Somente o dono do servidor pode revogar acesso
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono do servidor pode revogar acesso ao dashboard.' });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    await pool.query('DELETE FROM dashboard_access WHERE user_id = $1', [userId]);

    // Remove Discord Role - forçar fetch para garantir que o membro está atualizado
    const authorizedGuildId = "1438658038612623534";
    const dashboardRoleID = config.adminRole || "1464264578773811301";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (guild) {
      try {
        const member = await guild.members.fetch({ user: userId, force: true });
        if (member) {
          await member.roles.remove(dashboardRoleID);
        }
      } catch (roleErr) {
        console.error(`Erro ao remover cargo de ${userId}:`, roleErr.message);
      }
    }

    res.json({ success: true, message: 'Acesso revogado e cargo removido.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/access/:userId/logs', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM logs WHERE user_id = $1 AND action IN ('Login Dashboard', 'Logout Dashboard', 'Admin logou no dashboard') ORDER BY timestamp DESC LIMIT 50",
      [userId]
    );
    res.json(result.rows);
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
  const { startDate, endDate, limit, offset, type, userId } = req.query;
  try {
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
    if (type && type !== 'all') {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }
    if (userId) {
      params.push(userId);
      conditions.push(`user_id = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    // Count total
    const totalResult = await pool.query(`SELECT COUNT(*) FROM logs${whereClause}`, params);
    const total = parseInt(totalResult.rows[0].count);

    // Fetch logs
    let query = `SELECT * FROM logs${whereClause} ORDER BY timestamp DESC`;
    
    const limitInt = parseInt(limit) || 20;
    const offsetInt = parseInt(offset) || 0;

    params.push(limitInt);
    query += ` LIMIT $${params.length}`;
    
    params.push(offsetInt);
    query += ` OFFSET $${params.length}`;

    const result = await pool.query(query, params);

    const logs = await Promise.all(result.rows.map(async (log) => {
      const userSummary = await getCachedDiscordUserSummary(log.user_id);
      return {
        id: log.id,
        action: log.action,
        userId: log.user_id,
        username: userSummary.username,
        avatar: userSummary.avatarURL,
        avatarURL: userSummary.avatarURL,
        moderator: log.moderator,
        reason: log.reason,
        timestamp: log.timestamp,
        type: log.type,
        duration: log.duration
      };
    }));

    res.json({
      logs,
      total,
      hasMore: offsetInt + logs.length < total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  if (statsCache.data && (Date.now() - statsCache.lastFetched < STATS_CACHE_TTL)) {
    return res.json(statsCache.data);
  }

  let dbHealthy = false;
  try {
    const dbCheck = await pool.query('SELECT 1');
    if (dbCheck) dbHealthy = true;
  } catch (e) {
    dbHealthy = false;
  }

  const gatewayStatusMap = {
    0: 'Online', 1: 'Conectando', 2: 'Reconectando', 3: 'Inativo',
    4: 'Inicializando', 5: 'Desconectado', 6: 'Aguardando Guildas',
    7: 'Identificando', 8: 'Retomando'
  };

  const authorizedGuildId = "1438658038612623534";
  let guild = client.guilds.cache.get(authorizedGuildId);
  
  if (guild) {
    // Garantir que os dados do servidor (boosts, etc) estejam atualizados
    try {
      await guild.fetch();
    } catch (e) {
      console.error("Erro ao atualizar guilda:", e);
    }

    // Garantir membros e presenças em cache (fetch a cada 1 minuto para maior precisão no dashboard)
    if (!guild.lastMemberFetch || (Date.now() - guild.lastMemberFetch > 60000)) {
      try {
        await guild.members.fetch({ withPresences: true });
        guild.lastMemberFetch = Date.now();
      } catch (e) {
        console.error("Erro ao carregar membros:", e);
      }
    }
  }

  // Filtragem precisa de humanos e bots
  const allMembers = guild ? guild.members.cache : new Collection();
  const humanMembers = allMembers.filter(m => !m.user.bot);
  const botMembers = allMembers.filter(m => m.user.bot);
  
  const onlineHumans = humanMembers.filter(m => m.presence?.status && m.presence.status !== 'offline').size;
  const offlineHumans = humanMembers.size - onlineHumans;

  const serverInfo = guild ? {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ dynamic: true }),
    memberCount: guild.memberCount,
    onlineCount: onlineHumans,
    offlineCount: offlineHumans,
    botCount: botMembers.size,
    boostCount: guild.premiumSubscriptionCount || 0,
    channelCount: guild.channels.cache.size
  } : null;

  const statsPayload = {
    servers: client.guilds.cache.size,
    users: humanMembers.size,
    onlineUsers: onlineHumans,
    botCount: botMembers.size,
    uptime: client.uptime,
    uptimeFormatted: ms(client.uptime || 0, { long: true }),
    lastRestart: new Date(Date.now() - (client.uptime || 0)).toISOString(),
    apiStatus: 'Online',
    gatewayStatus: gatewayStatusMap[client.ws.status] || 'Desconhecido',
    dbStatus: dbHealthy ? 'Saudável' : 'Instável',
    serverInfo
  };

  statsCache = {
    data: statsPayload,
    lastFetched: Date.now()
  };

  res.json(statsPayload);
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await client.users.fetch(req.params.id);
    res.json({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      avatarURL: user.displayAvatarURL()
    });
  } catch (err) {
    res.status(404).json({ error: 'Usuário não encontrado' });
  }
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

    const members = await guild.members.fetch({ query: q, limit: 20, withPresences: true });
    const results = members.map(m => ({
      id: m.user.id,
      username: m.user.username,
      globalName: m.user.globalName, // Nome da conta (Display Name global)
      displayName: m.displayName,     // Apelido no servidor
      avatarURL: m.user.displayAvatarURL({ dynamic: true, size: 256 }),
      status: m.presence?.status || 'offline'
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

    // Fetch all members with presences
    let members;
    let lastFetchError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        members = await guild.members.fetch({ withPresences: true });
        lastFetchError = null;
        break;
      } catch (err) {
        lastFetchError = err;
        console.error(`Error fetching members (attempt ${attempt}/3):`, err?.message || err);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
      }
    }

    if (!members) {
      throw lastFetchError || new Error('Falha ao carregar membros do Discord.');
    }

    const results = members.map(m => ({
      id: m.user.id,
      username: m.user.username,
      globalName: m.user.globalName,
      displayName: m.displayName,
      avatar: m.user.avatar,
      avatarURL: m.user.displayAvatarURL({ size: 256 }),
      status: m.presence?.status || 'offline',
      isBot: m.user.bot,
      isApp: m.user.bot,
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

    res.status(503).json({ error: 'Discord indisponível no momento. Tente novamente em instantes.' });
  }
});

app.post('/api/users/reload/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const member = await guild.members.fetch({ user: userId, withPresences: true });
    const userData = {
      id: member.user.id,
      username: member.user.username,
      globalName: member.user.globalName,
      displayName: member.displayName,
      avatar: member.user.avatar,
      avatarURL: member.user.displayAvatarURL({ size: 256 }),
      status: member.presence?.status || 'offline',
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

    if (status && status !== 'all') {
      params.push(status);
      query += ' WHERE status = $1';
    } else {
      query += " WHERE status != 'deleted'";
    }

    query += ' ORDER BY timestamp DESC';
    const result = await pool.query(query, params);

    const reports = await Promise.all(result.rows.map(async (report) => {
      const reporter = await client.users.fetch(report.reporter_id).catch(() => null);
      const reported = await client.users.fetch(report.reported_id).catch(() => null);

      return {
        ...report,
        reporter: {
          id: report.reporter_id,
          username: reporter ? reporter.username : 'Desconhecido',
          avatarURL: reporter ? reporter.displayAvatarURL() : null
        },
        reported: {
          id: report.reported_id,
          username: reported ? reported.username : 'Desconhecido',
          avatarURL: reported ? reported.displayAvatarURL() : null
        }
      };
    }));

    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reports', upload.single('image'), async (req, res) => {
  const { reportedUserId, reportedUsername, reason } = req.body;
  const reporterId = req.user?.id || 'Dashboard';

  if (!reportedUserId || !reason) {
    return res.status(400).json({ error: 'Missing reportedUserId or reason' });
  }

  try {
    let imageUrl = null;
    let storagePath = null;

    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const uploadResult = await uploadToSupabase(req.file.buffer, fileName, req.file.mimetype);
      
      if (uploadResult) {
        imageUrl = uploadResult.publicUrl;
        storagePath = uploadResult.storagePath;
      }
    }

    const result = await pool.query(
      'INSERT INTO reports (reporter_id, reported_id, reason, image_url, storage_path) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [reporterId, reportedUserId, reason, imageUrl, storagePath]
    );

    res.json({ success: true, report: result.rows[0] });
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
      await pool.query("UPDATE reports SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
      return res.json({ success: true, message: 'Reporte rejeitado' });
    }

    // Process moderation action
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    if (!guild) return res.status(500).json({ error: 'Guild not found' });

    const member = await guild.members.fetch(report.reported_id).catch(() => null);
    const user = member ? member.user : await client.users.fetch(report.reported_id).catch(() => null);

    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    let actionLabel = action; // Use lowercase to match frontend
    
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
        // Warn is already set to 'warn'
        try {
          const warnEmbed = new EmbedBuilder()
            .setTitle('⚠️ Advertência Recebida')
            .setDescription(`Você recebeu uma advertência no servidor **${guild.name}**.`)
            .addFields(
              { name: 'Motivo', value: reason || 'Punição via Reporte' },
              { name: 'Moderador', value: moderator || 'Dashboard' }
            )
            .setColor('#ffff00')
            .setTimestamp();
          await user.send({ embeds: [warnEmbed] });
        } catch (e) {
          console.error(`Não foi possível enviar DM para ${user.tag}`);
        }
        break;
    }

    await addLog(report.reported_id, actionLabel, reason || 'Punição via Reporte', moderator || 'Dashboard', 'Administrativa', duration);
    await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [id]);

    // Send to punishments channel (Skip if action is warn)
    if (action !== 'warn' && config.punishmentChannel && config.customEmbeds?.punishment?.enabled) {
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
    let query = 'UPDATE reports SET status = $1';
    const params = [status, id];

    if (status === 'rejected') {
      query += ', rejected_at = CURRENT_TIMESTAMP';
    } else {
      query += ', rejected_at = NULL';
    }

    query += ' WHERE id = $2 RETURNING *';

    const result = await pool.query(query, params);

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
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono do servidor pode enviar para lixeira ou excluir reportes.' });
  }

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

app.post('/api/reports/bulk-delete', async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono do servidor pode enviar para lixeira ou excluir reportes.' });
  }

  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'IDs inválidos' });

  try {
    // Permanent delete if they are already in the trash
    const { rows: currentReports } = await pool.query('SELECT id, status, image_url FROM reports WHERE id = ANY($1)', [ids]);
    
    const reportsInTrash = currentReports.filter(r => r.status === 'deleted');
    const reportsToTrash = currentReports.filter(r => r.status !== 'deleted');

    let deletedCount = 0;

    // 1. Permanent delete for those already in trash
    if (reportsInTrash.length > 0) {
      const trashIds = reportsInTrash.map(r => r.id);
      
      // Cleanup images
      for (const report of reportsInTrash) {
        if (report.image_url && report.image_url.includes('storage/v1/object/public/reports/')) {
          const fileName = report.image_url.split('/').pop();
          await supabase.storage.from('reports').remove([fileName]).catch(console.error);
        }
      }
      
      await pool.query('DELETE FROM reports WHERE id = ANY($1)', [trashIds]);
      deletedCount += reportsInTrash.length;
    }

    // 2. Soft delete for those not in trash
    if (reportsToTrash.length > 0) {
      const activeIds = reportsToTrash.map(r => r.id);
      await pool.query("UPDATE reports SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ANY($1)", [activeIds]);
      deletedCount += reportsToTrash.length;
    }

    res.json({ success: true, message: `${deletedCount} reportes processados.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reports/trash/clear', async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono do servidor pode limpar a lixeira.' });
  }

  try {
    const { rows: reportsToDelete } = await pool.query("SELECT image_url FROM reports WHERE status = 'deleted'");
    
    // Cleanup images
    for (const report of reportsToDelete) {
      if (report.image_url && report.image_url.includes('storage/v1/object/public/reports/')) {
        const fileName = report.image_url.split('/').pop();
        await supabase.storage.from('reports').remove([fileName]).catch(console.error);
      }
    }

    const result = await pool.query("DELETE FROM reports WHERE status = 'deleted'");
    res.json({ success: true, message: `Lixeira limpa. ${result.rowCount} reportes removidos.` });
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

app.get('/api/moderation/punished-users', async (req, res) => {
  const { filter } = req.query; // ban, mute, kick, warn
  try {
    let query = `
      SELECT user_id, MAX(timestamp) as last_punishment
      FROM logs
      WHERE type = 'Administrativa' AND action != 'innocent'
    `;
    const params = [];

    if (filter) {
      query += ` AND action ILIKE $1`;
      params.push(`${filter}%`);
    }

    query += ` GROUP BY user_id ORDER BY last_punishment DESC`;

    const result = await pool.query(query, params);

    const users = await Promise.all(result.rows.map(async (row) => {
      try {
        const user = await client.users.fetch(row.user_id);
        return {
          id: user.id,
          username: user.username,
          avatarURL: user.displayAvatarURL(),
          last_punishment: row.last_punishment
        };
      } catch (e) {
        return {
          id: row.user_id,
          username: 'Unknown',
          avatarURL: null,
          last_punishment: row.last_punishment
        };
      }
    }));

    res.json(users);
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
    const kicksRaw = await pool.query("SELECT * FROM logs WHERE action ILIKE 'kick' ORDER BY timestamp DESC");
    const kicks = await Promise.all(kicksRaw.rows.map(async (row) => {
      try {
        const user = await client.users.fetch(row.user_id);
        return { ...row, username: user.username, avatarURL: user.displayAvatarURL() };
      } catch (e) {
        return { ...row, username: 'Unknown', avatarURL: null };
      }
    }));

    const warns = await pool.query("SELECT * FROM logs WHERE action ILIKE 'warn%' ORDER BY timestamp DESC");
    
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
            avatarURL: null,
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
      kicks, 
      warnHistory: Object.values(warnHistory) 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/moderation/history/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const authorizedGuildId = "1438658038612623534";
    const guild = client.guilds.cache.get(authorizedGuildId);
    
    const result = await pool.query(
      "SELECT * FROM logs WHERE user_id = $1 AND type = 'Administrativa' AND action != 'innocent' ORDER BY timestamp DESC", 
      [userId]
    );
    
    let isBanned = false;
    let isMuted = false;
    let muteEndsAt = null;

    if (guild) {
      try {
        const banInfo = await guild.bans.fetch(userId).catch(() => null);
        isBanned = !!banInfo;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && member.communicationDisabledUntil && member.communicationDisabledUntil > new Date()) {
          isMuted = true;
          muteEndsAt = member.communicationDisabledUntil;
        }
      } catch (e) {
        console.error('Error fetching Discord status:', e);
      }
    }

    const history = result.rows.map(row => {
      let status = 'Expirado';
      const action = row.action.toLowerCase();
      
      if (action === 'ban' && isBanned) {
        status = 'Em Execução';
      } else if (action === 'mute' && isMuted) {
        status = 'Em Execução';
      }

      return {
        ...row,
        status
      };
    });

    const summary = {
      bans: history.filter(h => h.action.toLowerCase() === 'ban'),
      mutes: history.filter(h => h.action.toLowerCase() === 'mute'),
      kicks: history.filter(h => h.action.toLowerCase() === 'kick'),
      warns: history.filter(h => h.action.toLowerCase().startsWith('warn'))
    };

    res.json({
      userId,
      isBanned,
      isMuted,
      muteEndsAt,
      history,
      summary
    });
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

app.post('/api/moderate/:action', upload.single('evidence'), async (req, res) => {
  const { action } = req.params;
  const { userId, reason, duration, moderator, reporterId, reportId } = req.body;
  let { evidenceUrl } = req.body;
  const guildId = client.guilds.cache.first()?.id;

  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const guild = client.guilds.cache.get(req.body.guildId || guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const member = await guild.members.fetch(userId).catch(() => null);
    const user = member ? member.user : await client.users.fetch(userId).catch(() => null);

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Handle file upload if present
    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `mod-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const uploadResult = await uploadToSupabase(req.file.buffer, fileName, req.file.mimetype);
      if (uploadResult) {
        evidenceUrl = uploadResult.publicUrl;
      }
    }

    let actionLabel = action;
    
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
        // actionLabel is already 'warn'
        try {
          const warnEmbed = new EmbedBuilder()
            .setTitle('⚠️ Advertência Recebida')
            .setDescription(`Você recebeu uma advertência no servidor **${guild.name}**.`)
            .addFields(
              { name: 'Motivo', value: reason || 'Não informado' },
              { name: 'Moderador', value: moderator || 'Dashboard' }
            )
            .setColor('#ffff00')
            .setTimestamp();
          await user.send({ embeds: [warnEmbed] });
        } catch (e) {
          console.error(`Não foi possível enviar DM para ${user.tag}`);
        }
        break;
      case 'innocent':
        // No action needed for Discord user, just database log and report resolution
        actionLabel = 'innocent';
        break;
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    await addLog(userId, actionLabel, reason || 'Action via Dashboard', moderator || 'Dashboard', 'Administrativa', duration);
    
    // Update report status if reportId is provided
    if (reportId) {
      if (action === 'innocent') {
        await pool.query("UPDATE reports SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP WHERE id = $1", [reportId]);
      } else {
        await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [reportId]);
      }
    }

    // Log to standard channel (Only for punishments)
    if (action !== 'innocent') {
      await logToChannel(guild, actionLabel, `User: ${user.tag}\nReason: ${reason || 'No reason'}\nModerator: ${moderator || 'Dashboard'}`);

      // Log to Punishments Channel (Skip if action is warn)
      if (action !== 'warn' && config.punishmentChannel && config.customEmbeds?.punishment?.enabled) {
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
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:channelId/:messageId', async (req, res) => {
  const { channelId, messageId } = req.params;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
    if (!channel.isTextBased()) return res.status(400).json({ error: 'O canal deve ser de texto' });

    const message = await channel.messages.fetch(messageId);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });

    const payload = {
      content: message.content,
      embeds: message.embeds.map(embed => ({
        title: embed.title,
        description: embed.description,
        url: embed.url,
        color: embed.hexColor,
        timestamp: embed.timestamp,
        author: embed.author ? {
          name: embed.author.name,
          iconURL: embed.author.iconURL,
          url: embed.author.url
        } : null,
        footer: embed.footer ? {
          text: embed.footer.text,
          iconURL: embed.footer.iconURL
        } : null,
        image: embed.image ? { url: embed.image.url } : null,
        thumbnail: embed.thumbnail ? { url: embed.thumbnail.url } : null,
        fields: embed.fields.map(f => ({
          name: f.name,
          value: f.value,
          inline: f.inline
        }))
      }))
    };

    res.json(payload);
  } catch (err) {
    console.error('Error fetching message:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  const { channelId, content, embeds, components } = req.body;
  if (!channelId) return res.status(400).json({ error: 'Missing channelId' });

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    // Converte components do JSON do Discord para objetos Discord.js
    const buildComponents = (rawComponents) => {
      if (!rawComponents || !Array.isArray(rawComponents)) return [];
      return rawComponents.map(row => {
        if (row.type !== 1) return null; // Apenas ActionRow (type 1)
        const actionRow = new ActionRowBuilder();
        const builtComponents = (row.components || []).map(comp => {
          if (comp.type === 2) { // Button
            const btn = new ButtonBuilder();
            if (comp.style) btn.setStyle(comp.style);
            if (comp.label) btn.setLabel(comp.label);
            if (comp.emoji) btn.setEmoji(comp.emoji);
            if (comp.disabled !== undefined) btn.setDisabled(comp.disabled);
            // Botão de link (style 5) usa URL, outros usam custom_id
            if (comp.style === 5 || comp.style === ButtonStyle.Link) {
              if (comp.url) btn.setURL(comp.url);
            } else {
              if (comp.custom_id) btn.setCustomId(comp.custom_id);
            }
            return btn;
          }
          return null;
        }).filter(Boolean);
        if (builtComponents.length === 0) return null;
        actionRow.addComponents(builtComponents);
        return actionRow;
      }).filter(Boolean);
    };

    const payload = { 
      content, 
      embeds: embeds?.map(e => createCustomEmbed(e)),
      components: buildComponents(components)
    };
    await channel.send(payload);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: Get user display info from Discord (cached)
async function getUserInfo(userId) {
  const cached = userProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const user = await client.users.fetch(userId).catch(() => null);
  const value = {
    username: user ? user.username : 'Desconhecido',
    avatarURL: user ? user.displayAvatarURL() : null,
  };

  userProfileCache.set(userId, {
    value,
    expiresAt: Date.now() + USER_PROFILE_CACHE_TTL,
  });

  return value;
}

// Helper: Check permissions for template actions
async function checkTemplatePermissions(userId, templateId) {
  const authorizedGuildId = "1438658038612623534";
  const guild = client.guilds.cache.get(authorizedGuildId);
  const dashboardRoleID = config.adminRole || "1464264578773811301";

  let isOwner = false;
  let isAdminCreator = false;
  let isCreator = false;

  if (guild) {
    if (userId === guild.ownerId) {
      isOwner = true;
    } else {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && member.roles.cache.has(dashboardRoleID)) {
        isAdminCreator = true;
      }
    }
  }

  // Check creator in DB
  const creatorResult = await pool.query('SELECT created_by FROM templates WHERE id = $1', [templateId]);
  if (creatorResult.rows.length > 0) {
    isCreator = creatorResult.rows[0].created_by === userId;
  }

  return { isOwner, isAdminCreator, isCreator };
}

// Helper: Get user role for UI indicators
async function getUserRole(userId) {
  const authorizedGuildId = "1438658038612623534";
  const guild = client.guilds.cache.get(authorizedGuildId);
  const dashboardRoleID = config.adminRole || "1464264578773811301";

  if (guild) {
    if (userId === guild.ownerId) return 'owner';
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && member.roles.cache.has(dashboardRoleID)) return 'admin';
  }
  return 'user';
}

// Templates API with permissions
app.get('/api/templates', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, date, byMe } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }
    if (date) {
      params.push(date);
      conditions.push(`DATE(created_at) = $${params.length}`);
    }
    if (byMe === 'true') {
      params.push(req.user?.id);
      conditions.push(`created_by = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    const countQuery = `SELECT COUNT(*) FROM templates${whereClause}`;
    const dataQuery = `SELECT * FROM templates${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    params.push(parseInt(limit));
    params.push(offset);

    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery, params.slice(0, -2)),
      pool.query(dataQuery, params)
    ]);

    const templates = await Promise.all(dataResult.rows.map(async (t) => {
      const creatorInfo = await getUserInfo(t.created_by);
      const role = await getUserRole(t.created_by);
      return {
        ...t,
        creatorInfo,
        role
      };
    }));

    res.json({
      templates,
      total: parseInt(countResult.rows[0].count),
      hasMore: offset + templates.length < parseInt(countResult.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, data } = req.body;
    const userId = req.user?.id || 'unknown';
    
    const result = await pool.query(
      'INSERT INTO templates (name, data, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name, data, userId]
    );
    
    const template = result.rows[0];
    const creatorInfo = await getUserInfo(template.created_by);
    const role = await getUserRole(template.created_by);

    res.json({ ...template, creatorInfo, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  try {
    const { isOwner, isAdminCreator, isCreator } = await checkTemplatePermissions(userId, id);

    if (!isOwner && !isAdminCreator && !isCreator) {
      return res.status(403).json({ error: 'Permissão negada: Você não pode excluir este template.' });
    }

    if (isOwner) {
      // Dono pode excluir qualquer template
      await pool.query('DELETE FROM templates WHERE id = $1', [id]);
      return res.json({ success: true, message: 'Template excluído permanentemente.' });
    }

    if (isAdminCreator) {
      // Admin não criador pode solicitar exclusão
      await pool.query(
        'UPDATE templates SET deletion_requested_by = array_append(deletion_requested_by, $1) WHERE id = $2',
        [userId, id]
      );
      return res.json({ success: true, message: 'Solicitação de exclusão enviada ao dono.' });
    }

    if (isCreator) {
      // Criador pode excluir seu próprio template
      await pool.query('DELETE FROM templates WHERE id = $1', [id]);
      return res.json({ success: true, message: 'Template excluído.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New: Get deletion requests (Owner only)
app.get('/api/templates/deletion-requests', async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono pode ver solicitações de exclusão.' });
  }

  try {
    const result = await pool.query(`
      SELECT t.*, array_length(deletion_requested_by, 1) as request_count
      FROM templates t
      WHERE array_length(deletion_requested_by, 1) > 0
      ORDER BY created_at DESC
    `);

    const templates = await Promise.all(result.rows.map(async (t) => {
      const creatorInfo = await getUserInfo(t.created_by);
      const requesters = await Promise.all((t.deletion_requested_by || []).map(getUserInfo));
      return { ...t, creatorInfo, requesters };
    }));

    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New: Confirm deletion request (Owner only)
app.post('/api/templates/:id/confirm-delete', async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono pode confirmar exclusões.' });
  }

  try {
    await pool.query('DELETE FROM templates WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Template excluído permanentemente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New: Reject deletion request (Owner only)
app.post('/api/templates/:id/reject-delete', async (req, res) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas o dono pode rejeitar solicitações.' });
  }

  try {
    await pool.query('UPDATE templates SET deletion_requested_by = ARRAY[]::TEXT[] WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Solicitação rejeitada.' });
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