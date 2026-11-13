'use strict';

/**
 * src/domain.js
 * ---------------------------------------------------------------------------
 * Root-domain extraction and normalization.
 *
 *   "HTTP://WWW.Example.com:8080/path?q=1#top"  -> "example.com"
 *   "https://shop.example.co.uk/en"             -> "example.co.uk"
 *   "jane@sales.example.com"                    -> "example.com"
 *   "acme.myshopify.com"                        -> "acme.myshopify.com"
 *
 * Zero dependencies and no require(): inlined into n8n Code nodes at build time.
 *
 * Public suffixes: the full Public Suffix List is large, so this module ships a
 * curated list of common multi-part suffixes (country second-level domains and
 * hosting platforms where each subdomain is a separate organisation). Add any
 * others you need with EXTRA_PUBLIC_SUFFIXES.
 *
 * DISCLAIMER & LIABILITY LIMITATION:
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE. THE USER ASSUMES FULL RESPONSIBILITY FOR CRM DATA INTEGRITY,
 * BACKUPS, API RATE LIMITS, AND COMPLIANCE WITH THIRD-PARTY TERMS OF SERVICE
 * WHEN EXECUTING AUTOMATED WORKFLOWS IN PRODUCTION ENVIRONMENTS.
 * ---------------------------------------------------------------------------
 */

/** Multi-label public suffixes (ccSLDs and hosting platforms). */
const MULTI_PART_SUFFIXES = Object.freeze([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'sch.uk',
  // Australia / New Zealand
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'org.nz', 'net.nz', 'ac.nz', 'govt.nz', 'school.nz',
  // Asia
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'ac.kr', 'go.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
  'com.my', 'org.my', 'net.my', 'edu.my', 'gov.my',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id',
  'co.th', 'or.th', 'ac.th', 'go.th', 'in.th',
  'com.ph', 'org.ph', 'net.ph', 'edu.ph', 'gov.ph',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in',
  'com.pk', 'org.pk', 'net.pk', 'edu.pk', 'gov.pk',
  'com.bd', 'org.bd', 'net.bd', 'edu.bd', 'gov.bd', 'ac.bd',
  'com.lk', 'org.lk', 'edu.lk', 'gov.lk',
  'com.np', 'org.np', 'edu.np', 'gov.np',
  // Middle East / Africa
  'co.il', 'org.il', 'ac.il', 'gov.il', 'net.il',
  'com.tr', 'org.tr', 'net.tr', 'edu.tr', 'gov.tr', 'gen.tr',
  'com.sa', 'org.sa', 'net.sa', 'edu.sa', 'gov.sa',
  'ae.org', 'co.ae', 'net.ae', 'org.ae', 'gov.ae', 'ac.ae',
  'com.eg', 'org.eg', 'net.eg', 'edu.eg', 'gov.eg',
  'co.za', 'org.za', 'net.za', 'ac.za', 'gov.za', 'web.za',
  'co.ke', 'or.ke', 'ac.ke', 'go.ke', 'ne.ke',
  'com.ng', 'org.ng', 'net.ng', 'edu.ng', 'gov.ng',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'blog.br', 'eco.br', 'ind.br',
  'com.mx', 'org.mx', 'net.mx', 'edu.mx', 'gob.mx',
  'com.ar', 'org.ar', 'net.ar', 'gob.ar', 'edu.ar',
  'com.co', 'org.co', 'net.co', 'edu.co', 'gov.co',
  'com.pe', 'org.pe', 'net.pe', 'edu.pe', 'gob.pe',
  'co.ve', 'com.ve', 'org.ve',
  'gob.cl',
  // Europe
  'com.pl', 'net.pl', 'org.pl', 'edu.pl', 'gov.pl',
  'com.es', 'org.es', 'nom.es', 'edu.es', 'gob.es',
  'com.pt', 'org.pt', 'edu.pt', 'gov.pt',
  'co.at', 'or.at', 'ac.at', 'gv.at',
  'com.gr', 'org.gr', 'net.gr', 'edu.gr', 'gov.gr',
  'com.ua', 'org.ua', 'net.ua', 'edu.ua', 'gov.ua',
  'com.ru', 'org.ru', 'net.ru',
  'co.hu', 'org.hu',
  'com.cy', 'org.cy', 'ac.cy', 'gov.cy',
  'com.mt', 'org.mt', 'edu.mt', 'gov.mt',
  'co.je', 'co.gg', 'co.im',
  'eu.com', 'uk.com', 'us.com', 'gb.com', 'de.com', 'jpn.com', 'za.com',
  // Hosting platforms (each subdomain is an independent site / organisation)
  'github.io', 'gitlab.io', 'herokuapp.com', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'fly.dev',
  'onrender.com', 'glitch.me', 'repl.co', 'myshopify.com', 'wixsite.com', 'squarespace.com',
  'blogspot.com', 'wordpress.com', 'webflow.io', 'carrd.co', 'bubbleapps.io', 'framer.website',
  'hubspotpagebuilder.com', 'hs-sites.com', 'notion.site', 'substack.com', 'weebly.com',
]);

/**
 * Free / personal mailbox and generic platform domains. A company record whose
 * domain is one of these cannot be meaningfully enriched, so it is skipped.
 */
const BLOCKED_ROOT_DOMAINS = Object.freeze([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
  'tutanota.com', 'fastmail.com', 'hey.com', 'inbox.com', 'comcast.net', 'verizon.net', 'att.net',
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'google.com',
  'bit.ly', 'linktr.ee',
]);

const REASONS = Object.freeze({
  EMPTY: 'EMPTY',
  NOT_A_STRING: 'NOT_A_STRING',
  IP_ADDRESS: 'IP_ADDRESS',
  SINGLE_LABEL: 'SINGLE_LABEL',
  INVALID_HOSTNAME: 'INVALID_HOSTNAME',
  INVALID_TLD: 'INVALID_TLD',
  PUBLIC_SUFFIX_ONLY: 'PUBLIC_SUFFIX_ONLY',
  BLOCKED_DOMAIN: 'BLOCKED_DOMAIN',
});

const MAX_INPUT_LENGTH = 2048;
const LABEL_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const TLD_PATTERN = /^(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/u;

function fail(input, reason, hostname) {
  return { ok: false, input, hostname: hostname || null, rootDomain: null, reason };
}

/**
 * Reduce any URL, hostname or email address to a lowercase hostname.
 * Returns '' when nothing usable remains.
 */
function extractHostname(value) {
  let s = String(value).trim().slice(0, MAX_INPUT_LENGTH);
  if (!s) return '';

  // Bare email address (no scheme): keep the part after the last "@".
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[^\s/@]+@[^\s/@]+$/.test(s)) {
    s = s.slice(s.lastIndexOf('@') + 1);
  }
  s = s.replace(/^mailto:/i, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  s = s.replace(/^\/\//, ''); // protocol-relative
  s = s.split(/[/?#\\\s]/)[0]; // cut path, query, fragment
  if (s.indexOf('@') !== -1) s = s.slice(s.lastIndexOf('@') + 1); // userinfo
  if (s.charAt(0) === '[') return s.toLowerCase(); // IPv6 literal: reported as IP below
  s = s.replace(/:\d*$/, ''); // port
  s = s.toLowerCase().replace(/\.+$/, '').replace(/^\.+/, ''); // trailing / leading dots
  s = s.replace(/^www\d*\./, ''); // www., www2.
  return s;
}

/** Build the suffix set used for root-domain detection. */
function buildSuffixSet(extraSuffixes) {
  const set = {};
  MULTI_PART_SUFFIXES.forEach((s) => (set[s] = true));
  (extraSuffixes || []).forEach((s) => (set[String(s).toLowerCase()] = true));
  return set;
}

/**
 * Normalize an input to its registrable root domain.
 * @param {*} input URL, hostname or email address.
 * @param {{ extraSuffixes?: string[], extraBlocked?: string[], allowBlocked?: boolean }} [options]
 * @returns {{ ok: boolean, input: *, hostname: string|null, rootDomain: string|null, reason: string|null }}
 */
function normalizeDomain(input, options) {
  const opts = options || {};
  if (input === null || input === undefined) return fail(input, REASONS.EMPTY);
  if (typeof input !== 'string' && typeof input !== 'number') return fail(input, REASONS.NOT_A_STRING);

  const hostname = extractHostname(input);
  if (!hostname) return fail(input, REASONS.EMPTY);
  if (hostname.charAt(0) === '[' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return fail(input, REASONS.IP_ADDRESS, hostname);

  const labels = hostname.split('.');
  if (labels.length < 2) return fail(input, REASONS.SINGLE_LABEL, hostname);
  if (hostname.length > 253 || labels.some((l) => !LABEL_PATTERN.test(l))) return fail(input, REASONS.INVALID_HOSTNAME, hostname);
  if (!TLD_PATTERN.test(labels[labels.length - 1])) return fail(input, REASONS.INVALID_TLD, hostname);

  // Longest matching multi-part suffix wins; otherwise the TLD is the suffix.
  const suffixes = buildSuffixSet(opts.extraSuffixes);
  let suffixLabels = 1;
  for (let n = labels.length; n >= 2; n -= 1) {
    if (suffixes[labels.slice(labels.length - n).join('.')]) {
      suffixLabels = n;
      break;
    }
  }
  if (labels.length <= suffixLabels) return fail(input, REASONS.PUBLIC_SUFFIX_ONLY, hostname);

  const rootDomain = labels.slice(labels.length - suffixLabels - 1).join('.');
  if (!opts.allowBlocked && isBlockedDomain(rootDomain, opts.extraBlocked)) {
    return { ok: false, input, hostname, rootDomain, reason: REASONS.BLOCKED_DOMAIN };
  }
  return { ok: true, input, hostname, rootDomain, reason: null };
}

/** True when a root domain is a personal mailbox / generic platform domain. */
function isBlockedDomain(rootDomain, extraBlocked) {
  const d = String(rootDomain || '').toLowerCase();
  return BLOCKED_ROOT_DOMAINS.indexOf(d) !== -1 || (extraBlocked || []).indexOf(d) !== -1;
}

/**
 * Pick the best root domain from a HubSpot company's properties.
 * Order: domain, website, then each entry of hs_additional_domains.
 * Returns the first valid result, or the first failure (for the skip reason).
 */
function pickCompanyDomain(properties, options) {
  const props = properties && typeof properties === 'object' ? properties : {};
  const candidates = [
    { field: 'domain', value: props.domain },
    { field: 'website', value: props.website },
  ];
  String(props.hs_additional_domains || '')
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .forEach((value) => candidates.push({ field: 'hs_additional_domains', value }));

  let firstFailure = null;
  for (const candidate of candidates) {
    if (candidate.value === undefined || candidate.value === null || String(candidate.value).trim() === '') continue;
    const result = normalizeDomain(candidate.value, options);
    if (result.ok) return Object.assign({ field: candidate.field }, result);
    if (!firstFailure) firstFailure = Object.assign({ field: candidate.field }, result);
  }
  return firstFailure || Object.assign({ field: null }, fail(null, REASONS.EMPTY));
}

/** Mask a domain for logs when LOG_DOMAINS=false: "example.co.uk" -> "ex*****.co.uk". */
function maskDomain(domain) {
  const d = String(domain || '');
  const dot = d.indexOf('.');
  if (dot <= 0) return d ? '***' : '';
  const name = d.slice(0, dot);
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(3, name.length - 2))}${d.slice(dot)}`;
}

module.exports = {
  MULTI_PART_SUFFIXES,
  BLOCKED_ROOT_DOMAINS,
  REASONS,
  extractHostname,
  normalizeDomain,
  isBlockedDomain,
  pickCompanyDomain,
  maskDomain,
};
