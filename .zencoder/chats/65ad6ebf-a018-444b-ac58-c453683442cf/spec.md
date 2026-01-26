# Especificação Técnica: Puxar Mensagem via JSON no /transmissao

Este documento descreve a implementação da funcionalidade de importar uma mensagem do Discord via seu ID para o formulário de transmissão no dashboard.

## Contexto Técnico
- **Backend**: Node.js com Express e Discord.js.
- **Frontend**: React (Vite) com Tailwind CSS e Lucide React.
- **Comunicação**: API REST.

## Abordagem de Implementação

### Backend (index.js)
1.  **Novo Endpoint**: `GET /api/messages/:channelId/:messageId`
2.  **Lógica**:
    - Validar se o `channelId` e `messageId` são válidos.
    - Buscar o canal usando `client.channels.fetch()`.
    - Buscar a mensagem usando `channel.messages.fetch()`.
    - Converter o objeto `Message` do Discord.js para o formato `BroadcastPayload` compatível com o frontend.
    - **Conversão de Embeds**: Mapear os embeds da mensagem para a estrutura `EmbedData`, preservando campos como título, descrição, cor (convertida para hex ou número), autor, rodapé, imagens e campos.

### Frontend (Kisekai-DashBoard)
1.  **API Client (src/lib/api.ts)**:
    - Adicionar função `getMessage(channelId: string, messageId: string)` para chamar o novo endpoint.
2.  **Componente BroadcastForm (src/components/dashboard/BroadcastForm.tsx)**:
    - Adicionar estado para `importMessageId`.
    - Adicionar um campo de input para o ID da mensagem e um botão "Puxar Mensagem" ao lado do ID do Canal.
    - Implementar a função `handlePullMessage`:
        - Chamar `getMessage`.
        - Se bem-sucedido, atualizar os estados `content` e `embeds`.
        - Mostrar um toast de sucesso ou erro.

## Mudanças na Estrutura de Código
- `index.js`: Adição de rota e lógica de conversão.
- `Kisekai-DashBoard/src/lib/api.ts`: Adição de método de API.
- `Kisekai-DashBoard/src/components/dashboard/BroadcastForm.tsx`: Alterações na UI e lógica de estado.

## Verificação
- **Manual**: Testar no dashboard puxando IDs de mensagens existentes em diferentes canais.
- **Lint**: Executar `npm run lint` no dashboard (se disponível).
- **Testes**: Verificar se a mensagem puxada é exibida corretamente no preview do Discord no dashboard.
