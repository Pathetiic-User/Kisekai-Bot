const { AUTHORIZED_GUILD_ID, DASHBOARD_ROLE_ID, pool } = require('../../config');
const { getCachedDiscordUserSummary } = require('../../utils');

// Helper: Get user info from Discord (cached)
async function getUserInfo(userId, client) {
  return await getCachedDiscordUserSummary(userId, client);
}

// Helper: Get user role for UI indicators
async function getUserRole(userId, client) {
  const config = require('../../config').getConfig();
  const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
  const dashboardRoleID = config.adminRole || DASHBOARD_ROLE_ID;

  if (guild) {
    if (userId === guild.ownerId) return 'owner';
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && member.roles.cache.has(dashboardRoleID)) return 'admin';
  }
  return 'user';
}

function setupTemplateRoutes(app, client) {
  // Get all templates
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

      // Sempre excluir templates da lixeira (soft delete)
      conditions.push('deleted_at IS NULL');
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
        const creatorInfo = await getUserInfo(t.created_by, client);
        const role = await getUserRole(t.created_by, client);
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

  // Create template
  app.post('/api/templates', async (req, res) => {
    try {
      const { name, data } = req.body;
      const userId = req.user?.id || 'unknown';
      
      const result = await pool.query(
        'INSERT INTO templates (name, data, created_by) VALUES ($1, $2, $3) RETURNING *',
        [name, data, userId]
      );
      
      const template = result.rows[0];
      const creatorInfo = await getUserInfo(template.created_by, client);
      const role = await getUserRole(template.created_by, client);

      res.json({ ...template, creatorInfo, role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update template
  app.put('/api/templates/:id', async (req, res) => {
    const { id } = req.params;
    const { name, data } = req.body;
    const userId = req.user?.id;
    const userRole = req.user?.role;

    try {
      // Buscar template para verificar permissões
      const templateResult = await pool.query('SELECT * FROM templates WHERE id = $1', [id]);
      if (templateResult.rows.length === 0) {
        return res.status(404).json({ error: 'Template não encontrado.' });
      }
      
      const template = templateResult.rows[0];
      const isCreator = template.created_by === userId;
      const isOwner = userRole === 'owner';

      // Verificar permissão: Owner ou criador podem editar
      if (!isOwner && !isCreator) {
        return res.status(403).json({ error: 'Permissão negada: Você só pode editar templates criados por você.' });
      }

      // Verificar se não está na lixeira
      if (template.deleted_at !== null) {
        return res.status(400).json({ error: 'Não é possível editar um template que está na lixeira.' });
      }

      // Atualizar template
      const updateResult = await pool.query(
        'UPDATE templates SET name = $1, data = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
        [name, data, id]
      );

      const updatedTemplate = updateResult.rows[0];
      const creatorInfo = await getUserInfo(updatedTemplate.created_by, client);
      const role = await getUserRole(updatedTemplate.created_by, client);

      res.json({ ...updatedTemplate, creatorInfo, role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete template
  app.delete('/api/templates/:id', async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id;
    const userRole = req.user?.role;
    const { permanent } = req.query;

    try {
      // Buscar template para verificar permissões
      const templateResult = await pool.query('SELECT * FROM templates WHERE id = $1', [id]);
      if (templateResult.rows.length === 0) {
        return res.status(404).json({ error: 'Template não encontrado.' });
      }
      
      const template = templateResult.rows[0];
      const isCreator = template.created_by === userId;
      const isOwner = userRole === 'owner';

      // Verificar se está na lixeira (já tem deleted_at)
      const isInTrash = template.deleted_at !== null;

      // OWNER: Pode fazer exclusão permanente se especificar ?permanent=true
      if (isOwner && permanent === 'true') {
        await pool.query('DELETE FROM templates WHERE id = $1', [id]);
        return res.json({ success: true, message: 'Template excluído permanentemente.' });
      }

      // OWNER: Por padrão, também envia para lixeira (soft delete)
      if (isOwner && !isInTrash) {
        await pool.query('UPDATE templates SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
        return res.json({ success: true, message: 'Template apagado com sucesso.', inTrash: true });
      }

      // OWNER tentando apagar template que já está na lixeira (sem permanent=true)
      if (isOwner && isInTrash) {
        return res.status(400).json({ error: 'Este template já está na lixeira. Use ?permanent=true para excluir permanentemente.' });
      }

      // NÃO-OWNER tentando excluir template de outro usuário
      if (!isCreator) {
        return res.status(403).json({ error: 'Permissão negada: Você só pode excluir templates criados por você.' });
      }

      // CRIADOR (não-owner): Soft delete - vai para lixeira
      if (isCreator && !isInTrash) {
        await pool.query('UPDATE templates SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
        return res.json({ success: true, message: 'Template apagado com sucesso.', inTrash: true });
      }

      // Se já está na lixeira e o criador tenta excluir novamente
      if (isCreator && isInTrash) {
        return res.status(400).json({ error: 'Este template já está na lixeira. Apenas o dono pode esvaziá-la.' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get templates in trash (Owner only)
  app.get('/api/templates/trash', async (req, res) => {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono pode ver a lixeira.' });
    }

    try {
      const result = await pool.query(
        'SELECT * FROM templates WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
      );

      const templates = await Promise.all(result.rows.map(async (t) => {
        const creatorInfo = await getUserInfo(t.created_by, client);
        return { ...t, creatorInfo };
      }));

      res.json(templates);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Empty trash - delete all templates in trash (Owner only)
  app.delete('/api/templates/trash/clear', async (req, res) => {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono pode esvaziar a lixeira.' });
    }

    try {
      const result = await pool.query('DELETE FROM templates WHERE deleted_at IS NOT NULL');
      res.json({ success: true, message: `Lixeira esvaziada. ${result.rowCount} templates removidos permanentemente.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Restore template from trash (Owner only)
  app.post('/api/templates/:id/restore', async (req, res) => {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono pode restaurar templates da lixeira.' });
    }

    try {
      const result = await pool.query(
        'UPDATE templates SET deleted_at = NULL WHERE id = $1 RETURNING *',
        [req.params.id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Template não encontrado.' });
      }

      res.json({ success: true, message: 'Template restaurado com sucesso.', template: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get deletion requests (Owner only)
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
        const creatorInfo = await getUserInfo(t.created_by, client);
        const requesters = await Promise.all((t.deletion_requested_by || []).map(id => getUserInfo(id, client)));
        return { ...t, creatorInfo, requesters };
      }));

      res.json(templates);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Confirm deletion request (Owner only)
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

  // Reject deletion request (Owner only)
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
}

module.exports = setupTemplateRoutes;