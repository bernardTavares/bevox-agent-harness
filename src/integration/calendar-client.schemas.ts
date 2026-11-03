import { z } from "zod";

/**
 * Permissive Zod schemas for Calendar Service responses.
 *
 * The exact field shape is not documented in this repo — these schemas
 * intentionally use `.passthrough()` and tolerate snake_case/camelCase
 * variants. The goal is to (a) ensure the response is at least a JSON
 * object (defense against malformed proxy responses) and (b) provide an
 * upgrade path: tighten field-by-field after a real sample is captured.
 */

export const appointmentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export const appointmentArraySchema = z.array(appointmentSchema);

export const listAppointmentsResponseSchema = z.union([
  appointmentArraySchema,
  z.object({ appointments: appointmentArraySchema }).passthrough(),
]);

export const availabilityResponseSchema = z.object({}).passthrough();

export const healthResponseSchema = z.object({}).passthrough();

export const mutationResponseSchema = z.object({}).passthrough();
