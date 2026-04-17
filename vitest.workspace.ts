import { defineWorkspace } from 'vitest/config';
export default defineWorkspace([
  'packages/core',
  'packages/postgres',
  'examples/banking-api',
  'examples/express-api',
  'examples/insurance-api'
]);
