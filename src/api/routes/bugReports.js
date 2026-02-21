const { pool } = require('../../config');

function setupBugReportRoutes(app, client) {
  // Get all bug reports with status filter
  app.get('/api/bug-reports', async (req, res) => {
    try {
      const { status } = req.query;
      let query = 'SELECT * FROM bug_reports';
      const params = [];

      if (status && status !== 'all') {
        params.push(status);
        query += ' WHERE status = $1';
      } else {
        // By default, exclude deleted from list
        query += " WHERE status != 'deleted'";
      }

      query += ' ORDER BY timestamp DESC';
      const result = await pool.query(query, params);

      const bugReports = await Promise.all(result.rows.map(async (report) => {
        const reporter = await client.users.fetch(report.reporter_id).catch(() => null);

        return {
          ...report,
          reporter: {
            id: report.reporter_id,
            username: reporter ? reporter.username : 'Desconhecido',
            globalName: reporter ? reporter.globalName : null,
            avatarURL: reporter ? reporter.displayAvatarURL() : null
          }
        };
      }));

      res.json(bugReports);
    } catch (err) {
      console.error('Erro ao buscar bug reports:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Create bug report
  app.post('/api/bug-reports', async (req, res) => {
    const { subject, description, allowContact, reportType } = req.body;
    const reporterId = req.user?.id;

    if (!reporterId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    if (!subject || !description) {
      return res.status(400).json({ error: 'Assunto e descrição são obrigatórios' });
    }

    // Validate report type
    const validReportType = reportType === 'vulnerability' ? 'vulnerability' : 'bug';

    try {
      const result = await pool.query(
        'INSERT INTO bug_reports (reporter_id, subject, description, allow_contact, report_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [reporterId, subject, description, allowContact === true || allowContact === 'true', validReportType]
      );

      const report = result.rows[0];
      const reporter = await client.users.fetch(report.reporter_id).catch(() => null);

      res.json({
        success: true,
        report: {
          ...report,
          reporter: {
            id: report.reporter_id,
            username: reporter ? reporter.username : 'Desconhecido',
            globalName: reporter ? reporter.globalName : null,
            avatarURL: reporter ? reporter.displayAvatarURL() : null
          }
        }
      });
    } catch (err) {
      console.error('Erro ao criar bug report:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update bug report status
  app.patch('/api/bug-reports/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'resolved', 'deleted'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    try {
      let query = 'UPDATE bug_reports SET status = $1';
      const params = [status, id];

      if (status === 'deleted') {
        query += ', deleted_at = CURRENT_TIMESTAMP';
      } else {
        query += ', deleted_at = NULL';
      }

      query += ' WHERE id = $2 RETURNING *';

      const result = await pool.query(query, params);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Bug report não encontrado' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Erro ao atualizar status:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete bug report (soft delete or permanent)
  app.delete('/api/bug-reports/:id', async (req, res) => {
    const { id } = req.params;
    const { permanent } = req.query;
    const userRole = req.user?.role;

    try {
      if (permanent === 'true') {
        // Permanent delete - only owner can do this
        if (userRole !== 'owner') {
          return res.status(403).json({ error: 'Apenas o dono do servidor pode excluir bug reports permanentemente.' });
        }

        const result = await pool.query('DELETE FROM bug_reports WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Bug report não encontrado' });
        }

        return res.json({ success: true, message: 'Bug report excluído permanentemente', report: result.rows[0] });
      } else {
        // Soft delete (send to trash) - only owner can do this
        if (userRole !== 'owner') {
          return res.status(403).json({ error: 'Apenas o dono do servidor pode enviar bug reports para a lixeira.' });
        }

        const result = await pool.query(
          "UPDATE bug_reports SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
          [id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Bug report não encontrado' });
        }

        return res.json({ success: true, message: 'Bug report enviado para a lixeira', report: result.rows[0] });
      }
    } catch (err) {
      console.error('Erro ao deletar bug report:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk delete bug reports
  app.post('/api/bug-reports/bulk-delete', async (req, res) => {
    const userRole = req.user?.role;

    if (userRole !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono do servidor pode excluir bug reports.' });
    }

    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'IDs inválidos' });
    }

    try {
      // Check current status of reports
      const { rows: currentReports } = await pool.query('SELECT id, status FROM bug_reports WHERE id = ANY($1)', [ids]);
      
      const reportsInTrash = currentReports.filter(r => r.status === 'deleted');
      const reportsToTrash = currentReports.filter(r => r.status !== 'deleted');

      let deletedCount = 0;

      // Permanent delete for those already in trash
      if (reportsInTrash.length > 0) {
        const trashIds = reportsInTrash.map(r => r.id);
        await pool.query('DELETE FROM bug_reports WHERE id = ANY($1)', [trashIds]);
        deletedCount += reportsInTrash.length;
      }

      // Soft delete for those not in trash
      if (reportsToTrash.length > 0) {
        const activeIds = reportsToTrash.map(r => r.id);
        await pool.query("UPDATE bug_reports SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ANY($1)", [activeIds]);
        deletedCount += reportsToTrash.length;
      }

      res.json({ success: true, message: `${deletedCount} bug reports processados.` });
    } catch (err) {
      console.error('Erro ao excluir bug reports:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Clear trash
  app.delete('/api/bug-reports/trash/clear', async (req, res) => {
    const userRole = req.user?.role;

    if (userRole !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono do servidor pode limpar a lixeira.' });
    }

    try {
      const result = await pool.query("DELETE FROM bug_reports WHERE status = 'deleted'");
      res.json({ success: true, message: `Lixeira limpa. ${result.rowCount} bug reports removidos.` });
    } catch (err) {
      console.error('Erro ao limpar lixeira:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Restore bug report from trash
  app.post('/api/bug-reports/:id/restore', async (req, res) => {
    const { id } = req.params;
    const userRole = req.user?.role;

    if (userRole !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono do servidor pode restaurar bug reports.' });
    }

    try {
      const result = await pool.query(
        "UPDATE bug_reports SET status = 'pending', deleted_at = NULL WHERE id = $1 AND status = 'deleted' RETURNING *",
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Bug report não encontrado na lixeira' });
      }

      res.json({ success: true, message: 'Bug report restaurado com sucesso', report: result.rows[0] });
    } catch (err) {
      console.error('Erro ao restaurar bug report:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupBugReportRoutes;