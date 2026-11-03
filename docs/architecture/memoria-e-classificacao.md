# Memória e Classificação

Este documento descreve o subsistema de memória persistente por contato e o mecanismo de classificação de mensagens do bevox-agent-harness.

Ver também: [agentes](./agentes-e-registro.md), [contexto](./contexto-e-tokenizacao.md)

---

## Visão Geral

O sistema mantém uma memória persistente por contato que é:

- **Populada** por agentes de pipeline (`MemoryExtractorAgent`, `MessageAnalyzerAgent`) durante o processamento de cada mensagem recebida.
- **Consumida** pelo context builder via `MemoryLayer`, que monta o bloco de contexto injetado no prompt do agente conversacional.

A memória é organizada em três tabelas PostgreSQL: `contact_profiles` (dados estruturados fixos), `contact_facts` (fatos dinâmicos com histórico versionado) e `message_classifications` (classificações por mensagem).

---

## Schema das Tabelas

### `contact_profiles`

Armazena um registro único por par `(account_id, contact_id)`. Agrega os dados pessoais e de preferências conhecidos do contato.

| Coluna                    | Tipo           | Descrição                                      |
|---------------------------|----------------|------------------------------------------------|
| `id`                      | `SERIAL PK`    | Identificador interno                          |
| `account_id`              | `INTEGER`      | FK para `accounts(id)`                         |
| `contact_id`              | `BIGINT`       | Identificador externo do contato               |
| `full_name`               | `TEXT`         | Nome completo                                  |
| `preferred_name`          | `TEXT`         | Nome pelo qual prefere ser chamado             |
| `birth_date`              | `DATE`         | Data de nascimento                             |
| `gender`                  | `TEXT`         | Gênero                                         |
| `document_number`         | `TEXT`         | CPF/RG ou outro documento                      |
| `phone`                   | `TEXT`         | Telefone                                       |
| `email`                   | `TEXT`         | E-mail                                         |
| `address`                 | `TEXT`         | Endereço                                       |
| `city`                    | `TEXT`         | Cidade                                         |
| `state`                   | `TEXT`         | Estado                                         |
| `preferred_language`      | `TEXT`         | Idioma preferido (padrão: `pt-BR`)             |
| `preferred_contact_channel` | `TEXT`       | Canal preferido (ex.: `whatsapp`, `email`)     |
| `preferred_time_from`     | `TIME`         | Início da janela de contato preferida          |
| `preferred_time_to`       | `TIME`         | Fim da janela de contato preferida             |
| `first_seen_at`           | `TIMESTAMPTZ`  | Primeira vez que o contato foi visto           |
| `last_interaction_at`     | `TIMESTAMPTZ`  | Última interação registrada                    |
| `total_interactions`      | `INTEGER`      | Contador acumulado de interações               |
| `created_at`              | `TIMESTAMPTZ`  | Criação do registro                            |
| `updated_at`              | `TIMESTAMPTZ`  | Última atualização                             |

Restrição: `UNIQUE(account_id, contact_id)`.

Índices: `idx_contact_profiles_account` e `idx_contact_profiles_contact`.

---

### `contact_facts`

Armazena fatos dinâmicos sobre o contato, com suporte a versionamento via supersession. Cada linha representa uma extração pontual de um dado observado em uma mensagem.

| Coluna                    | Tipo              | Descrição                                                      |
|---------------------------|-------------------|----------------------------------------------------------------|
| `id`                      | `BIGINT IDENTITY PK` | Identificador do fato                                       |
| `account_id`              | `INTEGER`         | FK para `accounts(id)`                                         |
| `contact_id`              | `BIGINT`          | Identificador externo do contato                               |
| `fact_key`                | `TEXT`            | Chave do fato em snake_case (ex.: `nome_do_pet`)               |
| `fact_value`              | `TEXT`            | Valor do fato como string                                      |
| `category`                | `TEXT`            | Categoria de agrupamento (ex.: `family`, `health`, `work`)     |
| `confidence`              | `NUMERIC(4,3)`    | Confiança da extração, entre 0 e 1 (restrição `CHECK`)         |
| `source_conversation_key` | `TEXT`            | Chave da conversa de onde o fato foi extraído                  |
| `source_execution_id`     | `UUID`            | ID da execução que produziu o fato                             |
| `extracted_at`            | `TIMESTAMPTZ`     | Momento da extração                                            |
| `confirmed`               | `BOOLEAN`         | `true` se `confidence >= 0.8` no momento da inserção           |
| `superseded_by`           | `BIGINT`          | FK para `contact_facts(id)` — aponta para o fato mais recente  |
| `created_at`              | `TIMESTAMPTZ`     | Criação do registro                                            |
| `updated_at`              | `TIMESTAMPTZ`     | Última atualização                                             |

Índices:
- `idx_contact_facts_lookup` — em `(account_id, contact_id, fact_key)`.
- `idx_contact_facts_category` — em `(account_id, contact_id, category)`.
- `idx_contact_facts_active` — parcial em `(account_id, contact_id) WHERE superseded_by IS NULL`, otimizando a busca de fatos ativos.

---

### `message_classifications`

Armazena a classificação de cada mensagem processada. Uma linha por execução com mensagem de entrada.

| Coluna                  | Tipo              | Descrição                                                                                              |
|-------------------------|-------------------|--------------------------------------------------------------------------------------------------------|
| `id`                    | `BIGINT IDENTITY PK` | Identificador da classificação                                                                      |
| `account_id`            | `INTEGER`         | FK para `accounts(id)`                                                                                 |
| `conversation_key`      | `TEXT`            | Chave da conversa classificada                                                                         |
| `message_id`            | `BIGINT`          | ID da mensagem (opcional)                                                                              |
| `execution_id`          | `UUID`            | ID da execução que realizou a classificação                                                            |
| `sentiment`             | `TEXT`            | Um de: `positive`, `neutral`, `negative`, `frustrated`, `angry`, `confused` (restrição `CHECK`)       |
| `sentiment_confidence`  | `NUMERIC(4,3)`    | Confiança do sentimento, entre 0 e 1                                                                   |
| `intent`                | `TEXT`            | Intenção detectada em snake_case (ex.: `scheduling`, `complaint`)                                      |
| `intent_confidence`     | `NUMERIC(4,3)`    | Confiança da intenção, entre 0 e 1                                                                     |
| `topics`                | `TEXT[]`          | Array de tópicos relevantes (ex.: `["appointment", "doctor"]`)                                         |
| `urgency`               | `TEXT`            | Um de: `low`, `medium`, `high`, `critical` (restrição `CHECK`)                                        |
| `model_used`            | `TEXT`            | Identificador do modelo LLM utilizado                                                                  |
| `processing_ms`         | `INTEGER`         | Tempo de processamento em milissegundos                                                                |
| `created_at`            | `TIMESTAMPTZ`     | Momento da classificação                                                                               |

Índices: por `(account_id, conversation_key)`, `sentiment`, `intent` e `created_at DESC`.

---

## Repositories

### `ContactProfileRepository`

Localização: `src/memory/contact-profile.repository.ts`

Encapsula o acesso à tabela `contact_profiles` via `pg.Pool`.

| Método | Assinatura | Comportamento |
|---|---|---|
| `findByContact` | `(accountId, contactId) → ContactProfile \| null` | `SELECT *` pelo par de chaves; retorna `null` se não encontrado. |
| `findOrCreate` | `(accountId, contactId) → ContactProfile` | `INSERT ... ON CONFLICT DO UPDATE`: cria o perfil na primeira vez ou atualiza `last_interaction_at` e incrementa `total_interactions`. Retorna o registro final. |
| `update` | `(accountId, contactId, fields, client?) → void` | Constrói `SET` dinâmico a partir dos campos não-`undefined` de `ContactProfileFields`. Aceita um `PoolClient` para execução dentro de transação. Sempre inclui `updated_at = now()`. |

O método `update` realiza o mapeamento camelCase → snake_case internamente (`fullName → full_name`, etc.).

---

### `ContactFactsRepository`

Localização: `src/memory/contact-facts.repository.ts`

Encapsula o acesso à tabela `contact_facts`.

| Método | Assinatura | Comportamento |
|---|---|---|
| `listActive` | `(accountId, contactId) → ContactFact[]` | Retorna todos os fatos com `superseded_by IS NULL`, ordenados por `extracted_at DESC`. |
| `insert` | `(fact, client?) → ContactFact` | Insere um novo fato. Define `confirmed = true` automaticamente se `confidence >= 0.8`. |
| `supersede` | `(oldFactId, newFactId, client?) → void` | Atualiza `superseded_by = newFactId` no fato antigo. |
| `upsertFact` | `(fact, client) → ContactFact` | Operação atômica: busca o fato ativo pela `fact_key`, insere o novo e, se existia um anterior, chama `supersede`. Requer `PoolClient` (deve ser usado dentro de transação). |

---

## Fluxo de Escrita — `MemoryExtractorAgent`

Localização: `src/agents/pipeline/memory-extractor.agent.ts`

O `MemoryExtractorAgent` é um agente de pipeline (tipo `pipeline`, permissões restritas: proibido enviar mensagens ou criar agendamentos) que é executado uma vez por mensagem recebida.

### Etapas

1. **Guarda de entrada**: se não houver `contactId` ou texto de entrada (`direction === 'incoming'`), retorna imediatamente com `skipped: true`.

2. **Carregamento do estado atual**: em paralelo, carrega o perfil via `findOrCreate` (garantindo que o registro exista e incrementando `total_interactions`) e os fatos ativos via `listActive`.

3. **Chamada ao LLM**: envia o texto da mensagem junto com um resumo do perfil atual e dos 20 fatos mais recentes. O modelo retorna um JSON com campo `extracted` (array de itens) e `nothingFound` (booleano). Cada item tem `type` (`fixed` | `dynamic`), `key`, `value`, `category` (apenas dinâmicos) e `confidence`.

4. **Filtragem por confiança**:
   - `confidence < 0.5`: item descartado.
   - `0.5 ≤ confidence < 0.8`: inserido com `confirmed = false`.
   - `confidence ≥ 0.8`: inserido com `confirmed = true`.

5. **Escrita transacional com advisory lock**:
   - Abre transação PostgreSQL.
   - Executa `SELECT pg_advisory_xact_lock($1)` com `contact_id` como chave, prevenindo escritas concorrentes para o mesmo contato.
   - **Itens `fixed`**: chama `profileRepo.update` com os campos mapeados para camelCase.
   - **Itens `dynamic`**: chama `factsRepo.upsertFact` para cada um, supersedendo o fato anterior da mesma `fact_key`.
   - Em caso de erro, executa `ROLLBACK`.

6. **Resultado**: retorna contagem de itens escritos (`fixed`, `dynamic`, `discarded`), modelo usado e tempo de processamento.

---

## Fluxo de Leitura — `MemoryLayer`

Localização: `src/context/layers/memory.layer.ts`

A `MemoryLayer` implementa a interface `ContextLayer` e é registrada com `priority = 40` e `compressible = true` no context builder.

### Comportamento

O método `build(input)` executa duas queries em paralelo:

1. **Perfil**: seleciona as colunas relevantes para o prompt (`full_name`, `preferred_name`, `phone`, `email`, `address`, `city`, `state`, `preferred_language`, `last_interaction_at`, `total_interactions`) do `contact_profiles`.

2. **Fatos**: seleciona todos os fatos ativos (`superseded_by IS NULL`) do `contact_facts`, ordenados por `confidence DESC, extracted_at DESC`.

Se o perfil não existir, retorna um bloco vazio com `tokenEstimate: 0`.

### Montagem do bloco de texto

O bloco gerado tem o cabeçalho `## Informacoes do contato` e inclui:
- Nome (com nome preferido entre parênteses, se disponível).
- Telefone, e-mail e localização (`city, state`).
- Data da última interação.
- Seção `### Fatos conhecidos` com os fatos listados no formato `- [categoria] fact_key: fact_value`.

O bloco é retornado com estimativa de tokens calculada via `estimateTokens`. Por ser `compressible = true`, o context builder pode removê-lo quando o orçamento de tokens for excedido.

---

## Classificação de Mensagens — `MessageAnalyzerAgent`

Localização: `src/agents/pipeline/message-analyzer.agent.ts`

O `MessageAnalyzerAgent` é um agente de pipeline com permissões totalmente negadas (`denied: ['*']`), ou seja, apenas lê e persiste dados — não interage com o usuário.

### Etapas

1. **Extração do texto**: concatena apenas as mensagens com `direction === 'incoming'`.

2. **Chamada ao LLM**: envia o texto e recebe um JSON estruturado com os campos:
   - `sentiment`: categoria de sentimento (`positive`, `neutral`, `negative`, `frustrated`, `angry`, `confused`).
   - `sentimentConfidence`: confiança de 0 a 1.
   - `intent`: intenção principal em snake_case (ex.: `scheduling_cancellation`, `complaint`).
   - `intentConfidence`: confiança de 0 a 1.
   - `topics`: array de strings com tópicos relevantes.
   - `urgency`: nível de urgência (`low`, `medium`, `high`, `critical`).

3. **Persistência**: insere um registro em `message_classifications` com todos os campos acima mais `account_id`, `conversation_key`, `message_id`, `execution_id`, `model_used` e `processing_ms`. A falha na persistência é **não-fatal**: o erro é logado mas não interrompe o pipeline.

4. **Resultado**: retorna o objeto `ClassificationOutput` no campo `output` do `AgentResult`, disponibilizando a classificação para agentes subsequentes do mesmo pipeline.

---

## Supersession de Fatos

O mecanismo de supersession garante que fatos dinâmicos reflitam sempre a informação mais recente sem perder o histórico.

**Como funciona:**

- Cada fato tem um campo `superseded_by BIGINT REFERENCES contact_facts(id)`, que por padrão é `NULL` (fato ativo).
- Quando o `MemoryExtractorAgent` extrai um novo valor para uma `fact_key` já existente, o método `upsertFact` executa:
  1. Busca o fato ativo atual para aquela chave (`superseded_by IS NULL`).
  2. Insere o novo fato.
  3. Atualiza o fato antigo: `superseded_by = <id do novo fato>`.
- Apenas fatos com `superseded_by IS NULL` são considerados ativos e retornados por `listActive` e pela `MemoryLayer`.
- O índice parcial `idx_contact_facts_active` otimiza exatamente estas queries.

**Rastreabilidade:** a cadeia de fatos supersedidos permanece no banco, permitindo auditar a evolução de um dado ao longo do tempo via `source_conversation_key` e `source_execution_id`.

---

## Diagrama de Fluxo

```
Mensagem recebida
       │
       ├──► MessageAnalyzerAgent
       │         │  LLM classifica sentiment/intent/topics/urgency
       │         └──► INSERT message_classifications
       │
       └──► MemoryExtractorAgent
                 │  findOrCreate profile (incrementa total_interactions)
                 │  listActive facts
                 │  LLM extrai itens fixed/dynamic
                 │  pg_advisory_xact_lock(contact_id)
                 ├──► profileRepo.update (fixed fields)
                 └──► factsRepo.upsertFact → supersede (dynamic facts)

Próxima execução — context builder
       │
       └──► MemoryLayer.build
                 │  SELECT contact_profiles
                 │  SELECT contact_facts WHERE superseded_by IS NULL
                 └──► ContextBlock "## Informacoes do contato"
```

---

## Referências de Código

| Arquivo | Descrição |
|---|---|
| `migrations/001_memory_and_classifications.sql` | DDL completo das três tabelas e índices |
| `src/memory/types.ts` | Interfaces `ContactProfile`, `ContactFact`, `NewContactFact` |
| `src/memory/contact-profile.repository.ts` | `ContactProfileRepository` |
| `src/memory/contact-facts.repository.ts` | `ContactFactsRepository` |
| `src/agents/pipeline/memory-extractor.agent.ts` | `MemoryExtractorAgent` |
| `src/agents/pipeline/message-analyzer.agent.ts` | `MessageAnalyzerAgent` |
| `src/context/layers/memory.layer.ts` | `MemoryLayer` |
