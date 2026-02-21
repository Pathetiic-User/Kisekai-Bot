mconst { AUTHORIZED_GUILD_ID, pool } = require('../../config');
const { addLog, createCustomEmbed, uploadToSupabase, logToChannel } = require('../../utils');
const ms = require('ms');

function setupModerationRoutes(app, client) {
  // Get punishments
  app.get('/api/moderation/punishments', async (req, res) => {
    try {
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });

      const bans = await guild.bans.fetch();
      
      // Get ban durations from database
      const banDurations = {};
      for (const ban of bans.values()) {
        const logResult = await pool.query(
          "SELECT duration, timestamp FROM logs WHERE user_id = $1 AND action ILIKE 'ban%' ORDER BY timestamp DESC LIMIT 1",
          [ban.user.id]
        );
        if (logResult.rows.length > 0) {
          banDurations[ban.user.id] = {
            duration: logResult.rows[0].duration,
            timestamp: logResult.rows[0].timestamp
          };
        }
      }
      
      const formattedBans = bans.map(b => {
        const banInfo = banDurations[b.user.id] || {};
        let endsAt = null;
        
        // Calculate end time if duration is set and not permanent
        if (banInfo.duration && banInfo.timestamp && banInfo.duration !== 'permanent') {
          const durationMs = ms(banInfo.duration);
          if (durationMs) {
            endsAt = new Date(new Date(banInfo.timestamp).getTime() + durationMs);
          }
        }
        
        return {
          type: 'ban',
          userId: b.user.id,
          username: b.user.username,
          reason: b.reason || banInfo.duration ? `Ban ${banInfo.duration === 'permanent' ? 'Permanente' : banInfo.duration}` : null,
          avatarURL: b.user.displayAvatarURL(),
          duration: banInfo.duration || null,
          timestamp: banInfo.timestamp || null,
          endsAt: endsAt
        };
      });

      // For mutes, we need to fetch all members and check for communicationDisabledUntil
      const members = await guild.members.fetch();
      const mutes = members.filter(m => m.communicationDisabledUntil && m.communicationDisabledUntil > new Date());
      const formattedMutes = mutes.map(m => ({
        type: 'mute',
        userId: m.user.id,
        username: m.user.username,
        reason: 'N/A (Timeout ativo)',
        avatarURL: m.user.displayAvatarURL(),
        endsAt: m.communicationDisabledUntil
      }));

      res.json({ bans: formattedBans, mutes: formattedMutes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get punished users
  app.get('/api/moderation/punished-users', async (req, res) => {
    const { filter } = req.query; // ban, mute, kick, warn
    try {
      let query = `
        SELECT user_id, MAX(timestamp) as last_punishment
        FROM logs
        WHERE type = 'Administrativa' AND action != 'innocent'
      `;
      const params = [];

      if (filter) {
        query += ` AND action ILIKE $1`;
        params.push(`${filter}%`);
      }

      query += ` GROUP BY user_id ORDER BY last_punishment DESC`;

      const result = await pool.query(query, params);

      const users = await Promise.all(result.rows.map(async (row) => {
        try {
          const user = await client.users.fetch(row.user_id);
          return {
            id: user.id,
            username: user.username,
            avatarURL: user.displayAvatarURL(),
            last_punishment: row.last_punishment
          };
        } catch (e) {
          return {
            id: row.user_id,
            username: 'Unknown',
            avatarURL: null,
            last_punishment: row.last_punishment
          };
        }
      }));

      res.json(users);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unban user (Owner only)
  app.post('/api/moderation/unban', async (req, res) => {
    const { userId } = req.body;
    const requesterId = req.user?.id;
    
    try {
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });

      // Check if requester is the guild owner
      if (!requesterId || requesterId !== guild.ownerId) {
        return res.status(403).json({ error: 'Apenas o dono do servidor pode desbanir usuários.' });
      }

      await guild.members.unban(userId);
      res.json({ success: true, message: 'Usuário desbanido' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get moderation history
  app.get('/api/moderation/history', async (req, res) => {
    try {
      const kicksRaw = await pool.query("SELECT * FROM logs WHERE action ILIKE 'kick' ORDER BY timestamp DESC");
      const kicks = await Promise.all(kicksRaw.rows.map(async (row) => {
        try {
          const user = await client.users.fetch(row.user_id);
          return { ...row, username: user.username, avatarURL: user.displayAvatarURL() };
        } catch (e) {
          return { ...row, username: 'Unknown', avatarURL: null };
        }
      }));

      const warns = await pool.query("SELECT * FROM logs WHERE action ILIKE 'warn%' ORDER BY timestamp DESC");
      
      // Group warnings by user
      const warnHistory = {};
      for (const row of warns.rows) {
        if (!warnHistory[row.user_id]) {
          try {
            const user = await client.users.fetch(row.user_id);
            warnHistory[row.user_id] = {
              userId: row.user_id,
              username: user.username,
              avatarURL: user.displayAvatarURL(),
              warnings: []
            };
          } catch (e) {
            warnHistory[row.user_id] = {
              userId: row.user_id,
              username: 'Unknown',
              avatarURL: null,
              warnings: []
            };
          }
        }
        warnHistory[row.user_id].warnings.push({
          id: row.id,
          reason: row.reason,
          moderator: row.moderator,
          timestamp: row.timestamp
        });
      }

      res.json({ 
        kicks, 
        warnHistory: Object.values(warnHistory) 
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get user moderation history
  app.get('/api/moderation/history/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      
      const result = await pool.query(
        "SELECT * FROM logs WHERE user_id = $1 AND type = 'Administrativa' AND action != 'innocent' ORDER BY timestamp DESC", 
        [userId]
      );
      
      let isBanned = false;
      let isMuted = false;
      let muteEndsAt = null;

      if (guild) {
        try {
          const banInfo = await guild.bans.fetch(userId).catch(() => null);
          isBanned = !!banInfo;

          const member = await guild.members.fetch(userId).catch(() => null);
          if (member && member.communicationDisabledUntil && member.communicationDisabledUntil > new Date()) {
            isMuted = true;
            muteEndsAt = member.communicationDisabledUntil;
          }
        } catch (e) {
          console.error('Error fetching Discord status:', e);
        }
      }

      const history = result.rows.map(row => {
        let status = 'Expirado';
        const action = row.action.toLowerCase();
        
        if (action === 'ban' && isBanned) {
          status = 'Em Execução';
        } else if (action === 'mute' && isMuted) {
          status = 'Em Execução';
        }

        return {
          ...row,
          status
        };
      });

      const summary = {
        bans: history.filter(h => h.action.toLowerCase() === 'ban'),
        mutes: history.filter(h => h.action.toLowerCase() === 'mute'),
        kicks: history.filter(h => h.action.toLowerCase() === 'kick'),
        warns: history.filter(h => h.action.toLowerCase().startsWith('warn'))
      };

      res.json({
        userId,
        isBanned,
        isMuted,
        muteEndsAt,
        history,
        summary
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Moderate user (kick, ban, mute, warn)
  app.post('/api/moderate/:action', async (req, res) => {
    const { action } = req.params;
    const { userId, reason, duration, moderator, reporterId, reportId } = req.body;
    let { evidenceUrl } = req.body;
    const guildId = client.guilds.cache.first()?.id;

    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    try {
      const guild = client.guilds.cache.get(req.body.guildId || guildId);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });

      const member = await guild.members.fetch(userId).catch(() => null);
      const user = member ? member.user : await client.users.fetch(userId).catch(() => null);

      if (!user) return res.status(404).json({ error: 'User not found' });

      // Handle file upload if present
      if (req.file) {
        const fileExt = req.file.originalname.split('.').pop();
        const fileName = `mod-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        const uploadResult = await uploadToSupabase(req.file.buffer, fileName, req.file.mimetype);
        if (uploadResult) {
          evidenceUrl = uploadResult.publicUrl;
        }
      }

      let actionLabel = action;
      const config = require('../../config').getConfig();
      
      switch (action) {
        case 'kick':
          if (!member) return res.status(400).json({ error: 'Member not in guild' });
          await member.kick(reason || 'Kicked via Dashboard');
          break;
        case 'ban':
          await guild.members.ban(userId, { reason: reason || 'Banned via Dashboard' });
          break;
        case 'mute':
          if (!member) return res.status(400).json({ error: 'Member not in guild' });
          await member.timeout(duration ? ms(duration) : ms('10m'), reason || 'Muted via Dashboard');
          break;
        case 'warn':
          try {
            const { EmbedBuilder } = require('discord.js');
            const warnEmbed = new EmbedBuilder()
              .setTitle('⚠️ Advertência Recebida')
              .setDescription(`Você recebeu uma advertência no servidor **${guild.name}**.`)
              .addFields(
                { name: 'Motivo', value: reason || 'Não informado' },
                { name: 'Moderador', value: moderator || 'Dashboard' }
              )
              .setColor('#ffff00')
              .setTimestamp();
            await user.send({ embeds: [warnEmbed] });
          } catch (e) {
            console.error(`Não foi possível enviar DM para ${user.tag}`);
          }
          break;
        case 'innocent':
          // No action needed for Discord user, just database log and report resolution
          actionLabel = 'innocent';
          break;
        default:
          return res.status(400).json({ error: 'Invalid action' });
      }

      await addLog(userId, actionLabel, reason || 'Action via Dashboard', moderator || 'Dashboard', 'Administrativa', duration);
      
      // Update report status if reportId is provided
      if (reportId) {
        if (action === 'innocent') {
          await pool.query("UPDATE reports SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP WHERE id = $1", [reportId]);
        } else {
          await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [reportId]);
        }
      }

      // Log to standard channel (Only for punishments)
      if (action !== 'innocent') {
        await logToChannel(guild, actionLabel, `User: ${user.tag}\nReason: ${reason || 'No reason'}\nModerator: ${moderator || 'Dashboard'}`);

        // Log to Punishments Channel (Skip if action is warn)
        if (action !== 'warn' && config.punishmentChannel && config.customEmbeds?.punishment?.enabled) {
          const punChannel = guild.channels.cache.get(config.punishmentChannel);
          if (punChannel) {
            const embed = createCustomEmbed(config.customEmbeds.punishment, {
              action: actionLabel,
              user_tag: user.tag,
              user_id: userId,
              moderator: moderator || 'Dashboard',
              reason: reason || 'Não informado',
              duration: duration || 'N/A',
              reporter_id: reporterId || 'N/A'
            });

            if (evidenceUrl) embed.setImage(evidenceUrl);
            await punChannel.send({ embeds: [embed] });
          }
        }
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupModerationRoutes;