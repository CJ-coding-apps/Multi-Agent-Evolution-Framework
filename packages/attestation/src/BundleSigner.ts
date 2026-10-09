import type { AttestationBundle } from '@maf/types';
import { Attestor, signBundle } from './Attestor.js';
import type { AnyBundle, SignedRunStatement } from './Attestor.js';

type Unsigned = Omit<AttestationBundle, 'signature'> | Omit<SignedRunStatement, 'signature'>;

/**
 * Signs and checks bundles with one fixed secret by the Attestor's rules — the same bytes signed
 * and the same `keySource` rule on verify — so the two cannot disagree about a bundle. As in the
 * Attestor, an empty secret is no secret: it means the development key.
 */
export class BundleSigner {
  constructor(private readonly secret: string) {}

  /** The signature for an unsigned bundle in either shape: HMAC over the canonical statement. */
  sign(payload: Unsigned): string {
    return signBundle(payload, { secret: this.secret });
  }

  /**
   * Whether the signature matches this signer's secret AND the bundle's own `keySource` names
   * that kind of key — `Attestor.verify`, so a bundle re-signed with the public development key
   * cannot pass here while claiming `"env"`. A bundle with no `keySource` (0.2.0) is checked on
   * its signature alone.
   */
  verify(bundle: AnyBundle): boolean {
    return Attestor.verify(bundle, { secret: this.secret });
  }

  static signStatic(payload: Unsigned, secret: string): string {
    return new BundleSigner(secret).sign(payload);
  }

  static verifyStatic(bundle: AnyBundle, secret: string): boolean {
    return new BundleSigner(secret).verify(bundle);
  }
}
