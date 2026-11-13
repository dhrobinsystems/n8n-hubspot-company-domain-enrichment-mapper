'use strict';

/**
 * src/mapper.js
 * ---------------------------------------------------------------------------
 * Maps a company-metadata API response onto HubSpot company properties.
 *
 *   enrichment response ──► classifyEnrichmentResponse()   FOUND / NOT_FOUND / RATE_LIMITED / ERROR_*
 *                     │
 *                     ├──► mapIndustry()          raw text -> HubSpot `industry` option
 *                     ├──► parseEmployeeCount()   "51-200", "1.2k", "1,000+" -> integer
 *                     ├──► normalizeTechStack()   strings / objects -> sorted, de-duplicated list
 *                     ▼
 *              buildCompanyUpdate()  ──► { properties, changes, preserved, status, hasUpdate }
 *
 * CRM integrity rules
 *   - Existing values are preserved unless OVERWRITE_EXISTING=true.
 *   - An industry the mapper cannot translate is stored only in the raw text
 *     property; the HubSpot `industry` dropdown is never given an invalid option.
 *   - Status properties (enrichment_status, enrichment_last_run_at, ...) are
 *     always written so failures are visible and retryable from HubSpot views.
 *
 * Zero dependencies and no require(): inlined into n8n Code nodes at build time.
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

const MAPPER_VERSION = '1.0.0';
const MAX_EMPLOYEES = 10000000;
const TECH_ITEM_MAX_CHARS = 80;
const RAW_INDUSTRY_MAX_CHARS = 200;
const HUBSPOT_TEXT_MAX_CHARS = 65000;

/** Final status written to the enrichment_status property. */
const STATUS = Object.freeze({
  ENRICHED: 'ENRICHED',
  PARTIAL: 'PARTIAL',
  NO_CHANGES: 'NO_CHANGES',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  ERROR_AUTH: 'ERROR_AUTH',
  ERROR_PROVIDER: 'ERROR_PROVIDER',
  ERROR_HUBSPOT_FETCH: 'ERROR_HUBSPOT_FETCH',
  ERROR_INTERNAL: 'ERROR_INTERNAL',
  SKIPPED_NO_DOMAIN: 'SKIPPED_NO_DOMAIN',
  SKIPPED_INVALID_DOMAIN: 'SKIPPED_INVALID_DOMAIN',
  SKIPPED_BLOCKED_DOMAIN: 'SKIPPED_BLOCKED_DOMAIN',
  SKIPPED_ALREADY_ENRICHED: 'SKIPPED_ALREADY_ENRICHED',
  SKIPPED_NO_PROVIDER: 'SKIPPED_NO_PROVIDER',
});

/** Outcomes that must never write to the company record. */
const NO_WRITE_STATUSES = Object.freeze([STATUS.ERROR_HUBSPOT_FETCH, STATUS.SKIPPED_ALREADY_ENRICHED]);

/**
 * Raw industry text (lowercase, punctuation collapsed) -> HubSpot `industry` option.
 * Covers common provider vocabularies. Extend or override with INDUSTRY_MAP_JSON.
 * Verify the option values against your portal (Settings -> Properties -> Industry).
 */
const INDUSTRY_SYNONYMS = Object.freeze({
  'software': 'COMPUTER_SOFTWARE',
  'computer software': 'COMPUTER_SOFTWARE',
  'saas': 'COMPUTER_SOFTWARE',
  'software development': 'COMPUTER_SOFTWARE',
  'enterprise software': 'COMPUTER_SOFTWARE',
  'information technology': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'information technology and services': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'it services': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'it services and it consulting': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'internet': 'INTERNET',
  'technology information and internet': 'INTERNET',
  'computer hardware': 'COMPUTER_HARDWARE',
  'hardware': 'COMPUTER_HARDWARE',
  'computer and network security': 'COMPUTER_NETWORK_SECURITY',
  'cybersecurity': 'COMPUTER_NETWORK_SECURITY',
  'computer networking': 'COMPUTER_NETWORKING',
  'semiconductors': 'SEMICONDUCTORS',
  'telecommunications': 'TELECOMMUNICATIONS',
  'financial services': 'FINANCIAL_SERVICES',
  'fintech': 'FINANCIAL_SERVICES',
  'banking': 'BANKING',
  'insurance': 'INSURANCE',
  'investment management': 'INVESTMENT_MANAGEMENT',
  'venture capital and private equity': 'VENTURE_CAPITAL_PRIVATE_EQUITY',
  'accounting': 'ACCOUNTING',
  'hospital and health care': 'HOSPITAL_HEALTH_CARE',
  'hospitals and health care': 'HOSPITAL_HEALTH_CARE',
  'healthcare': 'HOSPITAL_HEALTH_CARE',
  'health care': 'HOSPITAL_HEALTH_CARE',
  'medical devices': 'MEDICAL_DEVICES',
  'pharmaceuticals': 'PHARMACEUTICALS',
  'biotechnology': 'BIOTECHNOLOGY',
  'marketing and advertising': 'MARKETING_AND_ADVERTISING',
  'advertising services': 'MARKETING_AND_ADVERTISING',
  'marketing': 'MARKETING_AND_ADVERTISING',
  'retail': 'RETAIL',
  'e commerce': 'INTERNET',
  'ecommerce': 'INTERNET',
  'consumer goods': 'CONSUMER_GOODS',
  'food and beverages': 'FOOD_BEVERAGES',
  'restaurants': 'RESTAURANTS',
  'hospitality': 'HOSPITALITY',
  'real estate': 'REAL_ESTATE',
  'construction': 'CONSTRUCTION',
  'architecture and planning': 'ARCHITECTURE_PLANNING',
  'education': 'EDUCATION_MANAGEMENT',
  'education management': 'EDUCATION_MANAGEMENT',
  'higher education': 'HIGHER_EDUCATION',
  'e learning': 'E_LEARNING',
  'elearning': 'E_LEARNING',
  'management consulting': 'MANAGEMENT_CONSULTING',
  'business consulting and services': 'MANAGEMENT_CONSULTING',
  'consulting': 'MANAGEMENT_CONSULTING',
  'legal services': 'LEGAL_SERVICES',
  'law practice': 'LAW_PRACTICE',
  'staffing and recruiting': 'STAFFING_AND_RECRUITING',
  'human resources': 'HUMAN_RESOURCES',
  'logistics and supply chain': 'LOGISTICS_AND_SUPPLY_CHAIN',
  'transportation trucking railroad': 'TRANSPORTATION_TRUCKING_RAILROAD',
  'airlines aviation': 'AIRLINES_AVIATION',
  'automotive': 'AUTOMOTIVE',
  'machinery': 'MACHINERY',
  'industrial automation': 'INDUSTRIAL_AUTOMATION',
  'manufacturing': 'MECHANICAL_OR_INDUSTRIAL_ENGINEERING',
  'oil and energy': 'OIL_ENERGY',
  'renewables and environment': 'RENEWABLES_ENVIRONMENT',
  'utilities': 'UTILITIES',
  'nonprofit organization management': 'NONPROFIT_ORGANIZATION_MANAGEMENT',
  'non profit': 'NONPROFIT_ORGANIZATION_MANAGEMENT',
  'nonprofit': 'NONPROFIT_ORGANIZATION_MANAGEMENT',
  'government administration': 'GOVERNMENT_ADMINISTRATION',
  'entertainment': 'ENTERTAINMENT',
  'media production': 'MEDIA_PRODUCTION',
  'online media': 'ONLINE_MEDIA',
  'publishing': 'PUBLISHING',
  'computer games': 'COMPUTER_GAMES',
  'design': 'DESIGN',
  'research': 'RESEARCH',
});

/** Keyword fallbacks, checked in order, when there is no exact synonym. */
const INDUSTRY_KEYWORDS = Object.freeze([
  ['security', 'COMPUTER_NETWORK_SECURITY'],
  ['software', 'COMPUTER_SOFTWARE'],
  ['saas', 'COMPUTER_SOFTWARE'],
  ['fintech', 'FINANCIAL_SERVICES'],
  ['bank', 'BANKING'],
  ['insur', 'INSURANCE'],
  ['pharma', 'PHARMACEUTICALS'],
  ['biotech', 'BIOTECHNOLOGY'],
  ['health', 'HOSPITAL_HEALTH_CARE'],
  ['medical', 'MEDICAL_DEVICES'],
  ['marketing', 'MARKETING_AND_ADVERTISING'],
  ['advertis', 'MARKETING_AND_ADVERTISING'],
  ['real estate', 'REAL_ESTATE'],
  ['logistic', 'LOGISTICS_AND_SUPPLY_CHAIN'],
  ['telecom', 'TELECOMMUNICATIONS'],
  ['education', 'EDUCATION_MANAGEMENT'],
  ['recruit', 'STAFFING_AND_RECRUITING'],
  ['staffing', 'STAFFING_AND_RECRUITING'],
  ['consult', 'MANAGEMENT_CONSULTING'],
  ['retail', 'RETAIL'],
  ['information technology', 'INFORMATION_TECHNOLOGY_AND_SERVICES'],
]);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyValue(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/** Read the first non-empty value from "a.b|c|d.e" style alternative paths. */
function getPath(obj, pathSpec) {
  const alternatives = Array.isArray(pathSpec) ? pathSpec : String(pathSpec || '').split('|');
  for (const path of alternatives) {
    const parts = String(path).trim().split('.').filter(Boolean);
    let cursor = obj;
    for (const part of parts) {
      if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = cursor[part];
    }
    if (!isEmptyValue(cursor) && !(Array.isArray(cursor) && cursor.length === 0)) return cursor;
  }
  return undefined;
}

function cleanText(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function industryKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Field mappers
// ---------------------------------------------------------------------------

/**
 * Translate raw industry text to a HubSpot industry option.
 * @returns {{ option: string|null, raw: string|null, method: 'CUSTOM_MAP'|'EXACT'|'ALREADY_OPTION'|'KEYWORD'|'UNMAPPED'|'EMPTY' }}
 */
function mapIndustry(rawValue, customMap) {
  const raw = Array.isArray(rawValue) ? rawValue.filter(Boolean)[0] : rawValue;
  const text = cleanText(isPlainObject(raw) ? raw.name || raw.label || '' : raw, RAW_INDUSTRY_MAX_CHARS);
  if (!text) return { option: null, raw: null, method: 'EMPTY' };

  const key = industryKey(text);
  const custom = customMap || {};
  if (custom[text.toLowerCase()]) return { option: custom[text.toLowerCase()], raw: text, method: 'CUSTOM_MAP' };
  if (custom[key]) return { option: custom[key], raw: text, method: 'CUSTOM_MAP' };
  if (INDUSTRY_SYNONYMS[key]) return { option: INDUSTRY_SYNONYMS[key], raw: text, method: 'EXACT' };

  const knownOptions = Object.keys(INDUSTRY_SYNONYMS).map((k) => INDUSTRY_SYNONYMS[k]);
  if (/^[A-Z0-9_]+$/.test(text) && knownOptions.indexOf(text) !== -1) return { option: text, raw: text, method: 'ALREADY_OPTION' };

  for (const pair of INDUSTRY_KEYWORDS) {
    if (key.indexOf(pair[0]) !== -1) return { option: pair[1], raw: text, method: 'KEYWORD' };
  }
  return { option: null, raw: text, method: 'UNMAPPED' };
}

/**
 * Parse an employee count from numbers or common provider formats.
 *   250 | "250" | "1,200" | "1.2k" | "10K+" | "51-200" | "51 to 200" | "1000+" | { min, max }
 * @param {'lower'|'midpoint'|'upper'} strategy How ranges are reduced to one number.
 * @returns {number|null}
 */
function parseEmployeeCount(value, strategy) {
  if (isEmptyValue(value)) return null;
  const mode = strategy || 'midpoint';

  const pick = (low, high) => {
    if (high === null || high === undefined) return low;
    if (mode === 'lower') return low;
    if (mode === 'upper') return high;
    return Math.round((low + high) / 2);
  };
  const toNumber = (token) => {
    const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(String(token).replace(/[,\s_]/g, ''));
    if (!m) return null;
    const multiplier = m[2] ? (m[2].toLowerCase() === 'k' ? 1000 : 1000000) : 1;
    return Math.round(Number(m[1]) * multiplier);
  };
  const valid = (n) => (Number.isFinite(n) && n > 0 && n <= MAX_EMPLOYEES ? Math.round(n) : null);

  if (typeof value === 'number') return valid(value);
  if (isPlainObject(value)) {
    const low = toNumber(value.min !== undefined ? value.min : value.from);
    const high = toNumber(value.max !== undefined ? value.max : value.to);
    if (low === null && high === null) return null;
    return valid(pick(low !== null ? low : high, high));
  }

  const text = String(value).trim().toLowerCase();
  const range = /^(\d[\d,.\s]*[km]?)\s*(?:-|–|to)\s*(\d[\d,.\s]*[km]?)/.exec(text);
  if (range) {
    const low = toNumber(range[1]);
    const high = toNumber(range[2]);
    if (low === null || high === null || high < low) return null;
    return valid(pick(low, high));
  }
  const single = /^(\d[\d,.\s]*[km]?)\s*\+?/.exec(text);
  return single ? valid(toNumber(single[1])) : null;
}

/** Normalize technologies (strings, {name}, {title}, nested categories) to a clean, sorted list. */
function normalizeTechStack(value, maxItems) {
  const limit = maxItems || 50;
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(/[;,|\n]/);
  else if (isPlainObject(value)) {
    // { "Analytics": ["X", "Y"], "CRM": ["Z"] }
    Object.keys(value).forEach((k) => (list = list.concat(Array.isArray(value[k]) ? value[k] : [value[k]])));
  }

  const seen = {};
  const out = [];
  list.forEach((entry) => {
    const name = cleanText(isPlainObject(entry) ? entry.name || entry.title || entry.technology || '' : entry, TECH_ITEM_MAX_CHARS);
    const key = name.toLowerCase();
    if (!name || seen[key]) return;
    seen[key] = true;
    out.push(name);
  });
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

function errorStatusCode(error) {
  const err = isPlainObject(error) ? error : {};
  const status = Number(err.httpCode || err.statusCode || err.status || (err.cause && err.cause.status));
  if (Number.isFinite(status) && status > 0) return status;
  const m = /status code (\d{3})/i.exec(String(err.message || error || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Classify an enrichment API result (an n8n item JSON, possibly an error item).
 * @returns {{ outcome: string, data: object|null, httpStatus: number|null, message: string|null }}
 */
function classifyEnrichmentResponse(json, config) {
  if (json === null || json === undefined) return { outcome: STATUS.NOT_FOUND, data: null, httpStatus: null, message: 'Empty response' };
  if (!isPlainObject(json)) return { outcome: STATUS.ERROR_PROVIDER, data: null, httpStatus: null, message: 'Response is not a JSON object' };

  if (json.error) {
    const httpStatus = errorStatusCode(json.error);
    const message = cleanText(isPlainObject(json.error) ? json.error.message || json.error.description : json.error, 200) || 'Request failed';
    let outcome = STATUS.ERROR_PROVIDER;
    if (httpStatus === 404 || httpStatus === 422) outcome = STATUS.NOT_FOUND;
    else if (httpStatus === 429 || /rate.?limit|too many requests/i.test(message)) outcome = STATUS.RATE_LIMITED;
    else if (httpStatus === 401 || httpStatus === 403) outcome = STATUS.ERROR_AUTH;
    return { outcome, data: null, httpStatus, message };
  }

  const root = config && config.enrichment && config.enrichment.responseRoot;
  let data = root ? getPath(json, root) : json;
  if (!root && isPlainObject(json.data) && Object.keys(json).every((k) => ['data', 'meta', 'status', 'success', 'request_id'].indexOf(k) !== -1)) {
    data = json.data; // common { data: {...}, meta: {...} } envelope
  }
  if (Array.isArray(data)) data = data[0];
  if (!isPlainObject(data) || Object.keys(data).length === 0 || data.found === false || data.status === 'not_found') {
    return { outcome: STATUS.NOT_FOUND, data: null, httpStatus: 200, message: 'No company data returned' };
  }
  return { outcome: 'FOUND', data, httpStatus: 200, message: null };
}

// ---------------------------------------------------------------------------
// HubSpot update builder
// ---------------------------------------------------------------------------

/** Properties to request from GET /crm/v3/objects/companies/{id}. */
function companyPropertiesToFetch(config) {
  const p = config.hubspot.props;
  const list = ['name', 'domain', 'website', 'hs_additional_domains', 'industry', 'numberofemployees', p.techStack, p.industryRaw, p.status, p.lastRun, p.rootDomain, p.source];
  return list.filter((v, i) => list.indexOf(v) === i);
}

/**
 * Build the HubSpot PATCH properties for one company.
 *
 * @param {object} context Output of the "Extract Root Domain" stage:
 *        { companyId, rootDomain, currentProperties, skipStatus? }
 * @param {object|null} enrichmentJson Enrichment API item JSON (null when skipped).
 * @param {object} config From loadConfig().
 * @param {Date} now
 */
function buildCompanyUpdate(context, enrichmentJson, config, now) {
  const ctx = isPlainObject(context) ? context : {};
  const current = isPlainObject(ctx.currentProperties) ? ctx.currentProperties : {};
  const props = config.hubspot.props;
  const at = now && typeof now.toISOString === 'function' ? now : new Date();
  const properties = {};
  const changes = [];
  const preserved = [];

  /** Set a property if allowed by the overwrite policy and if it actually changes. */
  const setField = (name, value, alwaysWrite) => {
    if (isEmptyValue(value)) return;
    const next = String(value);
    const prev = isEmptyValue(current[name]) ? '' : String(current[name]);
    if (prev === next) return;
    if (prev && !alwaysWrite && !config.mapping.overwriteExisting) {
      preserved.push({ property: name, reason: 'EXISTING_VALUE_PRESERVED' });
      return;
    }
    properties[name] = next;
    changes.push({ property: name, from: prev || null, to: next });
  };

  let status;
  let mapped = { industry: null, industryMethod: null, employees: null, techCount: 0 };
  let message = null;
  let httpStatus = null;

  if (ctx.skipStatus) {
    status = ctx.skipStatus;
    message = ctx.skipReason || null;
  } else {
    const result = classifyEnrichmentResponse(enrichmentJson, config);
    httpStatus = result.httpStatus;
    message = result.message;
    if (result.outcome !== 'FOUND') {
      status = result.outcome;
    } else {
      const paths = config.enrichment.paths;
      const industry = mapIndustry(getPath(result.data, paths.industry), config.mapping.industryMap);
      const employees = parseEmployeeCount(
        getPath(result.data, paths.employees) !== undefined ? getPath(result.data, paths.employees) : getPath(result.data, paths.employeeRange),
        config.enrichment.employeeRangeStrategy
      );
      const tech = normalizeTechStack(getPath(result.data, paths.tech), config.enrichment.techStackMax);

      if (industry.option) setField('industry', industry.option);
      if (industry.raw) setField(props.industryRaw, industry.raw);
      if (employees !== null) setField('numberofemployees', employees);
      if (tech.length > 0) setField(props.techStack, tech.join('; ').slice(0, HUBSPOT_TEXT_MAX_CHARS));

      mapped = { industry: industry.option, industryMethod: industry.method, employees, techCount: tech.length };
      const found = [industry.raw, employees, tech.length > 0 ? tech : null].filter((v) => v !== null && v !== undefined).length;
      if (found === 0) status = STATUS.NOT_FOUND;
      else if (changes.length === 0) status = STATUS.NO_CHANGES;
      else status = found === 3 && industry.option ? STATUS.ENRICHED : STATUS.PARTIAL;
    }
  }

  // Normalized domain and bookkeeping properties.
  if (ctx.rootDomain && NO_WRITE_STATUSES.indexOf(status) === -1) {
    if (config.mapping.writeNormalizedDomain && isEmptyValue(current.domain)) setField('domain', ctx.rootDomain);
    setField(props.rootDomain, ctx.rootDomain, true);
  }
  // No writes at all when the record could not be read, or is already enriched
  // (overwriting ENRICHED with a skip status would trigger re-enrichment later).
  const canWriteStatus = NO_WRITE_STATUSES.indexOf(status) === -1;
  if (canWriteStatus) {
    setField(props.status, status, true);
    properties[props.lastRun] = at.toISOString();
    if (!ctx.skipStatus) setField(props.source, config.enrichment.providerName, true);
  }

  return {
    kind: 'company_update',
    companyId: ctx.companyId ? String(ctx.companyId) : null,
    rootDomain: ctx.rootDomain || null,
    status,
    httpStatus,
    message,
    mapped,
    properties: canWriteStatus && ctx.companyId ? properties : {},
    changes,
    preserved,
    hasUpdate: Boolean(canWriteStatus && ctx.companyId && Object.keys(properties).length > 0),
    sandbox: Boolean(config.sandboxMode),
    mapperVersion: MAPPER_VERSION,
  };
}

module.exports = {
  MAPPER_VERSION,
  STATUS,
  NO_WRITE_STATUSES,
  INDUSTRY_SYNONYMS,
  getPath,
  mapIndustry,
  parseEmployeeCount,
  normalizeTechStack,
  classifyEnrichmentResponse,
  companyPropertiesToFetch,
  buildCompanyUpdate,
};
