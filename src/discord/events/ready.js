const { AUTHORIZED_GUILD_ID } = require('../../config/constants');
const { getConfig } = require('../../config');

module.exports = function(client) {
  return async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    
    const guild = client.guilds.cache.get(AUTHORIZED_GUILD_ID);
    if (guild) {
      try {
        await guild.members.fetch({ withPresences: true });
        console.log(`Membros e presenças carregados para a guilda: ${guild.name}`);
      } catch (err) {
        console.error(`Erro ao carregar membros da guilda ${guild.name}:`, err);
      }
    }

    // Security: Leave unauthorized guilds
    client.guilds.cache.forEach(g => {
      if (g.id !== AUTHORIZED_GUILD_ID) {
        console.log(`Saindo de servidor não autorizado: ${g.name} (${g.id})`);
        g.leave();
      }
    });

    // Register Slash Commands
    const commands = [
      {
        name: 'reportar',
        description: 'Reporta um usuário por má conduta',
        options: [
          {
            name: 'usuario',
            type: 6, // USER
            description: 'O usuário que você deseja reportar',
            required: true
          },
          {
            name: 'motivo',
            type: 3, // STRING
            description: 'O motivo do reporte',
            required: true
          },
          {
            name: 'prova',
            type: 11, // ATTACHMENT
            description: 'Imagem ou vídeo provando a conduta',
            required: true
          }
        ]
      }
    ];

    try {
      await client.application.commands.set(commands);
      console.log('Slash commands registered!');
    } catch (err) {
      console.error('Error registering slash commands:', err);
    }
  };
};