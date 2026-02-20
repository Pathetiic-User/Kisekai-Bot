const { Client, GatewayIntentBits } = require('discord.js');

// Criar cliente Discord com intents necessários
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences
  ]
});

// Bot state management
let botState = {
  isRunning: true,
  lastAction: null,
  lastActionTime: null
};

function getBotState() {
  return botState;
}

function setBotState(state) {
  botState = { ...botState, ...state };
}

module.exports = {
  client,
  getBotState,
  setBotState
};