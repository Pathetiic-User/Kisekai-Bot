const ready = require('./ready');
const guildCreate = require('./guildCreate');
const guildMemberAdd = require('./guildMemberAdd');
const messageCreate = require('./messageCreate');

module.exports = {
  ready,
  guildCreate,
  guildMemberAdd,
  messageCreate
};