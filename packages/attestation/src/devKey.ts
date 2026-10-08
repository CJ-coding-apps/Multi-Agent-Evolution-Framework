/**
 * The public development signing key. Anyone can produce a bundle that verifies under it, so a
 * bundle it signed is marked `keySource: "dev"` and is evidence of nothing (docs/SECURITY.md).
 * Shared by the Attestor and the BundleSigner so the two verifiers agree on what "dev" means.
 */
export const DEV_SIGNING_KEY = 'dev-secret';
