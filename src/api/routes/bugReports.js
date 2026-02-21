const { pool } = require('../../config');

function setupBugReportRoutes(app, client) {
  // Get all bug reports
  app.get('/api/bug-reports', async (req, res) => {
    try {
      const { status } = req.query;
      let query = 'SELECT * FROM bug_reports';
      const params = [];

      if (status && status !== 'all') {
        params.push(status);
        query += ' WHERE status = $1';
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
    const { subject, description, allowContact } = req.body;
    const reporterId = req.user?.id;

    if (!reporterId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    if (!subject || !description) {
      return res.status(400).json({ error: 'Assunto e descrição são obrigatórios' });
    }

    try {
      const result = await pool.query(
        'INSERT INTO bug_reports (reporter_id, subject, description, allow_contact) VALUES ($1, $2, $3, $4) RETURNING *',
        [reporterId, subject, description, allowContact === true || allowContact === 'true']
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

    if (!['pending', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    try {
      const result = await pool.query(
        'UPDATE bug_reports SET status = $1 WHERE id = $2 RETURNING *',
        [status, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Bug report não encontrado' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Erro ao atualizar status:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete bug report
  app.delete('/api/bug-reports/:id', async (req, res) => {
    const { id } = req.params;

    try {
      const result = await pool.query('DELETE FROM bug_reports WHERE id = $1 RETURNING *', [id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Bug report não encontrado' });
      }

      res.json({ success: true, message: 'Bug report deletado com sucesso' });
    } catch (err) {
      console.error('Erro ao deletar bug report:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupBugReportRoutes;