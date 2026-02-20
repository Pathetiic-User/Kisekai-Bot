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
  lastActionTime: null,
  lastError: null
};

// Lock para evitar ações concorrentes
let isTransitioning = false;
let transitionTimeout = null;

// EventEmitter para notificar mudanças de estado
const EventEmitter = require('events');
const botStateEmitter = new EventEmitter();

/**
 * Verifica se o client está realmente conectado ao Discord
 * @returns {boolean}
 */
function isClientConnected() {
  try {
    // Verifica múltiplos indicadores de conexão
    return client.isReady?.() && 
           client.ws?.status === 0 && // 0 = Ready
           client.user !== null;
  } catch {
    return false;
  }
}

/**
 * Obtém o status do gateway como string
 * @returns {string}
 */
function getGatewayStatusString() {
  const statusMap = {
    0: 'Online',
    1: 'Conectando',
    2: 'Reconectando',
    3: 'Inativo',
    4: 'Inicializando',
    5: 'Desconectado',
    6: 'Aguardando Guildas',
    7: 'Identificando',
    8: 'Retomando'
  };
  return statusMap[client.ws?.status] || 'Desconhecido';
}

/**
 * Obtém o estado atual do bot sincronizado com a realidade
 * @returns {Object}
 */
function getBotState() {
  // Sincroniza o estado com a realidade do client
  const actuallyRunning = isClientConnected();
  
  // Se há discrepância, atualiza o estado
  if (botState.isRunning !== actuallyRunning && !isTransitioning) {
    botState.isRunning = actuallyRunning;
    if (!actuallyRunning && botState.lastAction !== 'stopped') {
      botState.lastAction = 'disconnected';
      botState.lastActionTime = new Date().toISOString();
    }
  }
  
  return {
    ...botState,
    gatewayStatus: getGatewayStatusString(),
    gatewayCode: client.ws?.status ?? -1,
    isTransitioning
  };
}

/**
 * Define o estado do bot
 * @param {Object} state 
 */
function setBotState(state) {
  const oldState = { ...botState };
  botState = { ...botState, ...state };
  
  // Emite evento de mudança de estado
  if (oldState.isRunning !== botState.isRunning) {
    botStateEmitter.emit('stateChange', {
      isRunning: botState.isRunning,
      lastAction: botState.lastAction,
      lastActionTime: botState.lastActionTime,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Adquire o lock para operação de transição
 * @param {number} timeout - Tempo máximo em ms para o lock
 * @returns {boolean} - Se conseguiu adquirir o lock
 */
function acquireTransitionLock(timeout = 30000) {
  if (isTransitioning) {
    return false;
  }
  
  isTransitioning = true;
  
  // Libera automaticamente após timeout (safety)
  if (transitionTimeout) {
    clearTimeout(transitionTimeout);
  }
  transitionTimeout = setTimeout(() => {
    isTransitioning = false;
  }, timeout);
  
  return true;
}

/**
 * Libera o lock de transição
 */
function releaseTransitionLock() {
  isTransitioning = false;
  if (transitionTimeout) {
    clearTimeout(transitionTimeout);
    transitionTimeout = null;
  }
}

/**
 * Verifica se há uma transição em andamento
 * @returns {boolean}
 */
function isInTransition() {
  return isTransitioning;
}

// Eventos do client para sincronização automática
client.on('ready', () => {
  if (!botState.isRunning) {
    setBotState({
      isRunning: true,
      lastAction: 'auto_reconnected',
      lastActionTime: new Date().toISOString(),
      lastError: null
    });
  }
});

client.on('disconnect', (event) => {
  setBotState({
    isRunning: false,
    lastAction: 'disconnected',
    lastActionTime: new Date().toISOString(),
    lastError: `Disconnected: Code ${event.code}`
  });
});

client.on('error', (error) => {
  botState.lastError = error.message;
});

module.exports = {
  client,
  getBotState,
  setBotState,
  isClientConnected,
  getGatewayStatusString,
  acquireTransitionLock,
  releaseTransitionLock,
  isInTransition,
  botStateEmitter
};
