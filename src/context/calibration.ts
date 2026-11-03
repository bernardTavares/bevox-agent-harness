/**
 * CTX-04 Option C — token-estimate calibration.
 *
 * Computes the ratio `actual / estimated` between the provider-reported
 * `usage.input_tokens` and our pre-call `estimateTokens` count, so accuracy
 * is observable in prod (emitted as an OTel span attribute by the handler).
 * Pure + side-effect-free for unit testing.
 *
 * Returns `null` when there is no usable signal (estimated <= 0, actual
 * missing/<= 0, or any negative input) so the caller can skip emitting an
 * attribute rather than record a misleading NaN/Infinity.
 */
export function computeCalibrationRatio(
  estimated: number,
  actual: number | undefined,
): number | null {
  if (typeof actual !== "number") return null;
  if (estimated <= 0 || actual <= 0) return null;
  return actual / estimated;
}
