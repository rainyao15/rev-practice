// Occupies a TCP port and never answers, to reproduce a CEF that did not finish
// shutting down. usage: node tools\hold-port.mjs <port> <seconds>
import net from 'node:net';

const port = Number(process.argv[2] || 9222);
const seconds = Number(process.argv[3] || 20);

const server = net.createServer((socket) => {
  socket.on('error', () => {});
  // accept and stay silent on purpose
});
server.on('error', (e) => {
  console.error('bind failed:', e.code);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`holding 127.0.0.1:${port} (pid ${process.pid}) for ${seconds}s`);
  setTimeout(() => process.exit(0), seconds * 1000);
});
