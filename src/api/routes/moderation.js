const { AUTHORIZED_GUILD_ID, pool } = require('../../config');
const { addLog, uploadToSupabase, logToChannel } = require('../../utils');
const { EmbedBuilder } = require('discord.js');
const ms = require('ms');

// Helper function to parse duration string to milliseconds
function parseDurationToMs(duration) {
  if (!duration) return null;
  
  const normalizedDuration = duration.toLowerCase().trim();
  
  const durationMap = {
    'ms': 1,
    's': 1000, 'sec': 1000, 'secs': 1000, 'second': 1000, 'seconds': 1000,
    'm': 60 * 1000, 'min': 60 * 1000, 'mins': 60 * 1000, 'minute': 60 * 1000, 'minutes': 60 * 1000,
    'h': 60 * 60 * 1000, 'hr': 60 * 60 * 1000, 'hrs': 60 * 60 * 1000, 'hour': 60 * 60 * 1000, 'hours': 60 * 60 * 1000,
    'd': 24 * 60 * 60 * 1000, 'day': 24 * 60 * 60 * 1000, 'days': 24 * 60 * 60 * 1000,
    'w': 7 * 24 * 60 * 60 * 1000, 'wk': 7 * 24 * 60 * 60 * 1000, 'wks': 7 * 24 * 60 * 60 * 1000, 'week': 7 * 24 * 60 * 60 * 1000, 'weeks': 7 * 24 * 60 * 60 * 1000,
    'mo': 30 * 24 * 60 * 60 * 1000, 'month': 30 * 24 * 60 * 60 * 1000, 'months': 30 * 24 * 60 * 60 * 1000,
    'y': 365 * 24 * 60 * 60 * 1000, 'year': 365 * 24 * 60 * 60 * 1000, 'years': 365 * 24 * 60 * 60 * 1000,
  };
  
  let totalMs = 0;
  const pattern = /(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|year|years)\b/gi;
  
  let match;
  let foundAny = false;
  
  while ((match = pattern.exec(normalizedDuration)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs = durationMap[unit] || 0;
    
    if (unitMs > 0) {
      totalMs += value * unitMs;
      foundAny = true;
    }
  }
  
  if (!foundAny) {
    const simpleMatch = normalizedDuration.match(/^(\d+)([a-z]+)$/i);
    if (simpleMatch) {
      const value = parseInt(simpleMatch[1]);
      const unit = simpleMatch[2].toLowerCase();
      const unitMs = durationMap[unit] || 0;
      totalMs = value * unitMs;
      foundAny = unitMs > 0;
    }
  }
  
  return foundAny ? totalMs : null;
}

// Helper function to calculate punishment status
function calculatePunishmentStatus(log, isCurrentlyBanned, isCurrentlyMuted, muteEndsAt, activeBanTimestamp, activeMuteTimestamp) {
  const action = log.action.toLowerCase();
  const isBan = action === 'ban';
  const isMute = action === 'mute';
  
  if (!isBan && !isMute) {
    return { status: 'N/A', expiresAt: null, remainingMs: null, isActive: false };
  }
  
  // Parse duration
  const durationMs = parseDurationToMs(log.duration);
  
  // If permanent ban
  if (isBan && log.duration === 'permanent') {
    // Check if THIS ban is the active one by comparing timestamps
    const isThisActiveBan = isCurrentlyBanned && activeBanTimestamp && 
      new Date(log.timestamp).getTime() >= new Date(activeBanTimestamp).getTime();
    
    if (isThisActiveBan) {
      return { status: 'Ativo', expiresAt: null, remainingMs: null, isPermanent: true, isActive: true };
    } else {
      return { status: 'Expirando', expiresAt: null, remainingMs: null, isPermanent: true, isActive: false };
    }
  }
  
  // Calculate expiry time
  if (!durationMs || !log.timestamp) {
    return { status: 'N/A', expiresAt: null, remainingMs: null, isActive: false };
  }
  
  const startTime = new Date(log.timestamp).getTime();
  const expiresAt = new Date(startTime + durationMs);
  const now = Date.now();
  const remainingMs = expiresAt.getTime() - now;
  
  // Check if THIS specific punishment is still active by comparing timestamps
  let isActive = false;
  
  if (isBan && isCurrentlyBanned) {
    // For bans: check if this ban's timestamp matches the most recent ban
    isActive = activeBanTimestamp && 
      Math.abs(new Date(log.timestamp).getTime() - new Date(activeBanTimestamp).getTime()) < 1000; // Within 1 second tolerance
  } else if (isMute && isCurrentlyMuted && muteEndsAt && new Date(muteEndsAt) > now) {
    // For mutes: check if this mute's calculated end time matches the actual mute end time
    const calculatedEndsAt = startTime + durationMs;
    const actualMuteEndsAt = new Date(muteEndsAt).getTime();
    // Allow 5 second tolerance for timing differences
    isActive = Math.abs(calculatedEndsAt - actualMuteEndsAt) < 5000;
  }
  
  if (isActive) {
    // Punishment is active - show countdown
    return { 
      status: 'Ativo', 
      expiresAt: expiresAt.toISOString(), 
      remainingMs: Math.max(0, remainingMs),
      durationMs,
      isActive: true
    };
  } else {
    // Punishment is not active - check if it was removed early or expired naturally
    const hasExpired = remainingMs <= 0;
    
    if (hasExpired) {
      // Expired naturally
      return { status: 'Expirado', expiresAt: expiresAt.toISOString(), remainingMs: 0, durationMs, isActive: false };
    } else {
      // Removed manually before expiry
      return { status: 'Expirando', expiresAt: expiresAt.toISOString(), remainingMs: 0, durationMs, isActive: false };
    }
  }
}

// Format duration for display
function formatDuration(duration) {
  if (!duration || duration === 'permanent') return 'Permanente';
  return duration;
}

// Get report info for embeds
async function getReportInfo(reportId) {
  if (!reportId) return null;
  try {
    const result = await pool.query(
      'SELECT timestamp, reporter_id FROM reports WHERE id = $1',
      [reportId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error fetching report info:', err);
    return null;
  }
}

// Get total warns for user
async function getTotalWarns(userId) {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) FROM logs WHERE user_id = $1 AND action ILIKE 'warn%'",
      [userId]
    );
    return parseInt(result.rows[0].count) || 0;
  } catch (err) {
    console.error('Error fetching warn count:', err);
    return 0;
  }
}

// Send warn embed to punishment channel
async function sendWarnEmbed(guild, user, moderator, reason, reportId, reporterId) {
  const { getConfig } = require('../../config');
  const config = getConfig();
  
  if (!config.punishmentChannel) return;
  
  const channel = guild.channels.cache.get(config.punishmentChannel);
  if (!channel) return;
  
  const reportInfo = await getReportInfo(reportId);
  const totalWarns = await getTotalWarns(user.id);
  
  const data = reportInfo ? new Date(reportInfo.timestamp) : new Date();
  const formattedDate = data.toLocaleDateString('pt-BR');
  
  // Fetch reporter name
  let reporterName = 'Desconhecido';
  if (reportInfo?.reporter_id || reporterId) {
    try {
      const reporter = await guild.client.users.fetch(reportInfo?.reporter_id || reporterId);
      reporterName = reporter.username;
    } catch (e) {
      reporterName = 'Desconhecido';
    }
  }
  
  const embed = new EmbedBuilder()
    .setTitle('⚠️ Usuário Advertido')
    .setColor(15774216)
    .setImage('https://c.tenor.com/yPN5IxWh-xwAAAAC/tenor.gif')
    .setDescription(`O reporte realizado em **${formattedDate}** por **${reporterName}** foi analisado e as medidas necessárias foram aplicadas ao usuário ${user}.`)
    .addFields(
      {
        name: '📋 Detalhes',
        value: `• Administrador: <@${moderator.id || moderator}>\n• Motivo: ${reason || 'Não informado'}\n• Total de advertências: ${totalWarns}`
      },
      {
        name: '⚠️ Aviso',
        value: 'Advertências são registradas em nosso sistema. Quanto maior a quantidade, mais severas serão as punições futuras.'
      }
    )
    .setTimestamp();
  
  await channel.send({ embeds: [embed] });
}

// Send DM before ban
async function sendBanDM(user, guild, reason, duration, isPermanent, moderator, reportInfo, reporterName) {
  try {
    const data = reportInfo ? new Date(reportInfo.timestamp) : new Date();
    const formattedDate = data.toLocaleDateString('pt-BR');
    
    let embed;
    
    if (isPermanent) {
      embed = new EmbedBuilder()
        .setTitle('🚫 Você foi banido permanentemente')
        .setColor(15158332)
        .setDescription(`Você foi banido permanentemente do servidor **${guild.name}**.`)
        .addFields(
          {
            name: '📋 Detalhes',
            value: `• Motivo: ${reason || 'Não informado'}\n• Data: ${formattedDate}`
          },
          {
            name: '⚠️ Aviso',
            value: 'Este banimento é permanente e não poderá ser revertido.'
          }
        )
        .setImage('https://c.tenor.com/w3KbwTJ-F5IAAAAd/tenor.gif')
        .setTimestamp();
    } else {
      embed = new EmbedBuilder()
        .setTitle('🚫 Usuário Banido')
        .setColor(15158332)
        .setImage('https://c.tenor.com/w3KbwTJ-F5IAAAAd/tenor.gif')
        .setDescription(`O reporte realizado em **${formattedDate}** por **${reporterName}** foi analisado e resultou no banimento do usuário ${user}.`)
        .addFields(
          {
            name: '📋 Detalhes',
            value: `• Administrador: ${moderator.username || moderator}\n• Motivo: ${reason || 'Não informado'}\n• Duração: ${formatDuration(duration)}`
          },
          {
            name: '⚠️ Aviso',
            value: 'Banimentos permanentes são irreversíveis. Revise as regras antes de interagir novamente em nossas plataformas.'
          }
        )
        .setTimestamp();
    }
    
    await user.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.error(`Não foi possível enviar DM para ${user.tag}:`, e.message);
    return false;
  }
}

// Send ban embed to punishment channel
async function sendBanEmbed(guild, user, moderator, reason, duration, isPermanent, reportId, reporterId) {
  const { getConfig } = require('../../config');
  const config = getConfig();
  
  if (!config.punishmentChannel) return;
  
  const channel = guild.channels.cache.get(config.punishmentChannel);
  if (!channel) return;
  
  const reportInfo = await getReportInfo(reportId);
  const data = reportInfo ? new Date(reportInfo.timestamp) : new Date();
  const formattedDate = data.toLocaleDateString('pt-BR');
  
  // Fetch reporter name
  let reporterName = 'Desconhecido';
  if (reportInfo?.reporter_id || reporterId) {
    try {
      const reporter = await guild.client.users.fetch(reportInfo?.reporter_id || reporterId);
      reporterName = reporter.username;
    } catch (e) {
      reporterName = 'Desconhecido';
    }
  }
  
  const embed = new EmbedBuilder()
    .setTitle('🚫 Usuário Banido')
    .setColor(15158332)
    .setImage('https://c.tenor.com/w3KbwTJ-F5IAAAAd/tenor.gif')
    .setDescription(`O reporte realizado em **${formattedDate}** por **${reporterName}** foi analisado e resultou no banimento do usuário ${user}.`)
    .addFields(
      {
        name: '📋 Detalhes',
        value: `• Administrador: <@${moderator.id || moderator}>\n• Motivo: ${reason || 'Não informado'}\n• Duração: ${isPermanent ? 'Permanente' : formatDuration(duration)}`
      },
      {
        name: '⚠️ Aviso',
        value: 'Banimentos permanentes são irreversíveis. Revise as regras antes de interagir novamente em nossas plataformas.'
      }
    )
    .setTimestamp();
  
  await channel.send({ embeds: [embed] });
}

// Send mute embed to punishment channel
async function sendMuteEmbed(guild, user, moderator, reason, duration, reportId, reporterId) {
  const { getConfig } = require('../../config');
  const config = getConfig();
  
  if (!config.punishmentChannel) return;
  
  const channel = guild.channels.cache.get(config.punishmentChannel);
  if (!channel) return;
  
  const reportInfo = await getReportInfo(reportId);
  const data = reportInfo ? new Date(reportInfo.timestamp) : new Date();
  const formattedDate = data.toLocaleDateString('pt-BR');
  
  // Fetch reporter name
  let reporterName = 'Desconhecido';
  if (reportInfo?.reporter_id || reporterId) {
    try {
      const reporter = await guild.client.users.fetch(reportInfo?.reporter_id || reporterId);
      reporterName = reporter.username;
    } catch (e) {
      reporterName = 'Desconhecido';
    }
  }
  
  const embed = new EmbedBuilder()
    .setTitle('🔇 Usuário Silenciado')
    .setColor(6447716)
    .setImage('https://c.tenor.com/aw9kafHjB2YAAAAC/tenor.gif')
    .setDescription(`O reporte realizado em **${formattedDate}** por **${reporterName}** foi analisado e resultou no silenciamento do usuário ${user}.`)
    .addFields(
      {
        name: '📋 Detalhes',
        value: `• Administrador: <@${moderator.id || moderator}>\n• Motivo: ${reason || 'Não informado'}\n• Duração: ${formatDuration(duration)}`
      },
      {
        name: '⚠️ Aviso',
        value: 'Durante o período de silenciamento, o usuário não poderá enviar mensagens ou interagir nos canais do servidor.'
      }
    )
    .setTimestamp();
  
  await channel.send({ embeds: [embed] });
}

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
        let durationMs = null;
        
        // Calculate end time if duration is set and not permanent
        if (banInfo.duration && banInfo.timestamp && banInfo.duration !== 'permanent') {
          durationMs = parseDurationToMs(banInfo.duration);
          if (durationMs) {
            endsAt = new Date(new Date(banInfo.timestamp).getTime() + durationMs);
          }
        }
        
        return {
          type: 'ban',
          userId: b.user.id,
          username: b.user.username,
          reason: b.reason || (banInfo.duration ? `Ban ${banInfo.duration === 'permanent' ? 'Permanente' : banInfo.duration}` : null),
          avatarURL: b.user.displayAvatarURL(),
          duration: banInfo.duration || null,
          timestamp: banInfo.timestamp || null,
          endsAt: endsAt,
          isPermanent: banInfo.duration === 'permanent'
        };
      });

      // For mutes, we need to fetch all members and check for communicationDisabledUntil
      const members = await guild.members.fetch();
      const mutes = members.filter(m => m.communicationDisabledUntil && m.communicationDisabledUntil > new Date());
      
      // Get mute info from database
      const formattedMutes = await Promise.all(mutes.map(async (m) => {
        const logResult = await pool.query(
          "SELECT duration, timestamp, reason FROM logs WHERE user_id = $1 AND action ILIKE 'mute%' ORDER BY timestamp DESC LIMIT 1",
          [m.user.id]
        );
        const muteInfo = logResult.rows[0] || {};
        
        return {
          type: 'mute',
          userId: m.user.id,
          username: m.user.username,
          reason: muteInfo.reason || 'N/A (Timeout ativo)',
          avatarURL: m.user.displayAvatarURL(),
          endsAt: m.communicationDisabledUntil,
          duration: muteInfo.duration || null,
          timestamp: muteInfo.timestamp || null
        };
      }));

      res.json({ bans: formattedBans, mutes: formattedMutes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get punished users
  app.get('/api/moderation/punished-users', async (req, res) => {
    const { filter } = req.query; // ban, mute, warn
    try {
      let query = `
        SELECT user_id, MAX(timestamp) as last_punishment
        FROM logs
        WHERE type = 'Administrativa' AND action IN ('ban', 'mute', 'warn')
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
      
      // Log the unban action
      await addLog(userId, 'unban', 'Removido da lista de banidos via Dashboard', requesterId, 'Administrativa');
      
      res.json({ success: true, message: 'Usuário desbanido' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unmute user
  app.post('/api/moderation/unmute', async (req, res) => {
    const { userId } = req.body;
    const requesterId = req.user?.id;
    
    try {
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        return res.status(404).json({ error: 'Membro não encontrado no servidor.' });
      }

      // Remove timeout
      await member.timeout(null, 'Removido via Dashboard');
      
      // Log the unmute action
      await addLog(userId, 'unmute', 'Timeout removido via Dashboard', requesterId || 'Dashboard', 'Administrativa');
      
      res.json({ success: true, message: 'Timeout removido' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get moderation history
  app.get('/api/moderation/history', async (req, res) => {
    try {
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
        warnHistory: Object.values(warnHistory) 
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get user moderation history with proper status calculation
  app.get('/api/moderation/history/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
      
      // Get all logs for the user, not just 'Administrativa' type
      const result = await pool.query(
        "SELECT * FROM logs WHERE user_id = $1 ORDER BY timestamp DESC", 
        [userId]
      );
      
      let isBanned = false;
      let isMuted = false;
      let muteEndsAt = null;
      let activeBanTimestamp = null;
      let activeMuteTimestamp = null;

      if (guild) {
        try {
          const banInfo = await guild.bans.fetch(userId).catch(() => null);
          isBanned = !!banInfo;
          
          // Get the timestamp of the most recent ban from database if user is banned
          if (isBanned) {
            const activeBanResult = await pool.query(
              "SELECT timestamp FROM logs WHERE user_id = $1 AND action ILIKE 'ban%' ORDER BY timestamp DESC LIMIT 1",
              [userId]
            );
            if (activeBanResult.rows.length > 0) {
              activeBanTimestamp = activeBanResult.rows[0].timestamp;
            }
          }

          const member = await guild.members.fetch(userId).catch(() => null);
          if (member && member.communicationDisabledUntil && member.communicationDisabledUntil > new Date()) {
            isMuted = true;
            muteEndsAt = member.communicationDisabledUntil;
            
            // Get the timestamp of the most recent mute from database if user is muted
            const activeMuteResult = await pool.query(
              "SELECT timestamp FROM logs WHERE user_id = $1 AND action ILIKE 'mute%' ORDER BY timestamp DESC LIMIT 1",
              [userId]
            );
            if (activeMuteResult.rows.length > 0) {
              activeMuteTimestamp = activeMuteResult.rows[0].timestamp;
            }
          }
        } catch (e) {
          console.error('Error fetching Discord status:', e);
        }
      }

      // Process history with correct status calculation
      const history = result.rows.map(row => {
        const statusInfo = calculatePunishmentStatus(row, isBanned, isMuted, muteEndsAt, activeBanTimestamp, activeMuteTimestamp);
        
        return {
          ...row,
          status: statusInfo.status,
          expiresAt: statusInfo.expiresAt,
          remainingMs: statusInfo.remainingMs,
          isPermanent: statusInfo.isPermanent || false,
          isActive: statusInfo.isActive || false
        };
      });

      const summary = {
        bans: history.filter(h => h.action.toLowerCase() === 'ban'),
        mutes: history.filter(h => h.action.toLowerCase() === 'mute'),
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

  // Moderate user (ban, mute, warn)
  app.post('/api/moderate/:action', async (req, res) => {
    const { action } = req.params;
    const { userId, reason, duration, moderator, reporterId, reportId } = req.body;
    let { evidenceUrl } = req.body;
    const guildId = client.guilds.cache.first()?.id;

    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    // Validate action - only allow ban, mute, warn
    if (!['ban', 'mute', 'warn'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Allowed actions: ban, mute, warn' });
    }

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

      const moderatorUser = moderator || 'Dashboard';
      const isPermanent = duration === 'permanent';
      
      // Get report info for embeds
      const reportInfo = await getReportInfo(reportId);
      
      // Fetch reporter name for embeds
      let reporterName = 'Desconhecido';
      if (reportInfo?.reporter_id || reporterId) {
        try {
          const reporter = await client.users.fetch(reportInfo?.reporter_id || reporterId);
          reporterName = reporter.username;
        } catch (e) {
          reporterName = 'Desconhecido';
        }
      }
      
      switch (action) {
        case 'ban':
          // Send DM BEFORE ban
          await sendBanDM(user, guild, reason || 'Não informado', duration, isPermanent, moderatorUser, reportInfo, reporterName);
          
          // Apply ban
          await guild.members.ban(userId, { reason: reason || 'Banned via Dashboard' });
          
          // Send embed to punishment channel
          await sendBanEmbed(guild, user, moderatorUser, reason, duration, isPermanent, reportId, reporterId);
          break;
          
        case 'mute':
          if (!member) return res.status(400).json({ error: 'Member not in guild' });
          
          // Apply timeout
          await member.timeout(duration ? ms(duration) : ms('10m'), reason || 'Muted via Dashboard');
          
          // Send embed to punishment channel
          await sendMuteEmbed(guild, user, moderatorUser, reason, duration, reportId, reporterId);
          break;
          
        case 'warn':
          // NO DM for warnings
          // Just log and send embed to punishment channel
          await sendWarnEmbed(guild, user, moderatorUser, reason, reportId, reporterId);
          break;
      }

      await addLog(userId, action, reason || 'Action via Dashboard', moderatorUser, 'Administrativa', duration);
      
      // Update report status if reportId is provided
      if (reportId) {
        await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [reportId]);
      }

      // Log to standard channel
      await logToChannel(guild, action, `User: ${user.tag}\nReason: ${reason || 'No reason'}\nModerator: ${moderatorUser}`);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupModerationRoutes;