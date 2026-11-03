import { z } from "zod";

export const sdrProfileSchema = z.object({
  enabled: z.boolean(),
  icp_ref: z.string().optional(),
  persona_refs: z.array(z.string()).optional(),
  qualification_framework: z.enum(["PACT", "PACT2"]).default("PACT"),
  cadence_ref: z.string().optional(),
});

export type SdrProfile = z.infer<typeof sdrProfileSchema>;
