const WebSocket = require('ws');

// WebSocket clients
const clients = new Set();

// Referência ao servidor WebSocket
let wss = null;

/**
 * Inicializa o servidor WebSocket
 * @param {http.Server} server - Servidor HTTP existente
 * @param {EventEmitter} botStateEmitter - Emitter de mudanças de estado do bot
 */
function initWebSocket(server, botStateEmitter) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  console.log('WebSocket server initialized on /ws');

  wss.on('connection', (ws, req) => {
    // Informações do cliente
    const clientIp = req.socket.remoteAddress;
    console.log(`WebSocket client connected: ${clientIp}`);

    // Adicionar à lista de clientes
    clients.add(ws);

    // Enviar estado atual do bot para o novo cliente
    ws.send(JSON.stringify({
      event: 'connected',
      message: 'Connected to Kisekai Bot WebSocket'
    }));

    // Handler para mensagens do cliente
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleClientMessage(ws, message);
      } catch (err) {
        console.error('Invalid WebSocket message:', err);
      }
    });

    // Handler para desconexão
    ws.on('close', () => {
      console.log(`WebSocket client disconnected: ${clientIp}`);
      clients.delete(ws);
    });

    // Handler para erros
    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      clients.delete(ws);
    });
  });

  // Escutar mudanças de estado do bot e transmitir para todos os clientes
  if (botStateEmitter) {
    botStateEmitter.on('stateChange', (stateData) => {
      broadcast({
        event: 'bot_state_change',
        data: stateData
      });
    });
  }

  return wss;
}

/**
 * Processa mensagens recebidas dos clientes
 * @param {WebSocket} ws 
 * @param {Object} message 
 */
function handleClientMessage(ws, message) {
  switch (message.type || message.event) {
    case 'ping':
      ws.send(JSON.stringify({ event: 'pong', timestamp: Date.now() }));
      break;

    case 'subscribe':
      // Cliente quer receber atualizações
      ws.subscribed = true;
      ws.send(JSON.stringify({ event: 'subscribed', message: 'Subscribed to bot updates' }));
      break;

    default:
      ws.send(JSON.stringify({ event: 'error', message: 'Unknown message type' }));
  }
}

/**
 * Envia mensagem para todos os clientes conectados
 * @param {Object} data - Dados a serem enviados
 */
function broadcast(data) {
  const payload = JSON.stringify(data);
  
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

/**
 * Envia mensagem para um cliente específico
 * @param {WebSocket} ws 
 * @param {Object} data 
 */
function sendToClient(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Notifica todos os clientes sobre um evento do bot
 * @param {string} event - Nome do evento
 * @param {Object} data - Dados do evento
 */
function notifyBotEvent(event, data) {
  broadcast({
    event,
    data: {
      ...data,
      timestamp: new Date().toISOString()
    }
  });
}

/**
 * Retorna número de clientes conectados
 * @returns {number}
 */
function getConnectedClientsCount() {
  return clients.size;
}

/**
 * Fecha o servidor WebSocket
 */
function closeWebSocket() {
  if (wss) {
    wss.close(() => {
      console.log('WebSocket server closed');
    });
  }
  clients.clear();
}

module.exports = {
  initWebSocket,
  broadcast,
  sendToClient,
  notifyBotEvent,
  getConnectedClientsCount,
  closeWebSocket,
  clients
};