const { AUTHORIZED_GUILD_ID, pool } = require('../../config');
const { getCachedDiscordUserSummary, getUsersCache, isUsersCacheValid } = require('../../utils');

function setupUserRoutes(app, client) {
  // Search users - uses local cache to avoid Discord rate limits
  // MUST be defined BEFORE /api/users/:id to avoid route conflict
  app.get('/api/users/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    try {
      const searchLower = q.toLowerCase();
      const cached = getUsersCache();
      
      // If we have cached users, filter them locally
      if (cached.data && cached.data.length > 0) {
        const results = cached.data
          .filter(user => {
            const username = (user.username || '').toLowerCase();
            const globalName = (user.globalName || '').toLowerCase();
            const displayName = (user.displayName || '').toLowerCase();
            
            return (
              username.includes(searchLower) ||
              globalName.includes(searchLower) ||
              displayName.includes(searchLower)
            );
          })
          .slice(0, 20)
          .map(user => ({
            id: user.id,
            username: user.username,
            globalName: user.globalName,
            displayName: user.displayName,
            avatarURL: user.avatarURL,
            status: user.status || 'offline'
          }));
        
        return res.json(results);
      }
      
      // Fallback: try to fetch from Discord guild cache (no API call)
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      if (!guild) {
        return res.status(404).json({ error: 'Servidor não encontrado ou bot não carregado.' });
      }
      
      // Use guild's cached members (already in memory, no API call)
      const members = guild.members.cache;
      const results = [];
      
      for (const [id, m] of members) {
        if (results.length >= 20) break;
        
        const username = (m.user.username || '').toLowerCase();
        const globalName = (m.user.globalName || '').toLowerCase();
        const displayName = (m.displayName || '').toLowerCase();
        
        if (
          username.includes(searchLower) ||
          globalName.includes(searchLower) ||
          displayName.includes(searchLower)
        ) {
          results.push({
            id: m.user.id,
            username: m.user.username,
            globalName: m.user.globalName,
            displayName: m.displayName,
            avatarURL: m.user.displayAvatarURL({ dynamic: true, size: 256 }),
            status: m.presence?.status || 'offline'
          });
        }
      }
      
      res.json(results);
    } catch (err) {
      console.error('User search error:', err);
      res.status(500).json({ error: 'Erro ao buscar usuários.' });
    }
  });

  // Get user by ID
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

  // Get all users
  app.get('/api/users', async (req, res) => {
    try {
      const { isUsersCacheValid, getUsersCache, setUsersCache } = require('../../utils');
      const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos
      const now = Date.now();

      if (isUsersCacheValid()) {
        return res.json(getUsersCache().data);
      }

      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      
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
      setUsersCache(results);

      res.json(results);
    } catch (err) {
      console.error('Get all users error details:', {
        message: err.message,
        stack: err.stack,
        code: err.code
      });

      // If fetch fails but we have old cache, return it as fallback
      const { getUsersCache } = require('../../utils');
      const cached = getUsersCache();
      if (cached.data) {
        console.log('Returning stale cache due to fetch error');
        return res.json(cached.data);
      }

      res.status(503).json({ error: 'Discord indisponível no momento. Tente novamente em instantes.' });
    }
  });

  // Reload specific user
  app.post('/api/users/reload/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
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
      const { getUsersCache, setUsersCache } = require('../../utils');
      const cached = getUsersCache();
      if (cached.data) {
        const index = cached.data.findIndex(u => u.id === userId);
        if (index !== -1) {
          cached.data[index] = userData;
          setUsersCache(cached.data);
        } else {
          cached.data.push(userData);
          setUsersCache(cached.data);
        }
      }

      res.json(userData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupUserRoutes;