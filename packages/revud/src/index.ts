/**
 * Entry point for the revu daemon. The daemon owns the broker-side transport
 * and per-human state that cannot live on GitHub; it exposes the same contract
 * the frontend consumes. This module is the package's public surface and is
 * intentionally empty until that transport lands.
 */
export const REVUD_PACKAGE = '@revu/revud'
