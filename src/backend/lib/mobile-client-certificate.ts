import { X509Certificate } from 'node:crypto';

const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2';

/** Accept only an unexpired self-signed P-256 client certificate. */
export function inspectMobileClientCertificate(input: string | Buffer): { certificatePem: string; fingerprintSha256: string } {
  try {
    const certificate = new X509Certificate(input);
    const now = Date.now();
    const from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to) throw new Error();
    if (certificate.ca || certificate.publicKey.asymmetricKeyType !== 'ec' || certificate.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    if ((certificate.keyUsage && !certificate.keyUsage.includes(CLIENT_AUTH_OID)) || !certificate.verify(certificate.publicKey)) throw new Error();
    return { certificatePem: certificate.toString(), fingerprintSha256: certificate.fingerprint256.replaceAll(':', '').toLowerCase() };
  } catch {
    throw new Error('MOBILE_CLIENT_CERTIFICATE_INVALID');
  }
}
