# Security Policy

## Trust Model

Bevox Agent Harness é um **serviço de domínio** dentro da plataforma Bevox. Não é um produto isolado; depende do orchestration-service para autenticar requisições.

### Fronteiras de confiança reais

1. **Boundary 1 — BullMQ payload:** confiamos que o orchestration-service enfileira jobs válidos. **Não confiamos no payload em si**: validamos com Zod estrito (tamanho, shape, valores).
2. **Boundary 2 — X-Execution-Token (outbound only):** o harness **emite** este header em callbacks ao Bevox; **não** recebe nem valida tokens HTTP (não há servidor HTTP exposto). Token é tratado como **opaque secret**: nunca logado (ver redactors), nunca persistido, redação aplicada em traces externos.
3. **Boundary 3 — Calendar Service:** confiamos no transporte (rede interna), mas validamos toda resposta com Zod antes de usar.
4. **Boundary 4 — LLM providers:** respostas tratadas como **untrusted user input** para fins de parsing.

### O que é controle de segurança

- Validação Zod em boundaries
- Prepared statements em SQL
- Redação de PII em logs
- Auditoria persistida de decisões de permissão

### O que NÃO é controle de segurança (apenas "accident prevention")

- Sistema de permissões de tools — protege contra **mau uso de agentes**, não contra atacantes
- Rate limiting — proteção contra runaway loops, não DoS sofisticado
- Approval gates (se houver) — depende de operador humano

## Vulnerabilidades em escopo

- Bypass de validação em boundary
- SQL injection / NoSQL injection
- Vazamento de PII (`full_name`, `phone`, `email`, `document_number`) em logs / traces / callbacks externos
- Vazamento de `X-Execution-Token` em logs / responses
- Vazamento de credenciais LLM
- Execução remota de código

## Fora de escopo

- Prompt injection no LLM (mitigação parcial via permissions, mas considerado risco assumido)
- Bypass de permissões via configuração interna
- DoS via flood de jobs BullMQ (responsabilidade do orchestration-service)

## Como reportar

Envie e-mail para **security@bevox.example** com:

- Descrição do problema
- Passos de reprodução
- Impacto estimado
- Sugestão de correção (opcional)

**NÃO** abra issue público para vulnerabilidades. Aguardamos até 90 dias para divulgação coordenada.

## Operational Notes

### Migration → deploy ordering

A tabela `permission_audit` (migration `002_permission_audit.sql`) deve ser aplicada **antes** do deploy do código novo. O auditor de permissões faz `INSERT` fire-and-forget — sem a tabela, todo deny gera warning de erro SQL no log. Sequência obrigatória:

1. `psql $DATABASE_URL -f migrations/002_permission_audit.sql` em todos os ambientes alvo
2. Verificar `SELECT 1 FROM permission_audit LIMIT 1` (não pode dar `relation does not exist`)
3. Deploy do binário com o código de auditoria

Rollback: remover deploy de código antes de rodar `DOWN` da migration.

### Rate limiter

Limites default (override via env) por `accountId:toolName`:

- `send-message`: 20/min
- `request-human`: 5/h
- `create-appointment` / `cancel-appointment` / `reschedule-appointment`: 10/min cada (mutações de calendar)

Implementado como sliding window em Redis (ZSET). Limites devem ser **generosos no primeiro deploy** — monitorar `deny rate` via logs antes de apertar.
