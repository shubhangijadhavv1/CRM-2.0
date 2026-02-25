import { resolve4, resolve6 } from 'node:dns/promises';
import net from 'node:net';

export type DomainScanOptions = {
  maxPages?: number;
  maxDepth?: number;
  includeSubdomains?: boolean;
  maxImages?: number;
  userAgent?: string;
};

export type DomainScanImage = {
  url: string;
  isInternal: boolean;
  bytes: number | null;
  contentType: string | null;
};

export type DomainScanError = { url: string; error: string };

export type DetectedTechnology = {
  name: string;
  category: 'cms' | 'framework' | 'library' | 'server' | 'platform' | 'language' | 'analytics' | 'other';
  version: string | null;
  confidence: 'high' | 'medium' | 'low';
  icon: string;
};

export type DomainScanResult = {
  startUrl: string;
  baseHost: string;
  pagesScanned: number;
  pagesVisited: string[];
  internalLinks: string[];
  externalLinks: string[];
  images: DomainScanImage[];
  errors: DomainScanError[];
  technologies: DetectedTechnology[];
};

const DEFAULTS: Required<Pick<DomainScanOptions, 'maxPages' | 'maxDepth' | 'includeSubdomains' | 'maxImages' | 'userAgent'>> = {
  maxPages: 75,
  maxDepth: 3,
  includeSubdomains: true,
  maxImages: 200,
  userAgent: 'NexusCRM-DomainMonitoring/1.0'
};

const SKIP_SCHEMES = new Set(['mailto:', 'tel:', 'javascript:', 'data:', 'blob:', 'about:']);
const SKIP_EXT_RE = /\.(pdf|zip|rar|7z|gz|tgz|mp4|mov|avi|mkv|mp3|wav|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot)$/i;

function normalizeStartUrl(input: string): URL {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('domain is required');
  // If user entered "example.com", treat as https://example.com
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https domains are supported');
  if (!u.hostname) throw new Error('Invalid domain');
  // Normalize to root path if no pathname
  if (!u.pathname) u.pathname = '/';
  return u;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // fc00::/7
  if (s.startsWith('fe80:')) return true; // fe80::/10
  return false;
}

function isUnsafeHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  return false;
}

async function assertPublicHost(hostname: string) {
  if (isUnsafeHostname(hostname)) throw new Error('Blocked host');
  if (net.isIP(hostname)) {
    if (net.isIP(hostname) === 4 && isPrivateIpv4(hostname)) throw new Error('Blocked private IP');
    if (net.isIP(hostname) === 6 && isPrivateIpv6(hostname)) throw new Error('Blocked private IP');
    return;
  }

  // Resolve A/AAAA to mitigate obvious SSRF.
  const ips: string[] = [];
  try {
    ips.push(...(await resolve4(hostname)));
  } catch {
    // ignore
  }
  try {
    ips.push(...(await resolve6(hostname)));
  } catch {
    // ignore
  }
  if (ips.length === 0) throw new Error('Unable to resolve domain');
  for (const ip of ips) {
    if (net.isIP(ip) === 4 && isPrivateIpv4(ip)) throw new Error('Blocked private IP');
    if (net.isIP(ip) === 6 && isPrivateIpv6(ip)) throw new Error('Blocked private IP');
  }
}

function isInternalUrl(u: URL, baseHost: string, includeSubdomains: boolean): boolean {
  const h = u.hostname.toLowerCase();
  const base = baseHost.toLowerCase();
  if (h === base) return true;
  if (includeSubdomains && h.endsWith(`.${base}`)) return true;
  return false;
}

function stripFragment(u: URL): URL {
  const nu = new URL(u.toString());
  nu.hash = '';
  return nu;
}

function shouldSkipForCrawl(u: URL): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (SKIP_SCHEMES.has(u.protocol)) return true;
  if (SKIP_EXT_RE.test(u.pathname)) return true;
  return false;
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|svg|ico|avif|bmp|tiff?)$/i;

function extractUrlsFromHtml(html: string, baseUrl: string): { links: string[]; images: string[] } {
  const links: string[] = [];
  const images: string[] = [];

  const pushUrl = (arr: string[], raw: string) => {
    const v = String(raw || '').trim();
    if (!v) return;
    if (v.startsWith('#')) return;
    if (v.startsWith('data:')) return;
    arr.push(v);
  };

  const ATTR_RE = (tag: string, attr: string) =>
    new RegExp(`<${tag}\\b[^>]*\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');

  const aHref = ATTR_RE('a', 'href');
  const linkHref = ATTR_RE('link', 'href');
  const scriptSrc = ATTR_RE('script', 'src');
  const imgSrc = ATTR_RE('img', 'src');
  const sourceSrc = ATTR_RE('source', 'src');

  for (const re of [aHref, linkHref, scriptSrc]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) pushUrl(links, m[1] || m[2] || m[3]);
  }
  for (const re of [imgSrc, sourceSrc]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) pushUrl(images, m[1] || m[2] || m[3]);
  }

  // srcset (img/source)
  const srcsetRe = new RegExp(`<(?:img|source)\\b[^>]*\\ssrcset\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  let ms: RegExpExecArray | null;
  while ((ms = srcsetRe.exec(html))) {
    const srcset = (ms[1] || ms[2] || ms[3] || '').trim();
    if (!srcset) continue;
    srcset
      .split(',')
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean)
      .forEach((u) => pushUrl(images, u));
  }

  // Lazy-loading attributes: data-src, data-lazy-src, data-original, data-bg
  const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background-image'];
  for (const attr of lazyAttrs) {
    const re = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const val = m[1] || m[2];
      if (val && IMAGE_EXTENSIONS.test(val)) pushUrl(images, val);
    }
  }

  // data-srcset (lazy-loaded responsive images)
  const dataSrcsetRe = /\sdata-srcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let dss: RegExpExecArray | null;
  while ((dss = dataSrcsetRe.exec(html))) {
    const srcset = (dss[1] || dss[2] || '').trim();
    if (!srcset) continue;
    srcset
      .split(',')
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean)
      .forEach((u) => pushUrl(images, u));
  }

  // Open Graph and Twitter meta image tags
  const metaImageRe = /<meta\b[^>]*(?:property|name)\s*=\s*(?:"(?:og:image|twitter:image)[^"]*"|'(?:og:image|twitter:image)[^']*')[^>]*content\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let mi: RegExpExecArray | null;
  while ((mi = metaImageRe.exec(html))) {
    const val = mi[1] || mi[2];
    if (val) pushUrl(images, val);
  }
  // Also match reversed attribute order (content before property)
  const metaImageRe2 = /<meta\b[^>]*content\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*(?:property|name)\s*=\s*(?:"(?:og:image|twitter:image)[^"]*"|'(?:og:image|twitter:image)[^']*')/gi;
  while ((mi = metaImageRe2.exec(html))) {
    const val = mi[1] || mi[2];
    if (val) pushUrl(images, val);
  }

  // CSS background-image: url(...) in inline styles and <style> blocks
  const cssUrlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+))\s*\)/gi;
  let cu: RegExpExecArray | null;
  while ((cu = cssUrlRe.exec(html))) {
    const val = (cu[1] || cu[2] || cu[3] || '').trim();
    if (val && IMAGE_EXTENSIONS.test(val)) pushUrl(images, val);
  }

  // Scan for image URLs embedded in JS strings/JSON (React, Next.js, etc.)
  // Matches quoted strings that look like image file paths
  const jsImageRe = /(?:"|')((https?:)?\/\/[^\s"']+?\.(jpe?g|png|gif|webp|svg|avif)(?:\?[^\s"']*)?)\1?(?:"|')/gi;
  let ji: RegExpExecArray | null;
  while ((ji = jsImageRe.exec(html))) {
    const val = ji[1];
    if (val && !val.includes('*') && val.length < 500) pushUrl(images, val);
  }

  // Also catch relative image paths in JS strings: "/images/photo.jpg", "/assets/logo.png"
  const relImageRe = /(?:"|')(\/[^\s"']*?\.(jpe?g|png|gif|webp|svg|avif|ico)(?:\?[^\s"']*)?)(?:"|')/gi;
  let ri: RegExpExecArray | null;
  while ((ri = relImageRe.exec(html))) {
    const val = ri[1];
    if (val && !val.includes('*') && val.length < 500) pushUrl(images, val);
  }

  // WordPress-specific: wp-content/uploads paths
  const wpImageRe = /(?:"|')((?:https?:)?\/\/[^\s"']*?wp-content\/uploads\/[^\s"']*?\.(jpe?g|png|gif|webp|svg)[^\s"']*)(?:"|')/gi;
  let wi: RegExpExecArray | null;
  while ((wi = wpImageRe.exec(html))) {
    const val = wi[1];
    if (val) pushUrl(images, val);
  }

  // Next.js image optimization: /_next/image?url=...
  const nextImageRe = /\/_next\/image\?url=([^&"'\s]+)/gi;
  let ni: RegExpExecArray | null;
  while ((ni = nextImageRe.exec(html))) {
    try {
      const decoded = decodeURIComponent(ni[1]);
      pushUrl(images, decoded);
    } catch { /* ignore */ }
  }

  // Convert to absolute URLs
  const toAbs = (raw: string) => {
    try {
      let cleaned = raw;
      if (cleaned.startsWith('//')) cleaned = 'https:' + cleaned;
      const u = new URL(cleaned, baseUrl);
      if (SKIP_SCHEMES.has(u.protocol)) return null;
      return stripFragment(u).toString();
    } catch {
      return null;
    }
  };

  return {
    links: Array.from(new Set(links.map(toAbs).filter(Boolean) as string[])),
    images: Array.from(new Set(images.map(toAbs).filter(Boolean) as string[]))
  };
}

async function readTextWithLimit(res: Response, limitBytes: number): Promise<string> {
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const n = Number(lenHeader);
    if (!Number.isNaN(n) && n > limitBytes) throw new Error(`Response too large (${n} bytes)`);
  }
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limitBytes) throw new Error(`Response too large (>${limitBytes} bytes)`);
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.toString('utf-8');
}

async function safeFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}, baseHostForRedirectCheck?: string) {
  const timeoutMs = init.timeoutMs ?? 12000;
  const headers = new Headers(init.headers || {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = new URL(url);
    for (let i = 0; i < 5; i++) {
      await assertPublicHost(current.hostname);
      const res = await fetch(current.toString(), { ...init, headers, redirect: 'manual', signal: controller.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return res;
        const next = new URL(loc, current);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('Redirected to unsupported protocol');
        if (baseHostForRedirectCheck && next.hostname !== baseHostForRedirectCheck) {
          // allow cross-host redirects only if still public; already checked. Keep crawling logic internal/external separate.
        }
        current = next;
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImageMeta(url: string, userAgent: string): Promise<{ bytes: number | null; contentType: string | null }> {
  const headers = { 'User-Agent': userAgent, Accept: '*/*' };
  try {
    const head = await safeFetch(url, { method: 'HEAD', headers, timeoutMs: 12000 });
    const ct = head.headers.get('content-type');
    const cl = head.headers.get('content-length');
    if (cl && !Number.isNaN(Number(cl))) return { bytes: Number(cl), contentType: ct };
  } catch {
    // ignore
  }

  try {
    const get = await safeFetch(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, timeoutMs: 15001 });
    const ct = get.headers.get('content-type');
    const cr = get.headers.get('content-range'); // bytes 0-0/1234
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) return { bytes: Number(m[1]), contentType: ct };
    }
    const cl = get.headers.get('content-length');
    if (cl && !Number.isNaN(Number(cl))) return { bytes: Number(cl), contentType: ct };
  } catch {
    // ignore
  }
  return { bytes: null, contentType: null };
}

async function promisePool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export type DomainStatusResult = {
  isLive: boolean;
  isParked: boolean;
  parkingProvider?: string;
  statusCode?: number;
  responseTime?: number;
  error?: string;
};

// Common parking page indicators (strong indicators that almost certainly mean parked)
const STRONG_PARKING_INDICATORS = [
  'domain is parked',
  'this domain is for sale',
  'domain for sale',
  'buy this domain',
  'domain may be for sale',
  'this webpage is parked',
  'parked domain',
  'domain parking',
  'this domain has expired',
  'domain expired',
  'renew this domain',
  'domain has been registered',
  'sedoparking',
  'parkingcrew',
  'bodis.com',
  'above.com parking',
  'this domain name has been registered',
  'make an offer on this domain',
  'inquire about this domain',
  'domain is available',
  'get this domain',
  'purchase this domain'
];

// Weaker indicators that need context
const PARKING_INDICATORS = [
  // Generic phrases
  'coming soon',
  'under construction',
  'website coming soon',
  'site under construction',
  'future home of',
  'this site is under construction',
  'webpage not available',
  'page not found',
  'website not configured',
  'account suspended',
  'account has been suspended',
  'hosting expired',
  // Registrar mentions (in parking context)
  'godaddy',
  'namecheap',
  'hostinger',
  'bluehost',
  'domain.com',
  'register.com',
  'networksolutions',
  'enom',
  'name.com',
  'hover.com',
  'porkbun',
  'dynadot',
  'gandi.net',
  'ionos',
  '1and1',
  '1&1',
  'hostgator',
  'dreamhost',
  'sedo.com',
  'dan.com',
  'afternic',
  'hugedomains',
  'undeveloped.com',
  'uniregistry',
  // Default/placeholder pages
  'apache2 ubuntu default page',
  'apache2 debian default page',
  'welcome to nginx',
  'it works!',
  'index of /',
  'test page for',
  'default web site page',
  'iis windows server',
  'plesk default page',
  'cpanel default',
  'directadmin',
  'congratulations! your site is ready',
  'web server is running',
  'this is the default welcome page',
  'default page',
  'placeholder',
  'site not found',
  'no website configured'
];

// Known parking domains that pages redirect to
const PARKING_DOMAINS = [
  'sedoparking.com',
  'bodis.com',
  'parkingcrew.net',
  'above.com',
  'dsparking.com',
  'parkeddomain.com',
  'domainparking.com',
  'undeveloped.com',
  'dan.com',
  'afternic.com',
  'hugedomains.com',
  'sav.com',
  'domainmarket.com',
  'buydomains.com'
];

function detectParkingProvider(html: string, finalUrl: string): string | null {
  const lowerHtml = html.toLowerCase();
  const lowerUrl = finalUrl.toLowerCase();
  
  // Check if redirected to known parking domain
  for (const pd of PARKING_DOMAINS) {
    if (lowerUrl.includes(pd)) {
      return pd.split('.')[0].charAt(0).toUpperCase() + pd.split('.')[0].slice(1);
    }
  }
  
  // Check common registrars in content
  if (lowerHtml.includes('godaddy')) return 'GoDaddy';
  if (lowerHtml.includes('namecheap')) return 'Namecheap';
  if (lowerHtml.includes('hostinger')) return 'Hostinger';
  if (lowerHtml.includes('bluehost')) return 'Bluehost';
  if (lowerHtml.includes('hostgator')) return 'HostGator';
  if (lowerHtml.includes('ionos') || lowerHtml.includes('1and1') || lowerHtml.includes('1&1')) return 'IONOS';
  if (lowerHtml.includes('dreamhost')) return 'DreamHost';
  if (lowerHtml.includes('sedo')) return 'Sedo';
  if (lowerHtml.includes('bodis')) return 'Bodis';
  if (lowerHtml.includes('dan.com')) return 'Dan.com';
  if (lowerHtml.includes('afternic')) return 'Afternic';
  if (lowerHtml.includes('hugedomains')) return 'HugeDomains';
  if (lowerHtml.includes('porkbun')) return 'Porkbun';
  if (lowerHtml.includes('dynadot')) return 'Dynadot';
  if (lowerHtml.includes('gandi')) return 'Gandi';
  if (lowerHtml.includes('hover')) return 'Hover';
  if (lowerHtml.includes('enom')) return 'Enom';
  if (lowerHtml.includes('network solutions') || lowerHtml.includes('networksolutions')) return 'Network Solutions';
  
  // Default server pages
  if (lowerHtml.includes('apache2 ubuntu default') || lowerHtml.includes('apache2 debian default')) return 'Apache Default';
  if (lowerHtml.includes('welcome to nginx')) return 'Nginx Default';
  if (lowerHtml.includes('iis windows')) return 'IIS Default';
  if (lowerHtml.includes('plesk')) return 'Plesk Default';
  if (lowerHtml.includes('cpanel')) return 'cPanel Default';
  
  return 'Unknown Registrar';
}

function isParkedContent(html: string, finalUrl: string): { isParked: boolean; provider?: string } {
  const lowerHtml = html.toLowerCase();
  const lowerUrl = finalUrl.toLowerCase();
  
  // Check if redirected to known parking domain
  for (const pd of PARKING_DOMAINS) {
    if (lowerUrl.includes(pd)) {
      console.log(`[ParkingCheck] Detected parking domain in URL: ${pd}`);
      return { isParked: true, provider: detectParkingProvider(html, finalUrl) || undefined };
    }
  }
  
  // Check for STRONG parking indicators - single match is enough
  for (const indicator of STRONG_PARKING_INDICATORS) {
    if (lowerHtml.includes(indicator)) {
      console.log(`[ParkingCheck] Strong indicator found: ${indicator}`);
      return { isParked: true, provider: detectParkingProvider(html, finalUrl) || undefined };
    }
  }
  
  // Count weak parking indicators
  let weakMatchCount = 0;
  const matchedIndicators: string[] = [];
  for (const indicator of PARKING_INDICATORS) {
    if (lowerHtml.includes(indicator)) {
      weakMatchCount++;
      matchedIndicators.push(indicator);
    }
  }
  
  // Extract text content (remove HTML tags)
  const textContent = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Detect SPA / JavaScript-rendered apps — these have minimal HTML but are real sites
  const isSPA =
    lowerHtml.includes('react') ||
    lowerHtml.includes('react-dom') ||
    lowerHtml.includes('data-reactroot') ||
    lowerHtml.includes('__next_data__') ||
    lowerHtml.includes('/_next/') ||
    lowerHtml.includes('___gatsby') ||
    lowerHtml.includes('vue.') ||
    lowerHtml.includes('__vue__') ||
    lowerHtml.includes('__nuxt') ||
    lowerHtml.includes('/_nuxt/') ||
    lowerHtml.includes('ng-version') ||
    lowerHtml.includes('angular') ||
    lowerHtml.includes('svelte') ||
    lowerHtml.includes('__sveltekit') ||
    lowerHtml.includes('id="root"') ||
    lowerHtml.includes("id='root'") ||
    lowerHtml.includes('id="app"') ||
    lowerHtml.includes("id='app'") ||
    lowerHtml.includes('id="__next"') ||
    lowerHtml.includes('bundle.js') ||
    lowerHtml.includes('main.js') ||
    lowerHtml.includes('app.js') ||
    lowerHtml.includes('chunk.js') ||
    lowerHtml.includes('vendor.js') ||
    lowerHtml.includes('/static/js/') ||
    lowerHtml.includes('/assets/index') ||
    lowerHtml.includes('wp-content/') ||
    lowerHtml.includes('wp-includes/');

  if (isSPA) {
    console.log(`[ParkingCheck] SPA/JS-rendered app detected — not parked`);
    return { isParked: false };
  }

  // Check for meaningful content indicators
  const hasMeaningfulContent = 
    (lowerHtml.includes('<article') || 
     lowerHtml.includes('<main') || 
     lowerHtml.includes('<nav') ||
     lowerHtml.includes('class="content"') ||
     lowerHtml.includes('class="post"') ||
     lowerHtml.includes('class="blog"') ||
     lowerHtml.includes('class="header"') ||
     lowerHtml.includes('class="footer"') ||
     lowerHtml.includes('class="menu"') ||
     lowerHtml.includes('class="nav"') ||
     (lowerHtml.match(/<script\s/g) || []).length >= 3 ||
     (lowerHtml.match(/<a\s+[^>]*href/g) || []).length > 10);
  
  // If 2+ weak indicators AND no meaningful content structure
  if (weakMatchCount >= 2 && !hasMeaningfulContent) {
    console.log(`[ParkingCheck] Multiple weak indicators (${weakMatchCount}): ${matchedIndicators.slice(0, 3).join(', ')}`);
    return { isParked: true, provider: detectParkingProvider(html, finalUrl) || undefined };
  }
  
  // If 1 weak indicator AND very short page (< 3000 chars HTML)
  if (weakMatchCount >= 1 && html.length < 3000) {
    console.log(`[ParkingCheck] Short page with indicator: ${matchedIndicators[0]}`);
    return { isParked: true, provider: detectParkingProvider(html, finalUrl) || undefined };
  }
  
  // Check for very empty pages (but only if no script tags — SPAs have scripts)
  const scriptCount = (lowerHtml.match(/<script[\s>]/g) || []).length;
  if (textContent.length < 50 && scriptCount < 2) {
    console.log(`[ParkingCheck] Very minimal text content: ${textContent.length} chars`);
    return { isParked: true, provider: 'Empty/Minimal' };
  }
  
  // Check for pages with minimal content and no real structure
  if (textContent.length < 200 && !hasMeaningfulContent && scriptCount < 2) {
    console.log(`[ParkingCheck] Minimal content without structure: ${textContent.length} chars`);
    return { isParked: true, provider: 'Minimal Content' };
  }
  
  // Check for suspiciously short pages with registrar mentions
  if (html.length < 10000 && scriptCount < 3) {
    const registrarMentions = ['godaddy', 'namecheap', 'hostinger', 'bluehost', 'hostgator', 
      'dreamhost', 'ionos', '1and1', 'sedo', 'afternic', 'hugedomains', 'dan.com'];
    for (const reg of registrarMentions) {
      if (lowerHtml.includes(reg) && !hasMeaningfulContent) {
        console.log(`[ParkingCheck] Short page with registrar mention: ${reg}`);
        return { isParked: true, provider: detectParkingProvider(html, finalUrl) || undefined };
      }
    }
  }
  
  return { isParked: false };
}

/**
 * Quick check if a domain is reachable (live) or parked/reserved.
 * Simplified and more robust version.
 */
export async function checkDomainLive(domainInput: string): Promise<DomainStatusResult> {
  const raw = String(domainInput || '').trim();
  if (!raw) return { isLive: false, isParked: false, error: 'Domain is required' };

  // Normalize URL
  let urlStr = raw.includes('://') ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { isLive: false, isParked: false, error: 'Only http/https domains are supported' };
    }
  } catch {
    return { isLive: false, isParked: false, error: 'Invalid URL' };
  }

  const startTime = Date.now();
  
  // Simple browser-like headers
  const browserHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
  };

  // Try HTTPS first, then HTTP if it fails
  const urlsToTry = [url.toString()];
  if (url.protocol === 'https:') {
    const httpUrl = new URL(url.toString());
    httpUrl.protocol = 'http:';
    urlsToTry.push(httpUrl.toString());
  }

  let lastError = '';

  for (const tryUrl of urlsToTry) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      console.log(`[DomainCheck] Checking: ${tryUrl}`);
      
      const res = await fetch(tryUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: browserHeaders,
        redirect: 'follow'
      });

      clearTimeout(timeout);
      const responseTime = Date.now() - startTime;
      const finalUrl = res.url;
      
      console.log(`[DomainCheck] Got response: ${res.status} from ${finalUrl} in ${responseTime}ms`);
      
      // ANY response from server means the domain is reachable
      // Only check for parking if we got HTML content
      
      if (res.status >= 500) {
        // Server error - still "exists" but having issues
        return { isLive: true, isParked: false, statusCode: res.status, responseTime, error: `Server returned ${res.status}` };
      }
      
      // For non-HTML responses, just mark as live
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/html')) {
        return { isLive: true, isParked: false, statusCode: res.status, responseTime };
      }
      
      // Read response body for parking check (limit to 100KB)
      let html = '';
      try {
        const reader = res.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          const maxBytes = 100000;
          
          while (totalBytes < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.byteLength;
              chunks.push(value);
            }
          }
          reader.cancel().catch(() => {});
          html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
        }
      } catch (readErr) {
        // Can't read body but server responded - it's live
        console.log(`[DomainCheck] Could not read body, but server responded - marking as live`);
        return { isLive: true, isParked: false, statusCode: res.status, responseTime };
      }
      
      // Check if parked
      const parkingCheck = isParkedContent(html, finalUrl);
      
      return { 
        isLive: !parkingCheck.isParked, 
        isParked: parkingCheck.isParked, 
        parkingProvider: parkingCheck.provider,
        statusCode: res.status, 
        responseTime 
      };

    } catch (e: any) {
      clearTimeout(timeout);
      lastError = e?.message || e?.name || 'Unknown error';
      console.log(`[DomainCheck] Error for ${tryUrl}: ${lastError}`);
      
      // If HTTPS failed and we have HTTP to try, continue
      if (tryUrl.startsWith('https://') && urlsToTry.indexOf(tryUrl) < urlsToTry.length - 1) {
        console.log(`[DomainCheck] HTTPS failed, trying HTTP...`);
        continue;
      }
    }
  }

  // All attempts failed
  const responseTime = Date.now() - startTime;
  const isTimeout = lastError.includes('abort') || lastError.includes('timeout');
  const isDNS = lastError.includes('ENOTFOUND') || lastError.includes('getaddrinfo');
  const isConnection = lastError.includes('ECONNREFUSED') || lastError.includes('ETIMEDOUT') || lastError.includes('ECONNRESET');
  
  console.log(`[DomainCheck] All attempts failed for ${url.hostname}: ${lastError}`);
  
  return {
    isLive: false,
    isParked: false,
    responseTime,
    error: isDNS ? 'Domain not found (DNS)' :
           isTimeout ? 'Connection timed out' :
           isConnection ? 'Connection refused' :
           lastError
  };
}

function detectTechnologies(htmlPages: string[], allLinks: string[]): DetectedTechnology[] {
  const found = new Map<string, DetectedTechnology>();
  const add = (t: DetectedTechnology) => {
    const existing = found.get(t.name);
    if (!existing || (t.confidence === 'high' && existing.confidence !== 'high')) {
      if (t.version || !existing?.version) found.set(t.name, t);
      else found.set(t.name, { ...t, version: existing.version });
    }
  };

  const combined = htmlPages.join('\n');
  const lower = combined.toLowerCase();
  const linksStr = allLinks.join('\n').toLowerCase();

  // ── CMS Detection ──

  // WordPress
  if (lower.includes('wp-content/') || lower.includes('wp-includes/') || lower.includes('wp-json')) {
    const verMatch = combined.match(/<meta[^>]*name=["']generator["'][^>]*content=["']WordPress\s*([\d.]*)/i);
    add({ name: 'WordPress', category: 'cms', version: verMatch?.[1] || null, confidence: 'high', icon: '🔵' });
    if (lower.includes('woocommerce') || lower.includes('wc-blocks'))
      add({ name: 'WooCommerce', category: 'other', version: null, confidence: 'high', icon: '🛒' });
    if (lower.includes('elementor'))
      add({ name: 'Elementor', category: 'other', version: null, confidence: 'high', icon: '🎨' });
    if (lower.includes('yoast') || lower.includes('yoast-seo'))
      add({ name: 'Yoast SEO', category: 'other', version: null, confidence: 'medium', icon: '📊' });
    if (lower.includes('wp-content/plugins/contact-form-7') || lower.includes('wpcf7'))
      add({ name: 'Contact Form 7', category: 'other', version: null, confidence: 'medium', icon: '📝' });
    if (lower.includes('wpbakery') || lower.includes('js_composer'))
      add({ name: 'WPBakery', category: 'other', version: null, confidence: 'high', icon: '🏗️' });
    if (lower.includes('divi'))
      add({ name: 'Divi', category: 'other', version: null, confidence: 'medium', icon: '🎨' });
    const themeMatch = combined.match(/wp-content\/themes\/([\w-]+)/i);
    if (themeMatch)
      add({ name: `WP Theme: ${themeMatch[1]}`, category: 'other', version: null, confidence: 'high', icon: '🎭' });
  }

  // Joomla
  if (lower.includes('/media/jui/') || lower.includes('/components/com_') || lower.includes('joomla')) {
    const verMatch = combined.match(/<meta[^>]*name=["']generator["'][^>]*content=["']Joomla[!]?\s*([\d.]*)/i);
    add({ name: 'Joomla', category: 'cms', version: verMatch?.[1] || null, confidence: 'high', icon: '🟠' });
  }

  // Drupal
  if (lower.includes('drupal.settings') || lower.includes('/sites/default/files') || lower.includes('drupal.js')) {
    const verMatch = combined.match(/<meta[^>]*name=["']generator["'][^>]*content=["']Drupal\s*([\d.]*)/i);
    add({ name: 'Drupal', category: 'cms', version: verMatch?.[1] || null, confidence: 'high', icon: '💧' });
  }

  // ── Platforms ──

  if (lower.includes('cdn.shopify.com') || lower.includes('shopify.theme'))
    add({ name: 'Shopify', category: 'platform', version: null, confidence: 'high', icon: '🛍️' });
  if (lower.includes('static.wixstatic.com') || lower.includes('wix.com/'))
    add({ name: 'Wix', category: 'platform', version: null, confidence: 'high', icon: '🌐' });
  if (lower.includes('squarespace.com') || lower.includes('static1.squarespace'))
    add({ name: 'Squarespace', category: 'platform', version: null, confidence: 'high', icon: '⬛' });
  if (lower.includes('webflow.com') || lower.includes('assets.website-files.com'))
    add({ name: 'Webflow', category: 'platform', version: null, confidence: 'high', icon: '🔷' });

  // ── Frameworks ──

  // Next.js (check before generic React)
  if (lower.includes('__next_data__') || lower.includes('/_next/')) {
    const verMatch = combined.match(/next[/\\]?([\d.]+)/i);
    add({ name: 'Next.js', category: 'framework', version: verMatch?.[1] || null, confidence: 'high', icon: '▲' });
  }

  // Gatsby
  if (lower.includes('___gatsby') || lower.includes('gatsby-'))
    add({ name: 'Gatsby', category: 'framework', version: null, confidence: 'high', icon: '💜' });

  // React (generic)
  if (lower.includes('react-dom') || lower.includes('data-reactroot') || lower.includes('react.production') || lower.includes('react.development')) {
    const verMatch = combined.match(/react[.-](?:dom[.-])?([\d.]+)/i);
    add({ name: 'React', category: 'framework', version: verMatch?.[1] || null, confidence: 'high', icon: '⚛️' });
  } else if (lower.includes('react')) {
    add({ name: 'React', category: 'framework', version: null, confidence: 'medium', icon: '⚛️' });
  }

  // Nuxt.js (check before generic Vue)
  if (lower.includes('__nuxt') || lower.includes('/_nuxt/'))
    add({ name: 'Nuxt.js', category: 'framework', version: null, confidence: 'high', icon: '💚' });

  // Vue.js
  if (lower.includes('vue.js') || lower.includes('vue.min.js') || lower.includes('vue.global') || / data-v-[a-f0-9]/.test(lower))
    add({ name: 'Vue.js', category: 'framework', version: null, confidence: 'high', icon: '💚' });
  else if (lower.includes('vue'))
    add({ name: 'Vue.js', category: 'framework', version: null, confidence: 'low', icon: '💚' });

  // Angular
  if (lower.includes('ng-version') || lower.includes('angular.min.js') || lower.includes('angular.js')) {
    const verMatch = combined.match(/ng-version=["']([\d.]+)/i);
    add({ name: 'Angular', category: 'framework', version: verMatch?.[1] || null, confidence: 'high', icon: '🅰️' });
  }

  // Svelte / SvelteKit
  if (lower.includes('svelte') || lower.includes('__sveltekit'))
    add({ name: 'Svelte', category: 'framework', version: null, confidence: 'high', icon: '🟧' });

  // ── Libraries ──

  // jQuery
  if (lower.includes('jquery.min.js') || lower.includes('jquery.js') || lower.includes('jquery-')) {
    const verMatch = combined.match(/jquery[.-]?([\d.]+)/i);
    add({ name: 'jQuery', category: 'library', version: verMatch?.[1] || null, confidence: 'high', icon: '📘' });
  }

  // Bootstrap
  if (lower.includes('bootstrap.min.css') || lower.includes('bootstrap.css') || lower.includes('bootstrap.min.js') || lower.includes('bootstrap.bundle')) {
    const verMatch = combined.match(/bootstrap[.-/]?([\d.]+)/i);
    add({ name: 'Bootstrap', category: 'library', version: verMatch?.[1] || null, confidence: 'high', icon: '🟣' });
  }

  // Tailwind CSS
  if (lower.includes('tailwindcss') || lower.includes('tailwind.min.css'))
    add({ name: 'Tailwind CSS', category: 'library', version: null, confidence: 'high', icon: '🌊' });

  // Font Awesome
  if (lower.includes('font-awesome') || lower.includes('fontawesome'))
    add({ name: 'Font Awesome', category: 'library', version: null, confidence: 'high', icon: '🔤' });

  // GSAP
  if (lower.includes('gsap') || lower.includes('greensock'))
    add({ name: 'GSAP', category: 'library', version: null, confidence: 'high', icon: '🟩' });

  // AOS (Animate on Scroll)
  if (lower.includes('aos.css') || lower.includes('aos.js') || / data-aos=/.test(lower))
    add({ name: 'AOS', category: 'library', version: null, confidence: 'high', icon: '✨' });

  // Slick / Swiper
  if (lower.includes('slick.min.js') || lower.includes('slick-carousel'))
    add({ name: 'Slick Slider', category: 'library', version: null, confidence: 'high', icon: '🎠' });
  if (lower.includes('swiper.min.js') || lower.includes('swiper-bundle'))
    add({ name: 'Swiper', category: 'library', version: null, confidence: 'high', icon: '🎠' });

  // ── Analytics ──

  if (lower.includes('google-analytics.com') || lower.includes('googletagmanager.com') || lower.includes('gtag('))
    add({ name: 'Google Analytics', category: 'analytics', version: null, confidence: 'high', icon: '📈' });
  if (lower.includes('facebook.com/tr') || lower.includes('fbevents.js') || lower.includes('fbq('))
    add({ name: 'Meta Pixel', category: 'analytics', version: null, confidence: 'high', icon: '👤' });
  if (lower.includes('hotjar.com') || lower.includes('hotjar'))
    add({ name: 'Hotjar', category: 'analytics', version: null, confidence: 'high', icon: '🔥' });
  if (lower.includes('clarity.ms'))
    add({ name: 'Microsoft Clarity', category: 'analytics', version: null, confidence: 'high', icon: '🔍' });

  // ── Server / Language ──

  if (linksStr.includes('.php') || lower.includes('.php'))
    add({ name: 'PHP', category: 'language', version: null, confidence: 'medium', icon: '🐘' });
  if (lower.includes('.aspx') || lower.includes('__viewstate'))
    add({ name: 'ASP.NET', category: 'language', version: null, confidence: 'high', icon: '🔷' });

  // If no CMS/framework/platform detected, classify as static HTML
  const hasCmsOrFramework = Array.from(found.values()).some(t =>
    t.category === 'cms' || t.category === 'framework' || t.category === 'platform'
  );
  if (!hasCmsOrFramework)
    add({ name: 'Static HTML', category: 'framework', version: null, confidence: 'medium', icon: '📄' });

  return Array.from(found.values());
}

export async function scanDomain(domainInput: string, options: DomainScanOptions = {}): Promise<DomainScanResult> {
  const opts = { ...DEFAULTS, ...options };
  const start = normalizeStartUrl(domainInput);
  await assertPublicHost(start.hostname);

  const baseHost = start.hostname;
  const visited = new Set<string>();
  const pagesVisited: string[] = [];
  const internalLinks = new Set<string>();
  const externalLinks = new Set<string>();
  const imageUrls = new Set<string>();
  const errors: DomainScanError[] = [];
  const htmlSamples: string[] = [];

  const q: Array<{ url: string; depth: number }> = [{ url: start.toString(), depth: 0 }];
  const enqueue = (u: string, depth: number) => {
    if (visited.has(u)) return;
    if (visited.size + q.length >= opts.maxPages) return;
    q.push({ url: u, depth });
  };

  while (q.length > 0 && visited.size < opts.maxPages) {
    const { url, depth } = q.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    pagesVisited.push(url);

    try {
      const res = await safeFetch(url, { method: 'GET', headers: { 'User-Agent': opts.userAgent, Accept: 'text/html,*/*' }, timeoutMs: 15001 }, baseHost);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('text/html')) continue;
      const html = await readTextWithLimit(res, 2_000_000);
      if (htmlSamples.length < 3) htmlSamples.push(html);
      const extracted = extractUrlsFromHtml(html, url);

      for (const link of extracted.links) {
        try {
          const u = stripFragment(new URL(link));
          if (shouldSkipForCrawl(u)) continue;
          const internal = isInternalUrl(u, baseHost, opts.includeSubdomains);
          (internal ? internalLinks : externalLinks).add(u.toString());
          if (internal && depth < opts.maxDepth) {
            enqueue(u.toString(), depth + 1);
          }
        } catch {
          // ignore malformed
        }
      }

      for (const img of extracted.images) {
        try {
          const u = stripFragment(new URL(img));
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
          imageUrls.add(u.toString());
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      errors.push({ url, error: e?.name === 'AbortError' ? 'Timeout' : String(e?.message || e) });
    }
  }

  const imagesToCheck = Array.from(imageUrls).slice(0, opts.maxImages);
  const imagesMeta = await promisePool(
    imagesToCheck,
    8,
    async (imgUrl): Promise<DomainScanImage> => {
      const u = new URL(imgUrl);
      const internal = isInternalUrl(u, baseHost, opts.includeSubdomains);
      const meta = await fetchImageMeta(imgUrl, opts.userAgent);
      return { url: imgUrl, isInternal: internal, bytes: meta.bytes, contentType: meta.contentType };
    }
  );

  const allLinks = [...Array.from(internalLinks), ...Array.from(externalLinks)];
  const technologies = detectTechnologies(htmlSamples, allLinks);

  return {
    startUrl: start.toString(),
    baseHost,
    pagesScanned: visited.size,
    pagesVisited,
    internalLinks: Array.from(internalLinks).sort(),
    externalLinks: Array.from(externalLinks).sort(),
    images: imagesMeta.sort((a, b) => (b.bytes || 0) - (a.bytes || 0)),
    errors,
    technologies
  };
}

