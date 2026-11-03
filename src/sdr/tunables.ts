/**
 * SDR tunables — §7 Ross×Bertuzzi A/B resolution helpers.
 *
 * Pure functions: profile value (per-account) takes precedence over the
 * harness-level config default. This is the "A/B hook" referenced in §7:
 * accounts that specify a framework in their sdr_profile get that behaviour;
 * accounts that don't get the global default from harness-config.ts.
 */

export type QualificationFramework = "PACT" | "PACT2";

/**
 * Resolve which qualification framework applies for a given account execution.
 *
 * §7 conflict: Ross "sniff test" (lighter PACT) vs Bertuzzi PACT2 (+Timing,
 * recommended for mature markets or displacement plays). The per-account
 * sdr_profile wins when present; otherwise falls back to the harness default
 * (SDR_QUALIFICATION_FRAMEWORK env var, default "PACT").
 *
 * @param profileValue - value from sdr_profile.qualification_framework (undefined when absent)
 * @param configDefault - harness-level default from getHarnessConfig().sdr.qualificationFramework
 */
export function resolveQualificationFramework(
  profileValue: QualificationFramework | undefined,
  configDefault: QualificationFramework,
): QualificationFramework {
  return profileValue ?? configDefault;
}
