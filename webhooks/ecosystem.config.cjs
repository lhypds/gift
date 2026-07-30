// PM2 configuration for the gift webhooks server, used by ./start.sh:
//
//     pm2 start ecosystem.config.cjs --update-env
//
// PM2_NAME and PORT come from this folder's .env, so the process name and the
// listening port are set in one place. Everything else the server needs — the
// secret, the host, the endpoint path — server.js reads from the same .env at
// startup, which keeps the secret out of the PM2 process list.
const fs = require('fs');
const path = require('path');

function readEnv() {
  try {
    return fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return '';
  }
}

function getEnvVar(key, defaultValue) {
  const match = readEnv().match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : defaultValue;
}

const PM2_NAME = getEnvVar('PM2_NAME', 'gift-webhooks');
const PORT = getEnvVar('PORT', getEnvVar('GIFT_SERVE_PORT', '3999'));

module.exports = {
  apps: [
    {
      name: PM2_NAME,
      script: 'server.js',
      cwd: __dirname,
      time: true,
      env: {
        // GIFT_SERVE_PORT is the name server.js reads; PORT is kept in step so
        // both names agree no matter which one something downstream looks at.
        GIFT_SERVE_PORT: PORT,
        PORT: PORT,
        NODE_ENV: 'production',
      },
    },
  ],
};
