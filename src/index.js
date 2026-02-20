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
  registerEvents, 
  getBotState, 
  setBotState, 
  isClientConnected,
  acquireTransitionLock,
  releaseTransitionLock,
  isInTransition,
  botStateEmitter
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

// Importar utilitários
const { getCachedDiscordUserSummary } = require('./utils');

// Importar WebSocket
const { initWebSocket, notifyBotEvent } = require('./api/websocket');
const http = require('http');

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

// ==================== BOT STATE MANAGEMENT ====================

/**
 * Registra uma ação administrativa no banco de dados
 * @param {string} action - Ação realizada (bot_stop, bot_start, bot_restart)
 * @param {string} userId - ID do usuário que realizou a ação
 * @param {string} reason - Motivo opcional
 */
async function logAdminAction(action, userId, reason = null) {
  try {
    await config.pool.query(
      `INSERT INTO logs (user_id, action, reason, moderator, type, timestamp) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [userId, action, reason, userId, 'System']
    );
  } catch (err) {
    console.error('Erro ao registrar log administrativo:', err.message);
  }
}

/**
 * Aguarda o bot ficar pronto (conectado ao Discord)
 * @param {number} timeout - Tempo máximo em ms
 * @returns {Promise<boolean>}
 */
function waitForBotReady(timeout = 15000) {
  return new Promise((resolve) => {
    if (isClientConnected()) {
      resolve(true);
      return;
    }

    const timeoutId = setTimeout(() => {
      client.off('ready', onReady);
      resolve(false);
    }, timeout);

    const onReady = () => {
      clearTimeout(timeoutId);
      resolve(true);
    };

    client.once('ready', onReady);
  });
}

// Bot state
app.get('/api/bot/state', (req, res) => {
  res.json(getBotState());
});

// WebSocket clients para notificações em tempo real
const wsClients = new Set();

// Rota para WebSocket upgrade
app.get('/api/bot/ws', (req, res) => {
  // WebSocket não funciona via HTTP GET
  // Clientes devem usar WebSocket diretamente
  res.status(426).json({ 
    error: 'Upgrade Required', 
    message: 'Use WebSocket connection for real-time updates' 
  });
});

app.post('/api/bot/stop', async (req, res) => {
  const state = getBotState();
  
  // Verificar se já está desligado
  if (!state.isRunning && !isClientConnected()) {
    return res.status(400).json({ error: 'O bot já está desligado.' });
  }
  
  // Verificar se há transição em andamento
  if (state.isTransitioning) {
    return res.status(429).json({ 
      error: 'Operação em andamento', 
      message: 'Aguarde a operação atual terminar.' 
    });
  }
  
  // Tentar adquirir lock
  if (!acquireTransitionLock(30000)) {
    return res.status(429).json({ 
      error: 'Operação em andamento', 
      message: 'Outra operação está sendo processada. Tente novamente.' 
    });
  }

  try {
    const userId = req.user?.id || 'system';
    const reason = req.body?.reason || 'Desligado via dashboard';
    
    // Atualizar estado antes de destruir
    setBotState({ 
      isRunning: false, 
      lastAction: 'stopping', 
      lastActionTime: new Date().toISOString() 
    });
    
    // Destruir conexão com Discord
    await client.destroy();
    
    // Atualizar estado final
    setBotState({ 
      isRunning: false, 
      lastAction: 'stopped', 
      lastActionTime: new Date().toISOString(),
      lastError: null
    });
    
    // Registrar log
    await logAdminAction('bot_stop', userId, reason);
    
    console.log(`Bot desligado via dashboard por ${userId}`);
    
    // Notificar clientes WebSocket
    const notification = JSON.stringify({
      event: 'bot_stopped',
      data: { userId, reason, timestamp: new Date().toISOString() }
    });
    wsClients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(notification);
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Bot desligado com sucesso.', 
      isRunning: false,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Erro ao desligar bot:', err);
    
    // Atualizar estado de erro
    setBotState({ 
      lastAction: 'stop_failed', 
      lastError: err.message 
    });
    
    res.status(500).json({ 
      error: 'Erro ao desligar o bot', 
      details: err.message 
    });
  } finally {
    releaseTransitionLock();
  }
});

app.post('/api/bot/start', async (req, res) => {
  const state = getBotState();
  
  // Verificar se já está ligado
  if (state.isRunning && isClientConnected()) {
    return res.status(400).json({ error: 'O bot já está ligado.' });
  }
  
  // Verificar se há transição em andamento
  if (state.isTransitioning) {
    return res.status(429).json({ 
      error: 'Operação em andamento', 
      message: 'Aguarde a operação atual terminar.' 
    });
  }
  
  // Tentar adquirir lock
  if (!acquireTransitionLock(45000)) {
    return res.status(429).json({ 
      error: 'Operação em andamento', 
      message: 'Outra operação está sendo processada. Tente novamente.' 
    });
  }

  try {
    const userId = req.user?.id || 'system';
    
    // Atualizar estado
    setBotState({ 
      lastAction: 'starting', 
      lastActionTime: new Date().toISOString() 
    });
    
    // Fazer login no Discord
    await client.login(process.env.DISCORD_TOKEN);
    
    // Aguardar conexão ficar pronta (até 15 segundos)
    const isReady = await waitForBotReady(15000);
    
    if (!isReady) {
      throw new Error('Timeout: Bot não conseguiu conectar em 15 segundos');
    }
    
    // Atualizar estado final
    setBotState({ 
      isRunning: true, 
      lastAction: 'started', 
      lastActionTime: new Date().toISOString(),
      lastError: null
    });
    
    // Registrar log
    await logAdminAction('bot_start', userId, 'Ligado via dashboard');
    
    console.log(`Bot ligado via dashboard por ${userId}`);
    
    // Notificar clientes WebSocket
    const notification = JSON.stringify({
      event: 'bot_started',
      data: { userId, timestamp: new Date().toISOString() }
    });
    wsClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(notification);
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Bot ligado com sucesso.', 
      isRunning: true,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Erro ao ligar bot:', err);
    
    // Atualizar estado de erro
    setBotState({ 
      isRunning: false,
      lastAction: 'start_failed', 
      lastError: err.message 
    });
    
    res.status(500).json({ 
      error: 'Erro ao ligar o bot', 
      details: err.message 
    });
  } finally {
    releaseTransitionLock();
  }
});

app.post('/api/restart', async (req, res) => {
  const state = getBotState();
  
  // Verificar se há transição em andamento
  if (state.isTransitioning) {
    return res.status(429).json({ 
      error: 'Operação em andamento', 
      message: 'Aguarde a operação atual terminar.' 
    });
  }

  const userId = req.user?.id || 'system';
  
  // Registrar log antes de reiniciar
  await logAdminAction('bot_restart', userId, 'Reiniciado via dashboard');
  
  console.log(`Comando de reinicialização recebido por ${userId}`);
  
  res.status(200).json({ 
    message: 'Reiniciando o bot...',
    timestamp: new Date().toISOString()
  });
  
  // Dar tempo para a resposta ser enviada antes de reiniciar
  setTimeout(() => process.exit(1), 2000);
});

// Endpoint para verificar saúde do sistema
app.get('/api/bot/health', async (req, res) => {
  const state = getBotState();
  
  let dbHealthy = false;
  try {
    await config.pool.query('SELECT 1');
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
  
  const health = {
    status: state.isRunning && dbHealthy ? 'healthy' : 'unhealthy',
    bot: {
      connected: state.isRunning,
      gateway: state.gatewayStatus,
      lastAction: state.lastAction,
      lastActionTime: state.lastActionTime,
      lastError: state.lastError
    },
    database: dbHealthy,
    uptime: client.uptime,
    timestamp: new Date().toISOString()
  };
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

// ==================== INICIALIZAÇÃO ====================

const PORT = process.env.PORT || 3001;

config.initDb().then(() => {
  return config.loadConfig();
}).then(() => {
  // Criar servidor HTTP
  const server = http.createServer(app);
  
  // Inicializar WebSocket no servidor HTTP
  initWebSocket(server, botStateEmitter);
  
  // Iniciar servidor
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
  });
  
  // Login do Discord bot
  client.login(process.env.DISCORD_TOKEN);
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});
