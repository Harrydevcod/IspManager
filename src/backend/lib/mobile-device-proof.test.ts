import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signedFetch } from './sms-outbox';
import { requestMobileDeviceProof, sendDesktopIdentity } from './mobile-device-proof';

vi.mock('./sms-outbox', () => ({signedFetch:vi.fn()}));
const fetchMock = vi.mocked(signedFetch);
beforeEach(() => fetchMock.mockReset());

describe('mobile device proof over the paired LAN', () => {
  it('requests a signed response with the enrollment nonce and never selects the relay', async () => {
    fetchMock.mockResolvedValue(new Response('{"certificatePem":"cert"}', {headers:{'x-ispm-response-signature':'signed'}}));
    const proof = await requestMobileDeviceProof('http://192.168.1.20:8765','fresh-nonce');
    expect(fetchMock).toHaveBeenCalledWith('/mobile/device-certificate','GET',undefined,5000,'http://192.168.1.20:8765','fresh-nonce');
    expect(proof.body.toString()).toBe('{"certificatePem":"cert"}');
    expect(proof.signature).toBe('signed');
  });

  it('rejects oversized and unsuccessful responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(16385)));
    await expect(requestMobileDeviceProof('http://192.168.1.20:8765','n')).rejects.toThrow('MOBILE_DEVICE_PROOF_TOO_LARGE');
    fetchMock.mockResolvedValueOnce(new Response('', {status:404}));
    await expect(requestMobileDeviceProof('http://192.168.1.20:8765','n')).rejects.toThrow('MOBILE_DEVICE_PROOF_UNAVAILABLE');
    await expect(requestMobileDeviceProof('','n')).rejects.toThrow('MOBILE_DEVICE_PROOF_UNAVAILABLE');
  });

  it('sends desktop identity over the LAN with a fresh response nonce', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', {headers:{'x-ispm-response-signature':'ack'}}));
    const payload = {host:'192.168.1.10', port:38421, certificatePem:'cert'};
    const proof = await sendDesktopIdentity('http://192.168.1.20:8765','nonce',payload);
    expect(fetchMock).toHaveBeenCalledWith('/mobile/desktop-identity','POST',payload,5000,'http://192.168.1.20:8765','nonce');
    expect(proof.body.toString()).toBe('{"ok":true}');
    expect(proof.signature).toBe('ack');
  });
});
