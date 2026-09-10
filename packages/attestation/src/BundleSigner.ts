import crypto from 'node:crypto';
import type { AttestationBundle } from '@maf/types';

export class BundleSigner {
  constructor(private readonly secret: string) {}

  sign(payload: Omit<AttestationBundle, 'signature'>): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  verify(bundle: AttestationBundle): boolean {
    const { signature, ...rest } = bundle;
    const expected = this.sign(rest);
    try {
      return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  static signStatic(payload: Omit<AttestationBundle, 'signature'>, secret: string): string {
    return new BundleSigner(secret).sign(payload);
  }

  static verifyStatic(bundle: AttestationBundle, secret: string): boolean {
    return new BundleSigner(secret).verify(bundle);
  }
}
