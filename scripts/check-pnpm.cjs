const fs = require('node:fs');

for (const lockfile of ['package-lock.json', 'yarn.lock']) {
  fs.rmSync(lockfile, { force: true });
}

const userAgent = process.env.npm_config_user_agent ?? '';

if (!userAgent.startsWith('pnpm/')) {
  console.error('Use pnpm instead');
  process.exit(1);
}