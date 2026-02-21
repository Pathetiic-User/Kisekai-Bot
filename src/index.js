require('dotenv').config();
const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Importar configuração
const config = require('./config');

// Importar Discord client
const { 
  client, 
  registerEvents
} = require('./discord');

// Importar API Express
const { app, upload } = require('./api');

// Importar rotas
const setupAuthRoutes = require('./api/routes/auth');
const setupUserRoutes = require('./api/routes/users');
const setupReportRoutes = require('./api/routes/reports');
const setupModerationRoutes = require('./api/routes/moderation');
const setupSweepstakeRoutes = require('./api/routes/sweepstakes');
const setupTemplateRoutes = require('./api/routes/templates');
const setupAccessRoutes = require('./api/routes/access');
const setupBroadcastRoutes = require('./api/routes/broadcast');
const setupBugReportRoutes = require('./api/routes/bugReports');

// Importar utilitários
const { getCachedDiscordUserSummary } = require('./utils');

const http = require('http');

// Registrar eventos do Discord
registerEvents();

// Configurar todas as rotas
setupAuthRoutes(app, client);
setupUserRoutes(app, client);
setupReportRoutes(app, client, upload);
setupModerationRoutes(app, client);
setupSweepstakeRoutes(app, client);
setupTemplateRoutes(app, client);
setupAccessRoutes(app, client);
setupBroadcastRoutes(app, client);
setupBugReportRoutes(app, client);

// ==================== ROTAS BÁSICAS ====================

// Config
app.get('/api/config', (req, res) => res.json(config.getConfig()));

app.post('/api/config', async (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'No data provided' });
  config.setConfig(req.body);
  await config.saveConfig();
  res.json({ message: 'Config updated successfully', config: config.getConfig() });
});

// Stats
app.get('/api/stats', async (req, res) => {
  const { isStatsCacheValid, getStatsCache, setStatsCache } = require('./utils');
  const ms = require('ms');
  
  if (isStatsCacheValid()) {
    return res.json(getStatsCache().data);
  }

  let dbHealthy = false;
  try {
    const dbCheck = await config.pool.query('SELECT 1');
    if (dbCheck) dbHealthy = true;
  } catch (e) {
    dbHealthy = false;
  }

  const gatewayStatusMap = {
    0: 'Online', 1: 'Conectando', 2: 'Reconectando', 3: 'Inativo',
    4: 'Inicializando', 5: 'Desconectado', 6: 'Aguardando Guildas',
    7: 'Identificando', 8: 'Retomando'
  };

  const guild = client.guilds.cache.get(config.AUTHORIZED_GUILD_ID);
  
  // Verificar se o client está pronto antes de fazer operações
  if (guild && client.isReady && client.isReady()) {
    try {
      await guild.fetch();
    } catch (e) {
      // Ignora erros de rate limit ou shard desligado
      if (e.code !== 'ShardingRequired' && !e.message.includes('rate limited') && !e.message.includes('Shard')) {
        console.error("Erro ao atualizar guilda:", e.message);
      }
    }

    // Aumenta o intervalo para 5 minutos e só faz fetch se não houver rate limit recente
    const lastRateLimit = global.lastMemberRateLimit || 0;
    const timeSinceLastRateLimit = Date.now() - lastRateLimit;
    
    if (!guild.lastMemberFetch || (Date.now() - guild.lastMemberFetch > 300000)) {
      if (timeSinceLastRateLimit > 60000) { // Espera 1 minuto após rate limit
        try {
          await guild.members.fetch({ withPresences: true });
          guild.lastMemberFetch = Date.now();
        } catch (e) {
          if (e.message.includes('rate limited')) {
            global.lastMemberRateLimit = Date.now();
            console.log("Rate limit ao carregar membros, tentando novamente mais tarde.");
          } else if (!e.message.includes('Shard') && !e.message.includes('token')) {
            console.error("Erro ao carregar membros:", e.message);
          }
        }
      }
    }
  }

  const { Collection } = require('discord.js');
  const allMembers = guild ? guild.members.cache : new Collection();
  const humanMembers = allMembers.filter(m => !m.user.bot);
  const botMembers = allMembers.filter(m => m.user.bot);
  
  const onlineHumans = humanMembers.filter(m => m.presence?.status && m.presence.status !== 'offline').size;

  const serverInfo = guild ? {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ dynamic: true }),
    memberCount: guild.memberCount,
    onlineCount: onlineHumans,
    offlineCount: humanMembers.size - onlineHumans,
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

  setStatsCache(statsPayload);
  res.json(statsPayload);
});

// Helper function to parse duration string to milliseconds (duplicated from moderation.js for logs endpoint)
function parseDurationToMs(duration) {
  if (!duration) return null;
  
  const normalizedDuration = duration.toLowerCase().trim();
  
  const durationMap = {
    'ms': 1,
    's': 1000, 'sec': 1000, 'secs': 1000, 'second': 1000, 'seconds': 1000,
    'm': 60 * 1000, 'min': 60 * 1000, 'mins': 60 * 1000, 'minute': 60 * 1000, 'minutes': 60 * 1000,
    'h': 60 * 60 * 1000, 'hr': 60 * 60 * 1000, 'hrs': 60 * 60 * 1000, 'hour': 60 * 60 * 1000, 'hours': 60 * 60 * 1000,
    'd': 24 * 60 * 60 * 1000, 'day': 24 * 60 * 60 * 1000, 'days': 24 * 60 * 60 * 1000,
    'w': 7 * 24 * 60 * 60 * 1000, 'wk': 7 * 24 * 60 * 60 * 1000, 'wks': 7 * 24 * 60 * 60 * 1000, 'week': 7 * 24 * 60 * 60 * 1000, 'weeks': 7 * 24 * 60 * 60 * 1000,
    'mo': 30 * 24 * 60 * 60 * 1000, 'month': 30 * 24 * 60 * 60 * 1000, 'months': 30 * 24 * 60 * 60 * 1000,
    'y': 365 * 24 * 60 * 60 * 1000, 'year': 365 * 24 * 60 * 60 * 1000, 'years': 365 * 24 * 60 * 60 * 1000,
  };
  
  let totalMs = 0;
  const pattern = /(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|year|years)\b/gi;
  
  let match;
  let foundAny = false;
  
  while ((match = pattern.exec(normalizedDuration)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs = durationMap[unit] || 0;
    
    if (unitMs > 0) {
      totalMs += value * unitMs;
      foundAny = true;
    }
  }
  
  if (!foundAny) {
    const simpleMatch = normalizedDuration.match(/^(\d+)([a-z]+)$/i);
    if (simpleMatch) {
      const value = parseInt(simpleMatch[1]);
      const unit = simpleMatch[2].toLowerCase();
      const unitMs = durationMap[unit] || 0;
      totalMs = value * unitMs;
      foundAny = unitMs > 0;
    }
  }
  
  return foundAny ? totalMs : null;
}

// Helper function to calculate log status for ban/mute
function calculateLogStatus(log, guild, client) {
  const action = log.action.toLowerCase();
  const isBan = action === 'ban';
  const isMute = action === 'mute';
  
  if (!isBan && !isMute) {
    return { status: 'N/A', expiresAt: null, remainingMs: null, isActive: false };
  }
  
  // Parse duration
  const durationMs = parseDurationToMs(log.duration);
  
  // If permanent ban
  if (isBan && log.duration === 'permanent') {
    // Check if user is currently banned
    return { status: 'Verificando...', expiresAt: null, remainingMs: null, isPermanent: true, isActive: false, needsCheck: true };
  }
  
  // Calculate expiry time
  if (!durationMs || !log.timestamp) {
    return { status: 'N/A', expiresAt: null, remainingMs: null, isActive: false };
  }
  
  const startTime = new Date(log.timestamp).getTime();
  const expiresAt = new Date(startTime + durationMs);
  const now = Date.now();
  const remainingMs = expiresAt.getTime() - now;
  
  // For logs listing, we calculate based on time first
  const hasExpired = remainingMs <= 0;
  
  if (hasExpired) {
    // Expired naturally by time
    return { status: 'Expirado', expiresAt: expiresAt.toISOString(), remainingMs: 0, durationMs, isActive: false };
  } else {
    // Still in time window - needs Discord check to determine if active or removed early
    return { status: 'Verificando...', expiresAt: expiresAt.toISOString(), remainingMs: Math.max(0, remainingMs), durationMs, isActive: false, needsCheck: true };
  }
}

// Logs
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

    const totalResult = await config.pool.query(`SELECT COUNT(*) FROM logs${whereClause}`, params);
    const total = parseInt(totalResult.rows[0].count);

    let query = `SELECT * FROM logs${whereClause} ORDER BY timestamp DESC`;
    
    const limitInt = parseInt(limit) || 20;
    const offsetInt = parseInt(offset) || 0;

    params.push(limitInt);
    query += ` LIMIT $${params.length}`;
    
    params.push(offsetInt);
    query += ` OFFSET $${params.length}`;

    const result = await config.pool.query(query, params);

    // Get guild for Discord status checks
    const guild = client.guilds.cache.get(config.AUTHORIZED_GUILD_ID);
    
    // Collect unique user IDs that need status checks
    const userIdsToCheck = new Set();
    result.rows.forEach(log => {
      const action = log.action.toLowerCase();
      if ((action === 'ban' || action === 'mute') && log.duration) {
        userIdsToCheck.add(log.user_id);
      }
    });
    
    // Batch fetch Discord status for all users
    const userStatusMap = new Map();
    if (guild && userIdsToCheck.size > 0) {
      // Fetch all bans in one call
      let bans = new Map();
      try {
        const banList = await guild.bans.fetch();
        banList.forEach(ban => bans.set(ban.user.id, true));
      } catch (e) {
        console.error('Error fetching bans:', e.message);
      }
      
      // Check mute status for each user
      for (const userId of userIdsToCheck) {
        const isBanned = bans.has(userId);
        let isMuted = false;
        let muteEndsAt = null;
        
        try {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member && member.communicationDisabledUntil && member.communicationDisabledUntil > new Date()) {
            isMuted = true;
            muteEndsAt = member.communicationDisabledUntil;
          }
        } catch (e) {
          // Member not in guild
        }
        
        userStatusMap.set(userId, { isBanned, isMuted, muteEndsAt });
      }
    }

    const logs = await Promise.all(result.rows.map(async (log) => {
      const userSummary = await getCachedDiscordUserSummary(log.user_id, client);
      
      // Calculate status for ban/mute
      let statusInfo = { status: 'N/A', expiresAt: null, remainingMs: null, isActive: false };
      const action = log.action.toLowerCase();
      
      if (action === 'ban' || action === 'mute') {
        const initialStatus = calculateLogStatus(log, guild, client);
        const userStatus = userStatusMap.get(log.user_id) || { isBanned: false, isMuted: false, muteEndsAt: null };
        
        const isBan = action === 'ban';
        const durationMs = parseDurationToMs(log.duration);
        
        if (isBan && log.duration === 'permanent') {
          // Permanent ban
          statusInfo = {
            status: userStatus.isBanned ? 'Ativo' : 'Expirando',
            expiresAt: null,
            remainingMs: null,
            isPermanent: true,
            isActive: userStatus.isBanned
          };
        } else if (durationMs && log.timestamp) {
          const startTime = new Date(log.timestamp).getTime();
          const expiresAt = new Date(startTime + durationMs);
          const now = Date.now();
          const remainingMs = expiresAt.getTime() - now;
          
          if (remainingMs <= 0) {
            // Time has passed - expired naturally
            statusInfo = {
              status: 'Expirado',
              expiresAt: expiresAt.toISOString(),
              remainingMs: 0,
              durationMs,
              isActive: false
            };
          } else {
            // Time not passed - check if punishment is still active
            let isActive = false;
            
            if (isBan && userStatus.isBanned) {
              isActive = true;
            } else if (!isBan && userStatus.isMuted && userStatus.muteEndsAt) {
              // For mutes, verify the end time matches
              const calculatedEndsAt = startTime + durationMs;
              const actualMuteEndsAt = new Date(userStatus.muteEndsAt).getTime();
              isActive = Math.abs(calculatedEndsAt - actualMuteEndsAt) < 5000;
            }
            
            if (isActive) {
              statusInfo = {
                status: 'Ativo',
                expiresAt: expiresAt.toISOString(),
                remainingMs: Math.max(0, remainingMs),
                durationMs,
                isActive: true
              };
            } else {
              // Not active but time remaining = removed early
              statusInfo = {
                status: 'Expirando',
                expiresAt: expiresAt.toISOString(),
                remainingMs: 0,
                durationMs,
                isActive: false
              };
            }
          }
        }
      }
      
      return {
        id: log.id,
        action: log.action,
        userId: log.user_id,
        username: userSummary.username,
        avatarURL: userSummary.avatarURL,
        moderator: log.moderator,
        reason: log.reason,
        timestamp: log.timestamp,
        type: log.type,
        duration: log.duration,
        status: statusInfo.status,
        expiresAt: statusInfo.expiresAt,
        remainingMs: statusInfo.remainingMs,
        isPermanent: statusInfo.isPermanent || false,
        isActive: statusInfo.isActive || false
      };
    }));

    res.json({ logs, total, hasMore: offsetInt + logs.length < total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== INICIALIZAÇÃO ====================

const PORT = process.env.PORT || 3001;

// Criar servidor HTTP e iniciar IMEDIATAMENTE para healthcheck do Railway
const server = http.createServer(app);

// Variável para controlar se a aplicação está totalmente pronta
let isAppReady = false;

// Iniciar servidor PRIMEIRO (para responder ao healthcheck)
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Atualizar health check para indicar status completo da aplicação
app.get('/health', (req, res) => {
  if (isAppReady) {
    res.status(200).json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      db: 'connected',
      discord: client.isReady ? client.isReady() : false
    });
  } else {
    res.status(200).json({ 
      status: 'initializing', 
      timestamp: new Date().toISOString(),
      db: 'connecting',
      discord: false
    });
  }
});

// Inicializar banco de dados e Discord DEPOIS que o servidor estiver ouvindo
config.initDb().then(() => {
  return config.loadConfig();
}).then(() => {
  console.log('Database initialized successfully');
  
  // Login do Discord bot
  return client.login(process.env.DISCORD_TOKEN);
}).then(() => {
  console.log('Discord bot logged in successfully');
  isAppReady = true;
}).catch(err => {
  console.error('Failed to initialize:', err);
  // Não fazer exit(1) para permitir que o healthcheck ainda funcione
  // e o Railway possa tentar novamente
  isAppReady = false;
});
