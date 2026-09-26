import { startBackend } from './server';
import { createLocalProtection } from './lib/local-protection';

startBackend({ localProtection: createLocalProtection(null) }).catch((error) => {
  console.error(error);
  process.exit(1);
});
