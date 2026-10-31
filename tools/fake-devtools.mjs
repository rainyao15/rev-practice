// Pretends to be somebody else's DevTools endpoint (a browser someone left running
// with --remote-debugging-port). usage: node tools\fake-devtools.mjs <port> <seconds>
import http from 'node:http';

const port = Number(process.argv[2] || 9333);
const seconds = Number(process.argv[3] || 30);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/json/version')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        Browser: 'Chrome/146.0.7680.179',
        'Protocol-Version': '1.3',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.7680.179 Safari/537.36 Edg/146.0.7680.179',
      }),
    );
    return;
  }
  if (req.url.startsWith('/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1/' + port + '/x' }]));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake devtools on ${port} (pid ${process.pid}) for ${seconds}s`);
  setTimeout(() => process.exit(0), seconds * 1000);
});
