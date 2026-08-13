// PM2 configuration for the gift webhooks server, used by ./start.sh:
//
//     pm2 start ecosystem.config.cjs --update-env
//
// PM2_NAME and PORT come from gift's configuration — config.json in this folder
// — so the process name and the listening port are set in one place. Everything else the server needs — the secret, the
// host, the endpoint path — serve.js reads from the same place at startup, which
// keeps the secret out of the PM2 process list.
const config = require('./utils/config.js');

const PM2_NAME = config.get('PM2_NAME', 'gift-webhooks');
const PORT = config.get('PORT', config.get('GIFT_SERVE_PORT', '3999'));

module.exports = {
  apps: [
    {
      name: PM2_NAME,
      script: 'serve.js',
      cwd: __dirname,
      time: true,
      env: {
        // GIFT_SERVE_PORT is the name serve.js reads; PORT is kept in step so
        // both names agree no matter which one something downstream looks at.
        GIFT_SERVE_PORT: PORT,
        PORT: PORT,
        NODE_ENV: 'production',
      },
    },
  ],
};
