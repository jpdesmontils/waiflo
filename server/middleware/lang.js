const SUPPORTED = ['en', 'fr'];
const DEFAULT   = 'en';

function parseCookies(req) {
  const cookies = {};
  const raw = req.headers.cookie;
  if (!raw) return cookies;
  raw.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function detectLang(req) {
  // 1. Query param (highest priority)
  const query = req.query.lang;
  if (query && SUPPORTED.includes(query)) return query;

  // 2. Cookie
  const cookies = parseCookies(req);
  if (cookies.lang && SUPPORTED.includes(cookies.lang)) return cookies.lang;

  // 3. Accept-Language header
  const accept = req.headers['accept-language'] || '';
  const primary = accept.split(',')[0].split('-')[0].toLowerCase().trim();
  if (SUPPORTED.includes(primary)) return primary;

  return DEFAULT;
}

export function langMiddleware(req, res, next) {
  const lang = detectLang(req);
  // Persist query param choice as cookie
  if (req.query.lang && SUPPORTED.includes(req.query.lang)) {
    res.setHeader('Set-Cookie', `lang=${lang}; Max-Age=${365 * 24 * 3600}; Path=/; SameSite=Lax`);
  }
  req.lang = lang;
  next();
}
