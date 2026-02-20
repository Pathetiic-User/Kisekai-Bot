const { supabase, pool, getConfig } = require('../config');
const { createCustomEmbed } = require('./embeds');

// Upload para Supabase Storage
async function uploadToSupabase(fileBuffer, fileName, contentType) {
  try {
    const { data, error } = await supabase.storage
      .from('reports')
      .upload(fileName, fileBuffer, {
        contentType: contentType,
        upsert: true
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('reports')
      .getPublicUrl(fileName);

    return { publicUrl, storagePath: fileName };
  } catch (err) {
    console.error('Supabase upload error:', err);
    return null;
  }
}

// Obter mensagem com placeholders
function getMessage(key, placeholders = {}) {
  const config = getConfig();
  let msg = config.messages?.[key] || "Message not found.";
  for (const [k, v] of Object.entries(placeholders)) {
    msg = msg.replace(`{${k}}`, v);
  }
  return msg;
}

// Log para canal do Discord
async function logToChannel(guild, type, description) {
  const config = getConfig();
  if (!config.logChannel || !config.customEmbeds?.logs?.enabled) return;
  const channel = guild.channels.cache.get(config.logChannel);
  if (!channel) return;

  const embed = createCustomEmbed(config.customEmbeds.logs, {
    type,
    description,
    guild: guild.name
  });

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Error sending log:', err);
  }
}

// Adicionar log ao banco
async function addLog(userId, action, reason, moderator, type = 'Administrativa', duration = null) {
  try {
    await pool.query(
      'INSERT INTO logs (user_id, action, reason, moderator, type, duration) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, action, reason, moderator, type, duration]
    );
  } catch (err) {
    console.error('Error in addLog:', err);
    throw err;
  }
}

// Obter opções de cookie
function getCookieOptions(req, maxAge = 7 * 24 * 60 * 60 * 1000) {
  const requestHost = (req.get('host') || '').toLowerCase();
  const isLocalBackend = requestHost.includes('localhost') || requestHost.includes('127.0.0.1');

  if (!isLocalBackend) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge
    };
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const frontendUrl = process.env.FRONTEND_URL || process.env.DASHBOARD_URL;
  let isCrossSite = false;

  try {
    if (origin && requestHost) {
      const originHost = new URL(origin).host;
      isCrossSite = originHost !== requestHost;
    } else if (referer && requestHost) {
      const refererHost = new URL(referer).host;
      isCrossSite = refererHost !== requestHost;
    } else if (frontendUrl && requestHost) {
      const frontendHost = new URL(frontendUrl).host;
      isCrossSite = frontendHost !== requestHost;
    }
  } catch (e) {
    isCrossSite = false;
  }

  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';

  return {
    httpOnly: true,
    secure: isCrossSite ? true : (process.env.NODE_ENV === 'production' || isHttps),
    sameSite: isCrossSite ? 'none' : 'lax',
    maxAge
  };
}

function getClearCookieOptions(req) {
  const options = getCookieOptions(req, 0);
  return {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
  };
}

// Extrair token da requisição
function getSessionTokenFromRequest(req) {
  const cookieToken = req.cookies?.token;
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
  const headerToken = req.headers['x-session-token'];

  return cookieToken || bearerToken || headerToken || null;
}

module.exports = {
  uploadToSupabase,
  getMessage,
  logToChannel,
  addLog,
  getCookieOptions,
  getClearCookieOptions,
  getSessionTokenFromRequest
};