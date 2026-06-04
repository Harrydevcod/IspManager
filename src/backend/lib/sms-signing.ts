import { createHmac, timingSafeEqual } from 'node:crypto';

export type SmsSignatureInput = {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
};

type SmsSignatureVerificationInput = SmsSignatureInput & {
  signature: string;
  now?: Date;
  maxSkewMs?: number;
  claimNonce?: (nonce: string, timestamp: string) => boolean;
};

const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonical(input: SmsSignatureInput) {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.body
  ].join('\n');
}

export function createSmsSignature(input: SmsSignatureInput): string {
  return createHmac('sha256', input.secret).update(canonical(input)).digest('hex');
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifySmsSignature(input: SmsSignatureVerificationInput): boolean {
  if (!ISO_UTC_TIMESTAMP.test(input.timestamp)) return false;
  const timestampMs = Date.parse(input.timestamp);
  const nowMs = (input.now ?? new Date()).getTime();
  const maxSkewMs = input.maxSkewMs ?? 5 * 60_000;
  if (!Number.isFinite(timestampMs)) return false;
  if (new Date(timestampMs).toISOString() !== input.timestamp) return false;
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(maxSkewMs) || maxSkewMs < 0) return false;
  const skew = Math.abs(nowMs - timestampMs);
  if (skew > maxSkewMs) return false;
  if (!timingSafeEqualString(createSmsSignature(input), input.signature)) return false;
  return input.claimNonce ? input.claimNonce(input.nonce, input.timestamp) : true;
}
