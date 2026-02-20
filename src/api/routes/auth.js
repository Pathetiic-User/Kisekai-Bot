const jwt = require('jsonwebtoken');
const axios = require('axios');
const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, JWT_SECRET, AUTHORIZED_GUILD_ID, DASHBOARD_ROLE_ID, pool } = require('../../config');
const { getCookieOptions, getClearCookieOptions, addLog } = require('../../utils');

// Helper para verificar acesso ao dashboard
async function getLiveDashboardAccess(userId, client) {
  const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
  const config = require('../../config').getConfig();
  const dashboardRoleID = config.adminRole || DASHBOARD_ROLE_ID;

  let hasAccess = false;
  let role = 'user';

  if (guild) {
    if (userId === guild.ownerId) {
      hasAccess = true;
      role = 'owner';
    } else {
      const member = await guild.members.fetch(userId).catch(() => null);

      if (member && member.roles.cache.has(dashboardRoleID)) {
        hasAccess = true;
        role = 'admin';
      }

      if (!hasAccess) {
        const dbCheck = await pool.query('SELECT user_id FROM dashboard_access WHERE user_id = $1', [userId]).catch(() => null);
        if (dbCheck && dbCheck.rows.length > 0) {
          hasAccess = true;
          role = 'admin';
          if (member) {
            member.roles.add(dashboardRoleID).catch(() => null);
          }
        }
      }
    }
  } else {
    const dbCheck = await pool.query('SELECT user_id FROM dashboard_access WHERE user_id = $1', [userId]).catch(() => null);
    if (dbCheck && dbCheck.rows.length > 0) {
      hasAccess = true;
      role = 'admin';
    }
  }

  return { hasAccess, role, guildAvailable: !!guild };
}

function setupAuthRoutes(app, client) {
  // Login redirect
  app.get('/api/auth/login', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
    res.redirect(url);
  });

  // OAuth Callback
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
      const { hasAccess, role } = await getLiveDashboardAccess(userData.id, client);

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

  // Check auth status
  app.get('/api/auth/me', async (req, res) => {
    const { getSessionTokenFromRequest } = require('../../utils');
    const token = getSessionTokenFromRequest(req);
    if (!token) return res.status(401).json({ authenticated: false });

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const liveAccess = await getLiveDashboardAccess(decoded.id, client);

      let hasAccess = liveAccess.hasAccess;
      let role = liveAccess.role;

      if (!liveAccess.guildAvailable && !liveAccess.hasAccess) {
        hasAccess = Boolean(decoded.hasAccess);
        role = decoded.role || 'user';
      }

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

  // Logout
  app.post('/api/auth/logout', async (req, res) => {
    const { getSessionTokenFromRequest } = require('../../utils');
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
}

module.exports = setupAuthRoutes;