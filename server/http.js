import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

/**
 * Thrown by route handlers to return a clean error to the client.
 *
 * `code` and `params` let the browser render the message in the user's own
 * language; `message` is the English fallback sent alongside them.
 */
export class HttpError extends Error {
  constructor(status, message, code = null, params = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}
export const badRequest = (msg, code, params) => new HttpError(400, msg, code, params);
export const notFound = (msg = 'Not found', code = 'NOT_FOUND', params) =>
  new HttpError(404, msg, code, params);
export const forbidden = (msg = 'Not allowed', code = 'ADMIN_ONLY', params) =>
  new HttpError(403, msg, code, params);

export class Router {
  #routes = [];

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((part) => {
            if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            keys.push(part.slice(1));
            return '([^/]+)';
          })
          .join('/') +
        '$',
    );
    this.#routes.push({ method, pattern, regex, keys, handler });
    return this;
  }

  get = (p, h) => this.add('GET', p, h);
  post = (p, h) => this.add('POST', p, h);
  put = (p, h) => this.add('PUT', p, h);
  patch = (p, h) => this.add('PATCH', p, h);
  delete = (p, h) => this.add('DELETE', p, h);

  match(method, pathname) {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: route.handler, params, pattern: route.pattern };
    }
    return null;
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readJsonBody(req, limit = 3 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw badRequest('Request body too large', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON body', 'BAD_JSON');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve a file from `root`, guarding against path traversal. Returns false if absent. */
export async function serveStatic(res, root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const full = join(root, clean);
  if (!full.startsWith(root + sep) && full !== root) return false;
  try {
    const info = await stat(full);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(full).pipe(res);
    return true;
  } catch {
    return false;
  }
}
