import crypto from 'node:crypto';
import type { AttestationBundle, KeySource } from '@maf/types';
import { DEV_SIGNING_KEY } from './devKey.js';

export class BundleSigner {
  constructor(private readonly secret: string) {}

  sign(payload: Omit<AttestationBundle, 'signature'>): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  /**
   * Whether the signature matches this signer's secret AND the bundle's own `keySource` names
   * that kind of key — the same rule `Attestor.verify` applies, so a bundle re-signed with the
   * public development key cannot pass here while claiming `"env"`. A bundle with no
   * `keySource` (0.2.0) is checked on its signature alone.
   */
  verify(bundle: AttestationBundle): boolean {
    const { signature, ...rest } = bundle;
    const expected = this.sign(rest);
    let matches: boolean;
    try {
      matches = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
    const claimed = (bundle as { keySource?: KeySource }).keySource;
    if (claimed === undefined) return matches;
    const actual: KeySource = this.secret === DEV_SIGNING_KEY ? 'dev' : 'env';
    return matches && claimed === actual;
  }

  static signStatic(payload: Omit<AttestationBundle, 'signature'>, secret: string): string {
    return new BundleSigner(secret).sign(payload);
  }

  static verifyStatic(bundle: AttestationBundle, secret: string): boolean {
    return new BundleSigner(secret).verify(bundle);
  }
}
