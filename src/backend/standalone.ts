import { startBackend } from './server';

startBackend().catch((error) => {
  console.error(error);
  process.exit(1);
});
