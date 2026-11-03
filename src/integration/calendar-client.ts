import type { ZodTypeAny } from "zod";

import { getHarnessConfig } from "../config/harness-config.js";
import { createLogger } from "../config/logger.js";

import {
  availabilityResponseSchema,
  healthResponseSchema,
  listAppointmentsResponseSchema,
  mutationResponseSchema,
} from "./calendar-client.schemas.js";

const config = getHarnessConfig();
const logger = createLogger({ name: "calendar-client", level: config.harness.logLevel });

function validate<S extends ZodTypeAny>(
  schema: S,
  raw: unknown,
  path: string,
): import("zod").infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    logger.warn(
      { path, issues: result.error.issues.slice(0, 5) },
      "Calendar response failed validation",
    );
    throw new Error(`Calendar response validation failed for ${path}`);
  }
  return result.data;
}

const BASE_URL = config.calendar.baseUrl;

async function get<T>(path: string, token?: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Calendar service GET ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * C10 — quando `idempotencyKey` é fornecido, injeta header `Idempotency-Key`
 * (ADR-023 / PRD §13.3) para que retries BullMQ do mesmo step não dupliquem
 * side-effects no calendar service. `undefined` = sem header (comportamento
 * legado).
 */
async function post<T>(
  path: string,
  body: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Calendar service POST ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(
  path: string,
  body: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Calendar service PATCH ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function checkHealth(): Promise<void> {
  try {
    const raw = await get<unknown>("/health");
    const result = validate(healthResponseSchema, raw, "/health");
    logger.info({ url: BASE_URL, result }, "Calendar service health check passed");
  } catch (err) {
    throw new Error(`Calendar service unreachable at ${BASE_URL}: ${err}`);
  }
}

export async function getAvailability(
  calendarId: string,
  date: string,
  serviceId?: string,
): Promise<unknown> {
  const qs = serviceId
    ? `?date=${encodeURIComponent(date)}&serviceId=${encodeURIComponent(serviceId)}`
    : `?date=${encodeURIComponent(date)}`;
  const path = `/api/v1/calendars/${calendarId}/availability${qs}`;
  const raw = await get<unknown>(path);
  return validate(availabilityResponseSchema, raw, path);
}

export async function createAppointment(
  calendarId: string,
  body: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const path = `/api/v1/calendars/${calendarId}/appointments`;
  const raw = await post<unknown>(path, body, token, idempotencyKey);
  return validate(mutationResponseSchema, raw, path);
}

export async function cancelAppointment(
  appointmentId: string,
  reason: string,
  token?: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const path = `/api/v1/appointments/${appointmentId}/cancel`;
  const raw = await post<unknown>(path, { reason }, token, idempotencyKey);
  return validate(mutationResponseSchema, raw, path);
}

export async function listAppointments(
  calendarId: string,
  dateFrom?: string,
  dateTo?: string,
  token?: string,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const path = `/api/v1/calendars/${calendarId}/appointments${qs}`;
  const raw = await get<unknown>(path, token);
  return validate(listAppointmentsResponseSchema, raw, path);
}

export async function rescheduleAppointment(
  appointmentId: string,
  newDate: string,
  newStartTime: string,
  token?: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const path = `/api/v1/appointments/${appointmentId}`;
  const raw = await patch<unknown>(path, { newDate, newStartTime }, token, idempotencyKey);
  return validate(mutationResponseSchema, raw, path);
}

export async function addToWaitlist(
  calendarId: string,
  body: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const path = `/api/v1/calendars/${calendarId}/waitlist`;
  const raw = await post<unknown>(path, body, token, idempotencyKey);
  return validate(mutationResponseSchema, raw, path);
}
