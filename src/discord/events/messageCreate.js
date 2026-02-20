// @ts-nocheck
const { PermissionFlagsBits } = require('discord.js');
const ms = require('ms');
const { getConfig } = require('../../config');
const { addLog, logToChannel, createCustomEmbed } = require('../../utils');

// Spam tracking map
const spamMap = new Map();

module.exports = function(client) {
  return async (message) => {
    if (message.author.bot) return;

    const config = getConfig();

    // Anti-spam
    if (config.antiSpam && config.antiSpam.enabled && !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
      const now = Date.now();
      const userData = spamMap.get(message.author.id) || { count: 0, lastMessageTime: now };
      
      if (now - userData.lastMessageTime < config.antiSpam.interval) {
        userData.count++;
      } else {
        userData.count = 1;
      }
      userData.lastMessageTime = now;
      spamMap.set(message.author.id, userData);

      if (userData.count >= config.antiSpam.limit) {
        if (config.antiSpam.autoPunish) {
          try {
            if (config.antiSpam.action === 'mute') {
              const duration = config.antiSpam.muteTime || '10m';
              await message.member.timeout(ms(duration), 'Auto-Mod: Anti-Spam');
              
              if (config.customEmbeds?.warmute?.enabled) {
                const embed = createCustomEmbed(config.customEmbeds.warmute, {
                  user: message.author.toString(),
                  duration: duration
                });
                message.channel.send({ embeds: [embed] });
              } else {
                message.channel.send(`${message.author}, você foi mutado por spam.`);
              }
            } else if (config.antiSpam.action === 'kick') {
              await message.member.kick('Auto-Mod: Anti-Spam');
            }
            await addLog(message.author.id, 'Auto-Punish (Spam)', `Action: ${config.antiSpam.action}`, 'System', 'System');
            await logToChannel(message.guild, 'Auto-Mod', `User: ${message.author.tag} punished for spamming.\nAction: ${config.antiSpam.action}`);
          } catch (err) {
            console.error('Anti-spam punishment failed:', err);
          }
        }
        return;
      }
    }

    // Prefix commands (legacy - can be expanded)
    if (!message.content.startsWith(config.prefix)) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
  };
};