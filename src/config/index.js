const constants = require('./constants');
const database = require('./database');

// Config global state
let config = {};

// Load config from database
async function loadConfig() {
  const { pool } = database;
  const res = await pool.query('SELECT data FROM configs LIMIT 1');
  
  if (res.rows.length === 0) {
    config = {
      prefix: "/",
      autoRole: "1464397173167882334",
      messages: {},
      antiSpam: { enabled: false, interval: 2000, limit: 5, action: "mute", autoPunish: true },
      punishChats: [],
      reportChannel: "1463183940809392269",
      punishmentChannel: "1463186111458443450",
      sweepstakeChannel: "1464266529058193429",
      adminRole: "1464264578773811301",
      customEmbeds: {
        welcome: { enabled: false, channel: "1438658039656743024", title: "Bem-vindo!", description: "Bem-vindo ao servidor, {user}!", color: "#00ff00" },
        reportFeedback: { enabled: true, title: "Reporte Enviado", description: "Seu reporte contra {user} foi recebido com sucesso.", color: "#ffff00" },
        resolvedReport: { enabled: true, title: "✅ Reporte Bem-Sucedido", description: "Um reporte foi analisado e o usuário foi punido.", color: "#00ff00", fields: [{ name: "👤 Usuário Punido", value: "{reported_tag}", inline: true }, { name: "🚩 Motivo", value: "{reason}", inline: false }] }
      }
    };
    await pool.query('INSERT INTO configs (data) VALUES ($1)', [config]);
  } else {
    config = res.rows[0].data;
    // Ensure defaults
    let updated = false;
    if (!config.adminRole || config.adminRole === "") {
      config.adminRole = "1464264578773811301";
      updated = true;
    }
    if (!config.autoRole || config.autoRole === "") {
      config.autoRole = "1464397173167882334";
      updated = true;
    }
    if (updated) {
      await saveConfig();
    }
  }
  
  return config;
}

async function saveConfig() {
  const { pool } = database;
  await pool.query('UPDATE configs SET data = $1 WHERE id = (SELECT id FROM configs LIMIT 1)', [config]);
}

function getConfig() {
  return config;
}

function setConfig(newConfig) {
  config = { ...config, ...newConfig };
}

module.exports = {
  ...constants,
  ...database,
  loadConfig,
  saveConfig,
  getConfig,
  setConfig
};