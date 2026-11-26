import { signedFetch } from './sms-outbox';

const MAX_PROOF_BYTES = 16 * 1024;

/** Fetch from the paired LAN address; enrollment verifies the response signature. */
async function readProof(response: Response): Promise<{body: Buffer; signature: string | null}> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error('MOBILE_DEVICE_PROOF_UNAVAILABLE');
  }
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_PROOF_BYTES) {
    await response.body?.cancel();
    throw new Error('MOBILE_DEVICE_PROOF_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) return {body:Buffer.alloc(0), signature:response.headers.get('x-ispm-response-signature')};
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROOF_BYTES) {
        await reader.cancel();
        throw new Error('MOBILE_DEVICE_PROOF_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return {body:Buffer.concat(chunks), signature:response.headers.get('x-ispm-response-signature')};
}

export async function requestMobileDeviceProof(baseUrl: string, nonce: string): Promise<{body: Buffer; signature: string | null}> {
  if (!baseUrl) throw new Error('MOBILE_DEVICE_PROOF_UNAVAILABLE');
  return readProof(await signedFetch('/mobile/device-certificate', 'GET', undefined, 5000, baseUrl, nonce));
}

export async function sendDesktopIdentity(baseUrl: string, nonce: string, identity: {host: string; port: number; certificatePem: string}): Promise<{body: Buffer; signature: string | null}> {
  if (!baseUrl) throw new Error('MOBILE_DEVICE_PROOF_UNAVAILABLE');
  const response = await signedFetch('/mobile/desktop-identity', 'POST', identity, 5000, baseUrl, nonce);
  if (response.status === 409) {
    await response.body?.cancel().catch(() => {});
    throw new Error('MOBILE_DESKTOP_IDENTITY_CONFLICT');
  }
  return readProof(response);
}
