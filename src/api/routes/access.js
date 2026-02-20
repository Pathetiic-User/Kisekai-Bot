const { AUTHORIZED_GUILD_ID, DASHBOARD_ROLE_ID, pool } = require('../../config');

function setupAccessRoutes(app, client) {
  // Get all dashboard access
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

  // Grant access
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
      const config = require('../../config').getConfig();
      const dashboardRoleID = config.adminRole || DASHBOARD_ROLE_ID;
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
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

  // Revoke access
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
      const config = require('../../config').getConfig();
      const dashboardRoleID = config.adminRole || DASHBOARD_ROLE_ID;
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
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

  // Get user access logs
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
}

module.exports = setupAccessRoutes;