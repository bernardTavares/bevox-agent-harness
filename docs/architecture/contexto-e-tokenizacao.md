# Contexto e Tokenização

O `ContextBuilder` é responsável por montar o **system prompt** enviado ao modelo de linguagem a cada execução. Ele combina cinco camadas independentes de informação, estima o custo em tokens de cada uma e, se necessário, comprime o conteúdo para que o resultado final caiba dentro do orçamento configurado.

Veja também: [fluxo de execução](./fluxo-de-execucao.md) e [memória e classificação](./memoria-e-classificacao.md).

---

## As 5 camadas

| Prioridade | Nome | Compressível? | Fonte de dados |
|-----------|------|:------------:|---------------|
| 10 | `base-config` | Não | `agentConfig.systemPrompt` (payload da execução) |
| 20 | `rules` | Não | Tabela `rules` no PostgreSQL (por `account_id`) |
| 30 | `calendar` | Sim | Cliente externo `CalendarClient` (serviço de agenda) |
| 40 | `memory` | Sim | Tabelas `contact_profiles` e `contact_facts` no PostgreSQL |
| 50 | `history` | Sim | Tabela `messages` no PostgreSQL (janela de tempo configurável) |

Camadas com número de prioridade menor aparecem primeiro no prompt e são as últimas a sofrer compressão. Camadas marcadas como **não compressíveis** são sempre preservadas integralmente.

---

## Detalhamento das camadas

### BaseConfig — prioridade 10

**Arquivo:** `src/context/layers/base-config.layer.ts`

Injeta diretamente o campo `agentConfig.systemPrompt` recebido no payload de execução. Não realiza nenhuma consulta a banco de dados ou serviço externo.

- Seção gerada: `## Configuracao base`
- `compressible = false` — nunca truncada
- Se `systemPrompt` estiver ausente, o bloco é produzido com conteúdo vazio sem erro

---

### Rules — prioridade 20

**Arquivo:** `src/context/layers/rules.layer.ts`

Busca as regras de encaminhamento ativas para a conta no PostgreSQL:

```sql
SELECT id, description
FROM rules
WHERE account_id = $1
  AND active = true
  AND destination = 'human'
ORDER BY id ASC
```

Cada regra é formatada como item numerado (`1. descrição`, `2. descrição`, ...).

- Seção gerada: `## Regras de encaminhamento`
- `compressible = false` — regras de negócio devem estar sempre presentes na íntegra
- Se não houver regras ativas, o bloco é incluído com conteúdo vazio e custo zero

---

### Calendar — prioridade 30

**Arquivo:** `src/context/layers/calendar.layer.ts`

Consulta um cliente externo (`CalendarClient`) para obter o contexto de agenda da conta. O bloco é organizado em três sub-seções:

- `### Servicos disponíveis` — nome, duração em minutos e descrição opcional de cada serviço ativo
- `### Profissionais` — nome e cargo de cada membro ativo
- `### Disponibilidade hoje` — slots de horário disponíveis por profissional (ex.: `09:00, 09:30`)

- Seção gerada: `## Agenda`
- `compressible = true` — pode ser truncada em caso de pressão de tokens
- **Tolerância a falhas:** se o `CalendarClient` lançar exceção, a camada retorna bloco vazio sem propagar o erro, garantindo que a construção do contexto continue normalmente

---

### Memory — prioridade 40

**Arquivo:** `src/context/layers/memory.layer.ts`

Hidrata o contexto com o perfil persistido do contato e os fatos extraídos de conversas anteriores. Executa duas queries em paralelo via `Promise.all`:

1. **`contact_profiles`** — nome completo, nome preferido, telefone, e-mail, cidade/estado, data da última interação
2. **`contact_facts`** — fatos classificados por chave/valor, com categoria e nível de confiança; apenas fatos não supersedidos (`superseded_by IS NULL`), ordenados por `confidence DESC, extracted_at DESC`

- Seção gerada: `## Informacoes do contato`
- Sub-seção de fatos: `### Fatos conhecidos`
- `compressible = true`
- Se não houver registro em `contact_profiles`, retorna bloco vazio

Para detalhes sobre como os fatos são extraídos e classificados, consulte [memória e classificação](./memoria-e-classificacao.md).

---

### History — prioridade 50

**Arquivo:** `src/context/layers/history.layer.ts`

Injeta o histórico recente da conversa atual. A janela temporal é controlada por duas variáveis de ambiente:

| Variável de ambiente | Padrão | Descrição |
|---------------------|--------|-----------|
| `HISTORY_WINDOW_DAYS` | `5` | Dias de histórico a buscar a partir de hoje |
| `HISTORY_RECENCY_LIMIT_DAYS` | `15` | Limite máximo de retroatividade (look-back) |

Apenas mensagens que satisfazem **ambas** as janelas são incluídas. Os papéis são traduzidos a partir de `message_type` e `content_type`:

| `message_type` | `content_type` | Rótulo no prompt |
|---------------|---------------|-----------------|
| `0` | qualquer | `Cliente` |
| `1` | `ai` | `Atendimento Inteligente` |
| outro | outro | `Atendimento Humano` |

- Seção gerada: `## Historico da conversa`
- `compressible = true` — por ter a maior prioridade numérica (50), é o **primeiro bloco a ser comprimido**
- Mensagens com conteúdo nulo ou em branco são excluídas pela query
- Se não houver mensagens no período, retorna bloco vazio

---

## Processo de build — diagrama

```
ContextInput
  ├── executionId
  ├── accountId
  ├── contactId
  ├── conversationKey
  ├── agentConfig.systemPrompt
  ├── agentConfig.maxContextTokens (opcional)
  └── dispatchPayload

          │
          ▼
  ContextBuilder.build()
          │
          ├── [Promise.all — fetch paralelo das 5 camadas] ──────────────┐
          │                                                               │
          │  BaseConfigLayer.build()  →  ContextBlock (priority=10)      │
          │  RulesLayer.build()       →  ContextBlock (priority=20)      │
          │  CalendarLayer.build()    →  ContextBlock (priority=30)      │
          │  MemoryLayer.build()      →  ContextBlock (priority=40)      │
          │  HistoryLayer.build()     →  ContextBlock (priority=50)      │
          │                                                               │
          └───────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                     Soma totalTokens de todos os blocos
                                   │
                      ┌────────────┴────────────┐
                      │                         │
                totalTokens               totalTokens
                  <= limit                 > limit
                      │                         │
                      ▼                         ▼
             assemble(blocks,          compress(blocks, limit)
               compressed=false)               │
                      │                         ▼
                      │              assemble(compressed,
                      │                compressed=true)
                      └─────────────┬────────────┘
                                    │
                                    ▼
                             BuiltContext
                               ├── systemPrompt (string)
                               ├── totalTokens  (number)
                               ├── layersUsed   (string[])
                               └── compressed   (boolean)
```

---

## Heurística de estimativa de tokens

**Arquivo:** `src/context/tokenizer.ts`

O estimador usa uma heurística leve baseada em contagem de palavras, sem dependências WASM:

```
tokens = ceil(palavras × 1,3)
```

O multiplicador `1,3` é uma aproximação conservadora do vocabulário `cl100k_base` (GPT-4o): a maioria das palavras em inglês e português tokeniza como 1–2 tokens, com média próxima de 1,3 token/palavra. A função retorna `0` para strings vazias ou nulas.

Cada camada chama `estimateTokens(section + '\n' + content)` no momento em que o bloco é construído, incluindo o cabeçalho Markdown na estimativa.

A heurística é propositalmente conservadora — pode superestimar levemente o uso real — o que garante uma margem de segurança sem exigir uma biblioteca de tokenização completa em runtime.

---

## Lógica de compressão

Quando `totalTokens > limit`, o método `compress()` reduz o conteúdo iterativamente, do bloco de **menor prioridade** (history, priority=50) para o de **maior** (calendar, priority=30), pulando blocos com `compressible = false`.

**Algoritmo passo a passo:**

1. Faz uma cópia rasa de todos os blocos para não mutar o estado original.
2. Itera do índice final para o inicial (ordem de prioridade decrescente).
3. Em cada iteração, verifica se o total atual já está dentro do limite — se sim, encerra.
4. Se o bloco atual for `compressible = false`, pula para o próximo.
5. Calcula:
   - `nonCompressibleTokens` = soma dos tokens de blocos não compressíveis
   - `compressibleBudget = limit - nonCompressibleTokens`
   - `compressibleTotal` = soma dos tokens de blocos compressíveis
6. Se `compressibleTotal <= compressibleBudget`, o orçamento já é suficiente — encerra.
7. Aplica redução proporcional no bloco atual:
   ```
   ratio     = compressibleBudget / compressibleTotal
   keepLines = max(3, floor(totalLinhas × ratio))
   ```
8. Trunca o conteúdo nas primeiras `keepLines` linhas e recalcula `tokenEstimate`.

**Garantias:**
- Camadas `base-config` e `rules` são sempre preservadas na íntegra.
- Mínimo de 3 linhas mantidas por bloco compressível (piso de `keepLines`).
- A redução é proporcional ao peso relativo de cada bloco compressível no total.

**Limite efetivo:**
```
limit = agentConfig.maxContextTokens ?? globalMaxTokens (padrão: 8.000 tokens)
```

---

## Arquivos de teste

O módulo `src/context/` possui 8 arquivos de teste, cobrindo unitariamente cada camada e o builder como um todo:

| Arquivo | O que cobre |
|--------|-------------|
| `src/context/tokenizer.test.ts` | Estimativas para strings variadas, casos de borda (vazio, só espaços) |
| `src/context/layers/base-config.layer.test.ts` | Bloco com e sem `systemPrompt`, custo de tokens |
| `src/context/layers/rules.layer.test.ts` | Query mockada, formatação numerada, caso sem regras ativas |
| `src/context/layers/calendar.layer.test.ts` | Serviços/membros/slots mockados, tolerância a falha do serviço externo |
| `src/context/layers/memory.layer.test.ts` | Perfil completo, parcial e ausente; fatos com e sem categoria |
| `src/context/layers/history.layer.test.ts` | Mapeamento de papéis, filtro por janela de tempo, conversa vazia |
| `src/context/context-builder.test.ts` | Build sem compressão, build com compressão, ordenação por prioridade |
| `src/context/context-builder.integration.test.ts` | Cenário end-to-end com todas as camadas integradas |

---

## Referências de código

- `src/context/types.ts` — interfaces `ContextInput`, `ContextBlock`, `ContextLayer`, `BuiltContext`
- `src/context/context-builder.ts` — classe `ContextBuilder` (métodos `build`, `compress`, `assemble`)
- `src/context/tokenizer.ts` — função `estimateTokens`
- `src/context/layers/index.ts` — re-exporta as cinco camadas
