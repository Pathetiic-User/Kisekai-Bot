require('dotenv').config();
const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Importar configuração
const config = require('./config');

// Importar Discord client
const { client, registerEvents, getBotState, setBotState } = require('./discord');

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

// Importar utilitários
const { getCachedDiscordUserSummary } = require('./utils');

// Registrar eventos do Discord
registerEvents();

// Configurar todas as rotas
setupAuthRoutes(app, client);
setupUserRoutes(app, client);
setupReportRoutes(app, client);
setupModerationRoutes(app, client);
setupSweepstakeRoutes(app, client);
setupTemplateRoutes(app, client);
setupAccessRoutes(app, client);
setupBroadcastRoutes(app, client);

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
  
  if (guild) {
    try {
      await guild.fetch();
    } catch (e) {
      console.error("Erro ao atualizar guilda:", e);
    }

    if (!guild.lastMemberFetch || (Date.now() - guild.lastMemberFetch > 60000)) {
      try {
        await guild.members.fetch({ withPresences: true });
        guild.lastMemberFetch = Date.now();
      } catch (e) {
        console.error("Erro ao carregar membros:", e);
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

    const logs = await Promise.all(result.rows.map(async (log) => {
      const userSummary = await getCachedDiscordUserSummary(log.user_id, client);
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
        duration: log.duration
      };
    }));

    res.json({ logs, total, hasMore: offsetInt + logs.length < total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bot state
app.get('/api/bot/state', (req, res) => {
  res.json(getBotState());
});

app.post('/api/bot/stop', async (req, res) => {
  const state = getBotState();
  if (!state.isRunning) {
    return res.status(400).json({ error: 'O bot já está desligado.' });
  }

  try {
    setBotState({ isRunning: false, lastAction: 'stopped', lastActionTime: new Date().toISOString() });
    await client.destroy();
    console.log('Bot desligado via dashboard.');
    res.json({ success: true, message: 'Bot desligado com sucesso.', isRunning: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/start', async (req, res) => {
  const state = getBotState();
  if (state.isRunning) {
    return res.status(400).json({ error: 'O bot já está ligado.' });
  }

  try {
    await client.login(process.env.DISCORD_TOKEN);
    setBotState({ isRunning: true, lastAction: 'started', lastActionTime: new Date().toISOString() });
    console.log('Bot ligado via dashboard.');
    res.json({ success: true, message: 'Bot ligado com sucesso.', isRunning: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restart', (req, res) => {
  res.status(200).json({ message: 'Reiniciando o bot...' });
  console.log('Comando de reinicialização recebido.');
  setTimeout(() => process.exit(1), 2000);
});

// ==================== INICIALIZAÇÃO ====================

const PORT = process.env.PORT || 3001;

config.initDb().then(() => {
  return config.loadConfig();
}).then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  client.login(process.env.DISCORD_TOKEN);
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});