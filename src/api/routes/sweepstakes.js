const { AUTHORIZED_GUILD_ID, pool } = require('../../config');
const { EmbedBuilder } = require('discord.js');

function setupSweepstakeRoutes(app, client) {
  // Get all sweepstakes
  app.get('/api/sweepstakes', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM sweepstakes ORDER BY id DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create sweepstake
  app.post('/api/sweepstakes', async (req, res) => {
    const { title, description, endTime, maxParticipants, winnersCount, channelId } = req.body;
    const config = require('../../config').getConfig();
    const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
    
    if (!guild) return res.status(500).json({ error: 'Guild not found' });
    const channel = guild.channels.cache.get(channelId || config.sweepstakeChannel);
    if (!channel) return res.status(400).json({ error: 'Canal de sorteio não configurado' });

    try {
      const result = await pool.query(
        'INSERT INTO sweepstakes (guild_id, channel_id, title, description, end_time, max_participants, winners_count) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [AUTHORIZED_GUILD_ID, channel.id, title, description, endTime, maxParticipants, winnersCount]
      );
      const sweepstake = result.rows[0];

      const embed = new EmbedBuilder()
        .setTitle(`🎉 SORTEIO: ${title}`)
        .setDescription(`${description}\n\n**Ganhadores:** ${winnersCount}\n**Termina em:** <t:${Math.floor(new Date(endTime).getTime() / 1000)}:R>\n\nReaja com 🎉 para participar!`)
        .setColor('#ff00ea')
        .setFooter({ text: `ID: ${sweepstake.id} | Máx: ${maxParticipants || 'Ilimitado'}` });

      const message = await channel.send({ embeds: [embed] });
      await message.react('🎉');

      await pool.query('UPDATE sweepstakes SET message_id = $1 WHERE id = $2', [message.id, sweepstake.id]);
      sweepstake.message_id = message.id;

      res.json(sweepstake);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get participants
  app.get('/api/sweepstakes/:id/participants', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM sweepstakes_participants WHERE sweepstake_id = $1',
        [req.params.id]
      );
      
      const enriched = await Promise.all(result.rows.map(async (row) => {
        try {
          const user = await client.users.fetch(row.user_id);
          return {
            ...row,
            username: user.username,
            avatarURL: user.displayAvatarURL()
          };
        } catch (e) {
          return row;
        }
      }));

      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Draw winner
  app.post('/api/sweepstakes/:id/draw', async (req, res) => {
    const { id } = req.params;
    const { manualWinnerId } = req.body;

    try {
      const sweepResult = await pool.query('SELECT * FROM sweepstakes WHERE id = $1', [id]);
      if (sweepResult.rows.length === 0) return res.status(404).json({ error: 'Sorteio não encontrado' });
      const sweepstake = sweepResult.rows[0];

      let winners = [];

      if (manualWinnerId) {
        winners = [manualWinnerId];
      } else {
        const participantsResult = await pool.query('SELECT user_id FROM sweepstakes_participants WHERE sweepstake_id = $1', [id]);
        const participants = participantsResult.rows.map(r => r.user_id);
        
        if (participants.length === 0) return res.status(400).json({ error: 'Nenhum participante' });

        const count = Math.min(sweepstake.winners_count || 1, participants.length);
        for (let i = 0; i < count; i++) {
          const randomIndex = Math.floor(Math.random() * participants.length);
          winners.push(participants.splice(randomIndex, 1)[0]);
        }
      }

      await pool.query('UPDATE sweepstakes SET winners = $1, status = $2 WHERE id = $3', [JSON.stringify(winners), 'ended', id]);

      // Notifications
      for (const winnerId of winners) {
        const winner = await client.users.fetch(winnerId).catch(() => null);
        if (winner) {
          winner.send({ content: `🎊 PARABÉNS! Você ganhou o sorteio: **${sweepstake.title}**!` }).catch(() => null);
        }
      }

      // Send result to channel
      const channel = await client.channels.fetch(sweepstake.channel_id).catch(() => null);
      if (channel) {
        const winnersMention = winners.map(w => `<@${w}>`).join(', ');
        channel.send({ content: `🎉 O sorteio **${sweepstake.title}** terminou!\n🏆 Ganhadores: ${winnersMention}` });
      }

      res.json({ success: true, winners });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete sweepstake
  app.delete('/api/sweepstakes/:id', async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT channel_id, message_id FROM sweepstakes WHERE id = $1', [req.params.id]);
      if (rows.length > 0) {
        const { channel_id, message_id } = rows[0];
        const channel = await client.channels.fetch(channel_id).catch(() => null);
        if (channel && message_id) {
          const msg = await channel.messages.fetch(message_id).catch(() => null);
          if (msg) await msg.delete().catch(() => null);
        }
      }
      await pool.query('DELETE FROM sweepstakes WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupSweepstakeRoutes;