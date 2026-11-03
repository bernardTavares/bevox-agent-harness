// src/integration/execution-payload.schema.ts
//
// Execution-mode enum module.
//
// Single responsibility: the canonical AI autonomy-mode enum
// (`ExecutionModeSchema` / `ExecutionMode`) per 30_adr/bevox-harness/ADR-006.
//
// The LIVE receive contract (tenant = organization_id UUID) lives in the
// handler-local `executionPayloadSchema` in src/runtime/execution-handler.ts.
// Tenant identity is governed by 30_adr/bevox-harness/ADR-019 (landed canon:
// organization_id UUID is the sole tenant identifier; the legacy INT-tenant
// and transitional-tenant identifiers are retired) and _shared/ADR-021. The
// legacy payload-schema export and its tenant-resolution helper that previously
// lived here have been removed (SP-3 harness tenancy convergence).

import { z } from "zod";

/**
 * Modos de autonomia da IA (ADR-006).
 *
 * - `manual_assisted` — IA sugere; humano aprova. Tools de mutação retornam proposal.
 * - `copilot` — IA estrutura conhecimento (FAQ, regras); tools de mutação retornam proposal.
 * - `autonomous_supervised` — IA executa dentro de regras aprovadas; escala exceções.
 */
export const ExecutionModeSchema = z.enum(["manual_assisted", "copilot", "autonomous_supervised"]);

export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
