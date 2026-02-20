const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createCustomEmbed } = require('../../utils');

function setupBroadcastRoutes(app, client) {
  // Get message
  app.get('/api/messages/:channelId/:messageId', async (req, res) => {
    const { channelId, messageId } = req.params;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'O canal deve ser de texto' });

      const message = await channel.messages.fetch(messageId);
      if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });

      const payload = {
        content: message.content,
        embeds: message.embeds.map(embed => ({
          title: embed.title,
          description: embed.description,
          url: embed.url,
          color: embed.hexColor,
          timestamp: embed.timestamp,
          author: embed.author ? {
            name: embed.author.name,
            iconURL: embed.author.iconURL,
            url: embed.author.url
          } : null,
          footer: embed.footer ? {
            text: embed.footer.text,
            iconURL: embed.footer.iconURL
          } : null,
          image: embed.image ? { url: embed.image.url } : null,
          thumbnail: embed.thumbnail ? { url: embed.thumbnail.url } : null,
          fields: embed.fields.map(f => ({
            name: f.name,
            value: f.value,
            inline: f.inline
          }))
        }))
      };

      res.json(payload);
    } catch (err) {
      console.error('Error fetching message:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Broadcast message
  app.post('/api/broadcast', async (req, res) => {
    const { channelId, content, embeds, components } = req.body;
    if (!channelId) return res.status(400).json({ error: 'Missing channelId' });

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });

      // Converte components do JSON do Discord para objetos Discord.js
      const buildComponents = (rawComponents) => {
        if (!rawComponents || !Array.isArray(rawComponents)) return [];
        return rawComponents.map(row => {
          if (row.type !== 1) return null; // Apenas ActionRow (type 1)
          const actionRow = new ActionRowBuilder();
          const builtComponents = (row.components || []).map(comp => {
            if (comp.type === 2) { // Button
              const btn = new ButtonBuilder();
              if (comp.style) btn.setStyle(comp.style);
              if (comp.label) btn.setLabel(comp.label);
              if (comp.emoji) btn.setEmoji(comp.emoji);
              if (comp.disabled !== undefined) btn.setDisabled(comp.disabled);
              // Botão de link (style 5) usa URL, outros usam custom_id
              if (comp.style === 5 || comp.style === ButtonStyle.Link) {
                if (comp.url) btn.setURL(comp.url);
              } else {
                if (comp.custom_id) btn.setCustomId(comp.custom_id);
              }
              return btn;
            }
            return null;
          }).filter(Boolean);
          if (builtComponents.length === 0) return null;
          actionRow.addComponents(builtComponents);
          return actionRow;
        }).filter(Boolean);
      };

      const payload = { 
        content, 
        embeds: embeds?.map(e => createCustomEmbed(e)),
        components: buildComponents(components)
      };
      await channel.send(payload);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupBroadcastRoutes;