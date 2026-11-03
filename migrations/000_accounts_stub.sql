-- Migration: 000_accounts_stub
--
-- Cria um stub mínimo da tabela `accounts` ANTES das migrations 001-010
-- que historicamente referenciavam `REFERENCES accounts(id)` mas onde
-- nenhuma migration do harness criava essa tabela (assumia-se que o
-- bevox-backend a criava primeiro; nunca aconteceu em deploys do zero).
--
-- A migration 011 (organization_id_tenancy) faz DROP+CREATE de todas as
-- tabelas tenant-keyed sem as FKs órfãs, então **depois da 011 este stub
-- vira tabela órfã sem dependências**. O drop fica em 012.
--
-- Idempotente: `IF NOT EXISTS` permite que rodar em ambientes vivos (onde
-- a 001 já foi aplicada) seja no-op. `schema_migrations.filename` registra
-- a execução; rodar `scripts/migrate.mjs` 2x não duplica.
--
-- Esta abordagem foi escolhida em vez de editar a 001 in-place porque a
-- 001 já foi aplicada em ambientes vivos (`schema_migrations`) e
-- `scripts/migrate.mjs` NÃO re-aplica migrations já registradas — editar
-- a 001 violaria imutabilidade sem efeito prático.
--
-- Ref: docs/audits/runtime-gap-audit-2026-06-02.md C11/MIG-001..004 +
-- $BEVOX_KNOWLEDGE_PATH/20_architecture/_shared/runtime-topology.md §6.4.

-- UP

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY
);

-- DOWN
-- (Não há down — stub mínimo só persiste até a 011 dropar os FKs e a 012 dropar o stub.)
