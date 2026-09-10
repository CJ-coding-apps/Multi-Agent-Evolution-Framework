import { z } from 'zod';
import type { BlackboardKey, BlackboardEntry } from '@maf/types';

export class BlackboardValidationError extends Error {
  constructor(key: BlackboardKey, issue: string) {
    super(`Blackboard validation failed for key "${key}": ${issue}`);
  }
}

export class BlackboardValidator {
  private schemas = new Map<BlackboardKey, z.ZodTypeAny>();

  register(key: BlackboardKey, schema: z.ZodTypeAny): void {
    this.schemas.set(key, schema);
  }

  validate(entry: BlackboardEntry): void {
    const schema = this.schemas.get(entry.key);
    if (!schema) return; // no schema registered → accept anything

    const result = schema.safeParse(entry.value);
    if (!result.success) {
      const msg = result.error.issues.map((i: { message: string }) => i.message).join('; ');
      throw new BlackboardValidationError(entry.key, msg);
    }
  }

  // Convenience: build a validator that checks BlackboardValue.kind + inner value
  static stringValue(): z.ZodTypeAny {
    return z.object({ kind: z.literal('string'), value: z.string() });
  }

  static jsonValue(inner?: z.ZodTypeAny): z.ZodTypeAny {
    return z.object({ kind: z.literal('json'), value: inner ?? z.unknown() });
  }

  static bufferValue(): z.ZodTypeAny {
    return z.object({ kind: z.literal('buffer'), value: z.instanceof(Buffer) });
  }
}
