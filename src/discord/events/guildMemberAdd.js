const { getConfig } = require('../../config');
const { logToChannel, createCustomEmbed } = require('../../utils');

module.exports = function(client) {
  return async (member) => {
    // Nunca alterar cargos de bots
    if (member.user.bot) return;

    const config = getConfig();

    // Auto-role
    if (config.autoRole) {
      const role = member.guild.roles.cache.get(config.autoRole);
      if (role) {
        try {
          await member.roles.add(role);
          await logToChannel(member.guild, 'Auto-Role', `Added auto-role to ${member.user.tag}`);
        } catch (err) {
          console.error('Error adding auto-role:', err);
        }
      }
    }

    // Welcome message
    if (config.customEmbeds?.welcome?.enabled && config.customEmbeds.welcome.channel) {
      const channel = member.guild.channels.cache.get(config.customEmbeds.welcome.channel);
      if (channel) {
        const botCount = member.guild.members.cache.filter(m => m.user.bot).size;
        const humanCount = member.guild.memberCount - botCount;
        
        const embed = createCustomEmbed(config.customEmbeds.welcome, {
          user: member.user.toString(),
          username: member.user.username,
          userId: member.user.id,
          userType: member.user.bot ? 'APP' : 'Membro',
          botTag: member.user.bot ? ' [APP]' : '',
          guild: member.guild.name,
          memberCount: humanCount.toString(),
          botCount: botCount.toString(),
          totalCount: member.guild.memberCount.toString()
        });
        channel.send({ embeds: [embed] }).catch(console.error);
      }
    }
  };
};