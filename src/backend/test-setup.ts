import { fakeMachine, memoryVault } from './lib/credentials.testing';
import { setLocalProtection } from './lib/local-protection';
import { setCredentialVault } from './lib/secrets';

// Os testes correm sem Electron. Instalam o que a app empacotada tem depois do
// arranque — proteção local e um cofre pronto — para as integrações funcionarem.
// O arranque (server.ts) substitui o cofre por um real, aberto com esta proteção.
setLocalProtection(fakeMachine('vitest'));
setCredentialVault(memoryVault());
