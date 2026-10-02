// Minimal local S3 protocol fixture. Exercises the real SDK and ZIP persistence;
// it does not validate signatures, permissions, or compatibility with real COS.
import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
export async function startS3Emulator(root, rejectWrites) {
  mkdirSync(root, { recursive: true });
  const file = key => resolve(root, Buffer.from(key).toString('hex'));
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const error = (code, status) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<Error><Code>${code}</Code><Message>E2E fixture</Message></Error>`); };
    if (url.searchParams.has('versioning')) { res.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>'); return; }
    if (url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = readdirSync(root).map(name => Buffer.from(name, 'hex').toString()).filter(key => key.startsWith(prefix));
      res.setHeader('content-type', 'application/xml');
      res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map(key => `<Contents><Key>${xml(key)}</Key></Contents>`).join('')}</ListBucketResult>`); return;
    }
    if (!key) return error('InvalidRequest', 400);
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (key.includes('/workspaces/') && rejectWrites()) return error('AccessDenied', 403);
      writeFileSync(file(key), Buffer.concat(chunks)); res.setHeader('ETag', '"e2e"'); res.end(); return;
    }
    if (req.method === 'GET') { if (!existsSync(file(key))) return error('NoSuchKey', 404); res.end(readFileSync(file(key))); return; }
    if (req.method === 'DELETE') { if (existsSync(file(key))) unlinkSync(file(key)); res.writeHead(204).end(); return; }
    error('NotImplemented', 501);
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` };
}
