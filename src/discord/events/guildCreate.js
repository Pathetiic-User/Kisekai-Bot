const { AUTHORIZED_GUILD_ID } = require('../../config/constants');

module.exports = function(client) {
  return async (guild) => {
    if (guild.id !== AUTHORIZED_GUILD_ID) {
      console.log(`Tentativa de entrada em servidor não autorizado: ${guild.name}`);
      guild.leave();
      return;
    }
  };
};