---
description: Visão Geral das Informações do Repositório
alwaysApply: true
---

# Informações do Kisekai Bot

## Resumo
O Kisekai Bot é um bot multifuncional para Discord integrado a um servidor API Express.js. Ele possui sistema anti-spam, cargos automáticos, logs e mecanismos de denúncia. O projeto utiliza Supabase e PostgreSQL para persistência de dados e inclui uma API protegida por JWT e chaves de API, servindo provavelmente a uma interface de dashboard.

## Estrutura
- **Raiz**: Contém o arquivo principal da aplicação, configurações e definições de dependências.
- `index.js`: Ponto de entrada central para o cliente do bot Discord e o servidor web Express.
- `config.json`: Contém configurações específicas do bot, como prefixos de comando, IDs de canais para logs/denúncias, configurações anti-spam e mensagens localizadas.
- `.zencoder/` / `.zenflow/`: Diretório para fluxos de trabalho automatizados e regras do projeto.

## Linguagem e Runtime
**Linguagem**: JavaScript  
**Versão**: Node.js (Recomendada versão estável mais recente)  
**Sistema de Build**: N/A (Execução direta)  
**Gerenciador de Pacotes**: npm

## Dependências
**Principais Dependências**:
- `discord.js`: Biblioteca da API do Discord para funcionalidades do bot.
- `express`: Framework web para o servidor API.
- `@supabase/supabase-js`: Cliente Supabase para banco de dados e armazenamento.
- `pg`: Cliente PostgreSQL.
- `axios`: Cliente HTTP para requisições externas.
- `helmet`: Middleware de segurança para Express.
- `jsonwebtoken`: Implementação de JWT para autenticação do dashboard.
- `multer`: Middleware para manipulação de upload de arquivos.
- `express-rate-limit`: Limitação de taxa (rate limiting) para a API.

## Build e Instalação
```bash
# Instalar dependências
npm install

# Iniciar a aplicação
npm start
```

## Arquivos Principais e Recursos
- **Ponto de Entrada**: `index.js` (inicia tanto o bot Discord quanto o servidor API).
- **Configuração**: `config.json` para comportamento do bot e `package.json` para metadados/dependências.
- **Ambiente**: `.env` (referenciado no código para `API_KEY`, `JWT_SECRET`, `SUPABASE_URL`, etc.).

## Uso e Operações
O bot escuta comandos usando um prefixo configurável (padrão `!`). O servidor Express fornece endpoints em `/api/`, incluindo autenticação via `/auth/` e recursos de denúncia.

## Testes
**Framework**: Nenhum configurado.  
**Comando de Execução**:
```bash
npm test
```
*(Atualmente retorna uma mensagem de erro, pois não há testes implementados.)*

## Regras de Automação
- **Commits Obrigatórios**: Ao final de cada prompt ou conclusão de tarefa, sempre gerar um comando `git commit` para subir as alterações para o GitHub.
