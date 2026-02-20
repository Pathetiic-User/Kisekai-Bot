const { USER_PROFILE_CACHE_TTL, STATS_CACHE_TTL } = require('../config/constants');

// Cache para perfis de usuários
const userProfileCache = new Map();

// Cache para lista de usuários
let usersCache = {
  data: null,
  lastFetched: 0
};

// Cache para estatísticas
let statsCache = {
  data: null,
  lastFetched: 0
};

// Cache para configuração
let configCache = null;

// Funções de cache para perfis de usuários
async function getCachedDiscordUserSummary(userId, discordClient) {
  const cached = userProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const user = await discordClient.users.fetch(userId).catch(() => null);
  const value = {
    username: user ? user.username : 'Desconhecido',
    avatarURL: user ? user.displayAvatarURL() : null,
  };

  userProfileCache.set(userId, {
    value,
    expiresAt: Date.now() + USER_PROFILE_CACHE_TTL,
  });

  return value;
}

// Funções de cache para usuários
function getUsersCache() {
  return usersCache;
}

function setUsersCache(data) {
  usersCache = {
    data,
    lastFetched: Date.now()
  };
}

function addUserToCache(userData) {
  if (!usersCache.data) {
    usersCache.data = [];
  }
  
  // Check if user already exists in cache
  const existingIndex = usersCache.data.findIndex(u => u.id === userData.id);
  
  if (existingIndex !== -1) {
    // Update existing user
    usersCache.data[existingIndex] = userData;
  } else {
    // Add new user
    usersCache.data.push(userData);
  }
}

function removeUserFromCache(userId) {
  if (!usersCache.data) return;
  
  usersCache.data = usersCache.data.filter(u => u.id !== userId);
}

function isUsersCacheValid(duration = 5 * 60 * 1000) {
  return usersCache.data && (Date.now() - usersCache.lastFetched < duration);
}

// Funções de cache para estatísticas
function getStatsCache() {
  return statsCache;
}

function setStatsCache(data) {
  statsCache = {
    data,
    lastFetched: Date.now()
  };
}

function isStatsCacheValid() {
  return statsCache.data && (Date.now() - statsCache.lastFetched < STATS_CACHE_TTL);
}

// Funções de cache para config
function getConfigCache() {
  return configCache;
}

function setConfigCache(data) {
  configCache = data;
}

module.exports = {
  userProfileCache,
  getCachedDiscordUserSummary,
  getUsersCache,
  setUsersCache,
  addUserToCache,
  removeUserFromCache,
  isUsersCacheValid,
  getStatsCache,
  setStatsCache,
  isStatsCacheValid,
  getConfigCache,
  setConfigCache
};
