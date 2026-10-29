import http from 'node:http';
import fs from 'node:fs';

/** Serve one file at a time over HTTP with Range support (CEF needs it for seeking). */
export function startMediaServer(port) {
  let current = { file: null, size: 0 };

  const server = http.createServer((req, res) => {
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      return res.end();
    }
    if (!current.file) {
      res.writeHead(503, headers);
      return res.end('no wallpaper');
    }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : current.size - 1;
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end) || end >= current.size) end = current.size - 1;
      if (start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${current.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${current.size}`,
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(current.file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': current.size });
    fs.createReadStream(current.file).pipe(res);
  });

  server.listen(port, '127.0.0.1');

  return {
    url: (name) => `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
    setFile(file) {
      if (!file || file === current.file) return current.file;
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return current.file;
        current = { file, size: st.size };
        return file;
      } catch {
        return current.file;
      }
    },
    close: () => server.close(),
  };
}
