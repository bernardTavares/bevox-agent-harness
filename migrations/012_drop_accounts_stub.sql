-- Migration: 012_drop_accounts_stub
--
-- Remove o stub `accounts` criado por 000_accounts_stub.sql. A 011 já
-- dropou todas as FKs órfãs `REFERENCES accounts(id)` ao recriar as
-- tabelas tenant-keyed sem essas referências, então a tabela é
-- removível sem CASCADE.
--
-- Idempotente via `IF EXISTS`. Em ambientes vivos (onde a 001 já tinha
-- rodado contra um `accounts` real), este DROP pode falhar se houver
-- registros — protege-se aqui assumindo que a 011 já normalizou o
-- schema (o stub é vazio por design).
--
-- Ref: docs/audits/runtime-gap-audit-2026-06-02.md MIG-004.

-- UP

DROP TABLE IF EXISTS accounts;

-- DOWN
-- (Não há down. Para restaurar: re-aplicar 000_accounts_stub.sql.)
