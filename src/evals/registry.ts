/**
 * Module-singleton accessors for the eval subsystem. Mirrors the pattern used
 * by `harnessConfig` / `permissionAuditLogger` so the execution-handler can
 * pick up the EvalQueue without taking it as a constructor argument.
 */
import type { Worker } from "bullmq";

import type { EvalJobPayload, EvalQueue } from "./eval-queue.js";
import type { SamplingPolicy } from "./sampler.js";

let _queue: EvalQueue | null = null;
let _worker: Worker<EvalJobPayload> | null = null;
let _policy: SamplingPolicy | null = null;
let _enabledScorers: string[] = [];

export function setEvalQueue(queue: EvalQueue | null): void {
  _queue = queue;
}
export function getEvalQueue(): EvalQueue | null {
  return _queue;
}

export function setEvalWorker(worker: Worker<EvalJobPayload> | null): void {
  _worker = worker;
}
export function getEvalWorker(): Worker<EvalJobPayload> | null {
  return _worker;
}

export function setSamplingPolicy(policy: SamplingPolicy): void {
  _policy = policy;
}
export function getSamplingPolicy(): SamplingPolicy | null {
  return _policy;
}

export function setEnabledScorers(names: string[]): void {
  _enabledScorers = names;
}
export function getEnabledScorers(): string[] {
  return _enabledScorers;
}

/** Test helper — resets all singletons. */
export function resetEvalRegistryForTests(): void {
  _queue = null;
  _worker = null;
  _policy = null;
  _enabledScorers = [];
}
