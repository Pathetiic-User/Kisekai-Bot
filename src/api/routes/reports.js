const { AUTHORIZED_GUILD_ID, DASHBOARD_ROLE_ID, pool, supabase } = require('../../config');
const { addLog, createCustomEmbed, uploadToSupabase } = require('../../utils');
const ms = require('ms');

function setupReportRoutes(app, client, upload) {
  // Get all reports
  app.get('/api/reports', async (req, res) => {
    try {
      const { status } = req.query;
      let query = 'SELECT * FROM reports';
      const params = [];

      if (status && status !== 'all') {
        params.push(status);
        query += ' WHERE status = $1';
      } else {
        query += " WHERE status != 'deleted'";
      }

      query += ' ORDER BY timestamp DESC';
      const result = await pool.query(query, params);

      const reports = await Promise.all(result.rows.map(async (report) => {
        const reporter = await client.users.fetch(report.reporter_id).catch(() => null);
        const reported = await client.users.fetch(report.reported_id).catch(() => null);

        return {
          ...report,
          reporter: {
            id: report.reporter_id,
            username: reporter ? reporter.username : 'Desconhecido',
            avatarURL: reporter ? reporter.displayAvatarURL() : null
          },
          reported: {
            id: report.reported_id,
            username: reported ? reported.username : 'Desconhecido',
            avatarURL: reported ? reported.displayAvatarURL() : null
          }
        };
      }));

      res.json(reports);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create report
  app.post('/api/reports', upload.single('image'), async (req, res) => {
    const { reportedUserId, reportedUsername, reason } = req.body;
    const reporterId = req.user?.id || 'Dashboard';

    if (!reportedUserId || !reason) {
      return res.status(400).json({ error: 'Missing reportedUserId or reason' });
    }

    try {
      let imageUrl = null;
      let storagePath = null;

      if (req.file) {
        const fileExt = req.file.originalname.split('.').pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        const uploadResult = await uploadToSupabase(req.file.buffer, fileName, req.file.mimetype);
        
        if (uploadResult) {
          imageUrl = uploadResult.publicUrl;
          storagePath = uploadResult.storagePath;
        }
      }

      const result = await pool.query(
        'INSERT INTO reports (reporter_id, reported_id, reason, image_url, storage_path) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [reporterId, reportedUserId, reason, imageUrl, storagePath]
      );

      res.json({ success: true, report: result.rows[0] });
    } catch (err) {
      console.error('Erro ao criar reporte:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve report
  app.post('/api/reports/:id/resolve', async (req, res) => {
    const { id } = req.params;
    const { action, reason, duration, moderator } = req.body;

    if (!['kick', 'ban', 'mute', 'warn', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Ação inválida' });
    }

    try {
      const reportResult = await pool.query('SELECT * FROM reports WHERE id = $1', [id]);
      if (reportResult.rows.length === 0) return res.status(404).json({ error: 'Reporte não encontrado' });
      const report = reportResult.rows[0];

      if (action === 'reject') {
        await pool.query("UPDATE reports SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
        return res.json({ success: true, message: 'Reporte rejeitado' });
      }

      // Process moderation action
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      if (!guild) return res.status(500).json({ error: 'Guild not found' });

      const member = await guild.members.fetch(report.reported_id).catch(() => null);
      const user = member ? member.user : await client.users.fetch(report.reported_id).catch(() => null);

      if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

      let actionLabel = action;
      const config = require('../../config').getConfig();
      
      switch (action) {
        case 'kick':
          if (!member) return res.status(400).json({ error: 'Membro não está no servidor' });
          await member.kick(reason || 'Kicked via Report Resolution');
          break;
        case 'ban':
          await guild.members.ban(report.reported_id, { reason: reason || 'Banned via Report Resolution' });
          break;
        case 'mute':
          if (!member) return res.status(400).json({ error: 'Membro não está no servidor' });
          await member.timeout(duration ? ms(duration) : ms('10m'), reason || 'Muted via Report Resolution');
          break;
        case 'warn':
          try {
            const { EmbedBuilder } = require('discord.js');
            const warnEmbed = new EmbedBuilder()
              .setTitle('⚠️ Advertência Recebida')
              .setDescription(`Você recebeu uma advertência no servidor **${guild.name}**.`)
              .addFields(
                { name: 'Motivo', value: reason || 'Punição via Reporte' },
                { name: 'Moderador', value: moderator || 'Dashboard' }
              )
              .setColor('#ffff00')
              .setTimestamp();
            await user.send({ embeds: [warnEmbed] });
          } catch (e) {
            console.error(`Não foi possível enviar DM para ${user.tag}`);
          }
          break;
      }

      await addLog(report.reported_id, actionLabel, reason || 'Punição via Reporte', moderator || 'Dashboard', 'Administrativa', duration);
      await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [id]);

      // Send to punishments channel (Skip if action is warn)
      if (action !== 'warn' && config.punishmentChannel && config.customEmbeds?.punishment?.enabled) {
        const punChannel = guild.channels.cache.get(config.punishmentChannel);
        if (punChannel) {
          const embed = createCustomEmbed(config.customEmbeds.punishment, {
            action: actionLabel,
            user_tag: user.tag,
            user_id: report.reported_id,
            moderator: moderator || 'Dashboard',
            reason: reason || 'Punição via Reporte',
            duration: duration || 'N/A',
            reporter_id: report.reporter_id
          });
          if (report.image_url) embed.setImage(report.image_url);
          await punChannel.send({ embeds: [embed] });
        }
      }

      res.json({ success: true, message: `Reporte resolvido com ação: ${actionLabel}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update report status
  app.patch('/api/reports/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'pending', 'resolved', 'rejected'

    if (!['pending', 'resolved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }

    try {
      let query = 'UPDATE reports SET status = $1';
      const params = [status, id];

      if (status === 'rejected') {
        query += ', rejected_at = CURRENT_TIMESTAMP';
      } else {
        query += ', rejected_at = NULL';
      }

      query += ' WHERE id = $2 RETURNING *';

      const result = await pool.query(query, params);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reporte não encontrado' });
      }

      const report = result.rows[0];
      const config = require('../../config').getConfig();

      // Se resolvido, notificar no canal de punidos
      if (status === 'resolved' && config.punishmentChannel && config.customEmbeds?.resolvedReport?.enabled) {
        const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
        if (guild) {
          const punChannel = guild.channels.cache.get(config.punishmentChannel);
          if (punChannel) {
            const reportedUser = await client.users.fetch(report.reported_id).catch(() => null);
            
            const embed = createCustomEmbed(config.customEmbeds.resolvedReport, {
              reported_tag: reportedUser ? reportedUser.tag : report.reported_id,
              reported_id: report.reported_id,
              reason: report.reason
            });

            if (report.image_url) embed.setImage(report.image_url);
            
            await punChannel.send({ embeds: [embed] });
          }
        }
      }

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete report
  app.delete('/api/reports/:id', async (req, res) => {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono do servidor pode enviar para lixeira ou excluir reportes.' });
    }

    const { id } = req.params;
    const { permanent } = req.query;

    try {
      if (permanent === 'true') {
        // Hard delete: delete image from storage and then delete from DB
        const { rows } = await pool.query('SELECT image_url FROM reports WHERE id = $1', [id]);
        
        if (rows.length > 0 && rows[0].image_url && rows[0].image_url.includes('storage/v1/object/public/reports/')) {
          const fileName = rows[0].image_url.split('/').pop();
          await supabase.storage.from('reports').remove([fileName]);
        }

        const result = await pool.query('DELETE FROM reports WHERE id = $1 RETURNING *', [id]);
        
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Reporte não encontrado' });
        }

        return res.json({ message: 'Reporte deletado permanentemente', report: result.rows[0] });
      } else {
        // Soft delete (trash)
        const result = await pool.query(
          "UPDATE reports SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
          [id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Reporte não encontrado' });
        }

        return res.json({ message: 'Reporte enviado para a lixeira', report: result.rows[0] });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk delete reports
  app.post('/api/reports/bulk-delete', async (req, res) => {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono do servidor pode enviar para lixeira ou excluir reportes.' });
    }

    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'IDs inválidos' });

    try {
      // Permanent delete if they are already in the trash
      const { rows: currentReports } = await pool.query('SELECT id, status, image_url FROM reports WHERE id = ANY($1)', [ids]);
      
      const reportsInTrash = currentReports.filter(r => r.status === 'deleted');
      const reportsToTrash = currentReports.filter(r => r.status !== 'deleted');

      let deletedCount = 0;

      // 1. Permanent delete for those already in trash
      if (reportsInTrash.length > 0) {
        const trashIds = reportsInTrash.map(r => r.id);
        
        // Cleanup images
        for (const report of reportsInTrash) {
          if (report.image_url && report.image_url.includes('storage/v1/object/public/reports/')) {
            const fileName = report.image_url.split('/').pop();
            await supabase.storage.from('reports').remove([fileName]).catch(console.error);
          }
        }
        
        await pool.query('DELETE FROM reports WHERE id = ANY($1)', [trashIds]);
        deletedCount += reportsInTrash.length;
      }

      // 2. Soft delete for those not in trash
      if (reportsToTrash.length > 0) {
        const activeIds = reportsToTrash.map(r => r.id);
        await pool.query("UPDATE reports SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ANY($1)", [activeIds]);
        deletedCount += reportsToTrash.length;
      }

      res.json({ success: true, message: `${deletedCount} reportes processados.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear trash
  app.delete('/api/reports/trash/clear', async (req, res) => {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ error: 'Apenas o dono do servidor pode limpar a lixeira.' });
    }

    try {
      const { rows: reportsToDelete } = await pool.query("SELECT image_url FROM reports WHERE status = 'deleted'");
      
      // Cleanup images
      for (const report of reportsToDelete) {
        if (report.image_url && report.image_url.includes('storage/v1/object/public/reports/')) {
          const fileName = report.image_url.split('/').pop();
          await supabase.storage.from('reports').remove([fileName]).catch(console.error);
        }
      }

      const result = await pool.query("DELETE FROM reports WHERE status = 'deleted'");
      res.json({ success: true, message: `Lixeira limpa. ${result.rowCount} reportes removidos.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupReportRoutes;