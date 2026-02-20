const { client, getBotState, setBotState } = require('./client');
const events = require('./events');

// Registrar todos os eventos
function registerEvents() {
  Object.entries(events).forEach(([name, handler]) => {
    client.on(name, handler(client));
  });
}

module.exports = {
  client,
  getBotState,
  setBotState,
  registerEvents
};