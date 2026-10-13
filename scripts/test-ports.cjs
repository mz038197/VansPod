const net = require('node:net');

// Probe all three adjacent client routes, including Windows excluded ranges.
exports.freeBasePort = async function freeBasePort() {
  for (let base = 50000; base < 65000; base += 3) {
    const servers = [];
    try {
      for (const port of [base, base + 1, base + 2]) {
        const server = net.createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
        servers.push(server);
      }
      return base;
    } catch (error) {
      if (!['EACCES', 'EADDRINUSE'].includes(error.code)) throw error;
    } finally {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    }
  }
  throw new Error('No three-port verification range is available');
};
