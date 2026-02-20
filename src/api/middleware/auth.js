const jwt = require('jsonwebtoken');
const { AUTHORIZED_GUILD_ID, DASHBOARD_ROLE_ID, JWT_SECRET, pool } = require('../../config');
const { getSessionTokenFromRequest } = require('../../utils');

// Middleware de Autenticação da API
const authMiddleware = async (req, res, next) => {
  // Excluir rotas públicas da verificação
  if (
    req.path.startsWith('/auth/login') ||
    req.path.startsWith('/auth/callback') ||
    req.path.startsWith('/auth/me') ||
    req.path.startsWith('/auth/logout') ||
    req.path === '/users/search' // Permitir busca de usuários na página de suporte
  ) return next();

  const apiKey = req.headers['x-api-key'];
  const masterKey = process.env.API_KEY;
  const token = getSessionTokenFromRequest(req);
  const config = require('../../config').getConfig();
  
  // 1. Verificar API Key (para chamadas externas/bot)
  if (apiKey && masterKey && apiKey === masterKey) {
    return next();
  }

  // 2. Verificar JWT (para Dashboard)
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const client = require('../../discord').client;
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      const dashboardRoleID = config.adminRole || DASHBOARD_ROLE_ID;
      
      let hasRealTimeAccess = false;
      let discordAccessCheckUnavailable = false;

      if (!guild) {
        discordAccessCheckUnavailable = true;
      } else {
        if (decoded.id === guild.ownerId) {
          hasRealTimeAccess = true;
        } else {
          const member = await guild.members.fetch(decoded.id).catch(() => null);
          if (member && member.roles.cache.has(dashboardRoleID)) {
            hasRealTimeAccess = true;
          }
          if (!hasRealTimeAccess) {
            const dbCheck = await pool.query('SELECT user_id FROM dashboard_access WHERE user_id = $1', [decoded.id]).catch(() => null);
            if (dbCheck && dbCheck.rows.length > 0) {
              hasRealTimeAccess = true;
              if (member) {
                member.roles.add(dashboardRoleID).catch(() => null);
              }
            }
          }
        }
      }

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

      if (discordAccessCheckUnavailable && decoded.hasAccess) {
        req.user = decoded;
        return next();
      }

      return res.status(403).json({ error: 'Acesso negado: Você não tem o cargo necessário para acessar o dashboard.' });
    } catch (err) {
      // Token inválido
    }
  }

  if (!masterKey && !token) {
    console.error('ERRO CRÍTICO: API_KEY não definida no arquivo .env!');
    return res.status(500).json({ error: 'Erro interno de configuração de segurança.' });
  }

  return res.status(401).json({ error: 'Acesso negado: Autenticação inválida ou ausente.' });
};

module.exports = authMiddleware;