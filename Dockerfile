# Build stage - não precisa, é projeto Node.js puro
FROM node:20-alpine

# Definir diretório de trabalho
WORKDIR /app

# Copiar apenas package.json primeiro para aproveitar cache do Docker
COPY package*.json ./

# Instalar dependências com cache do npm
RUN npm ci --only=production --no-audit --no-fund

# Copiar o resto dos arquivos
COPY . .

# Variáveis de ambiente
ENV NODE_ENV=production

# Expor porta
EXPOSE 3001

# Healthcheck para o Railway
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/stats || exit 1

# Comando de inicialização
CMD ["node", "index.js"]