import type { FastifyInstance } from 'fastify';
import { authBypassed, isSetupComplete, loadUserById, verifyToken } from './auth';
import { createMobileGateway } from './mobile-gateway';
import type { MobileTlsIdentity } from './mobile-tls-identity';

/** Build a gateway without listening. Enrollment and lifecycle are the caller's responsibility. */
export function createBackendMobileGateway(
  app: FastifyInstance,
  identity: MobileTlsIdentity,
  trustedClientCertificatePem: string,
  isDeviceAllowed: (fingerprintSha256: string) => boolean | Promise<boolean>
) {
  return createMobileGateway({
    identity,
    trustedClientCertificatePem,
    isDeviceAllowed,
    authReady: () => !authBypassed() && isSetupComplete(),
    isUserAuthenticated: token => {
      const payload = verifyToken(token);
      return !!payload && !!loadUserById(payload.uid);
    },
    dispatch: async request => {
      const response = await app.inject({
        method: request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url: request.url,
        headers: request.headers,
        payload: request.body.length ? request.body : undefined,
        remoteAddress: request.remoteAddress
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') headers[key] = value;
        else if (typeof value === 'number') headers[key] = String(value);
      }
      return {statusCode: response.statusCode, headers, body: response.rawPayload};
    }
  });
}
