'use strict';

/**
 * config.validator.js
 * ---------------------------------------------------------------------------
 * Configuration parser and fail-fast validator for the
 * n8n-hubspot-company-domain-enrichment-mapper.
 *
 * Two ways to use it:
 *   1. Pre-flight CLI (before deploying or in CI):
 *        node config.validator.js                      # validate process.env
 *        node config.validator.js --env-path .env      # validate a .env file
 *   2. Inlined into the n8n Code nodes by scripts/build-workflow.js, where
 *      loadConfig($env) runs before every execution.
 *
 * Rules
 *   - Zero dependencies. Everything above the CLI marker contains no require()
 *     calls, because n8n Code nodes usually cannot load modules.
 *   - All problems are collected and thrown together in one ConfigError.
 *   - Values like {{ENRICHMENT_API_BASE_URL}}, YOUR_..., your-... and REPLACE_...
 *     are placeholders and count as "not set".
 *   - API keys and tokens are NOT read here. They live in the n8n credential
 *     store (HubSpot App Token, Header Auth). WEBHOOK_SECRET is the only secret
 *     read from the environment, and it is never returned in any output.
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

/** Every environment key the router reads (also used to copy n8n's $env safely). */
const ENV_KEYS = Object.freeze([
  'SANDBOX_MODE',
  // Inbound events
  'WEBHOOK_SECRET',
  'WEBHOOK_SECRET_HEADER',
  'REQUIRE_WEBHOOK_SECRET',
  'ACCEPTED_EVENT_TYPES',
  'MAX_EVENTS_PER_RUN',
  // HubSpot
  'HUBSPOT_API_BASE_URL',
  'HUBSPOT_PROP_TECH_STACK',
  'HUBSPOT_PROP_INDUSTRY_RAW',
  'HUBSPOT_PROP_STATUS',
  'HUBSPOT_PROP_LAST_RUN',
  'HUBSPOT_PROP_ROOT_DOMAIN',
  'HUBSPOT_PROP_SOURCE',
  // Enrichment provider
  'ENRICHMENT_API_BASE_URL',
  'ENRICHMENT_API_PATH',
  'ENRICHMENT_DOMAIN_PARAM',
  'ENRICHMENT_PROVIDER_NAME',
  'ENRICH_RESPONSE_ROOT',
  'ENRICH_PATH_INDUSTRY',
  'ENRICH_PATH_EMPLOYEES',
  'ENRICH_PATH_EMPLOYEE_RANGE',
  'ENRICH_PATH_TECH',
  // Mapping policy
  'EMPLOYEE_RANGE_STRATEGY',
  'TECH_STACK_MAX_ITEMS',
  'INDUSTRY_MAP_JSON',
  'OVERWRITE_EXISTING',
  'FORCE_REENRICH',
  'WRITE_NORMALIZED_DOMAIN',
  // Domain rules
  'EXTRA_PUBLIC_SUFFIXES',
  'EXTRA_BLOCKED_DOMAINS',
  // Logging
  'LOG_DOMAINS',
]);

/** Safe defaults. SANDBOX_MODE defaults to true: a fresh install never writes to HubSpot. */
const DEFAULTS = Object.freeze({
  SANDBOX_MODE: 'true',
  WEBHOOK_SECRET: '',
  WEBHOOK_SECRET_HEADER: 'x-webhook-secret',
  REQUIRE_WEBHOOK_SECRET: 'true',
  ACCEPTED_EVENT_TYPES: 'company.creation',
  MAX_EVENTS_PER_RUN: '100',
  HUBSPOT_API_BASE_URL: 'https://api.hubapi.com',
  HUBSPOT_PROP_TECH_STACK: 'enriched_tech_stack',
  HUBSPOT_PROP_INDUSTRY_RAW: 'enriched_industry_raw',
  HUBSPOT_PROP_STATUS: 'enrichment_status',
  HUBSPOT_PROP_LAST_RUN: 'enrichment_last_run_at',
  HUBSPOT_PROP_ROOT_DOMAIN: 'enrichment_root_domain',
  HUBSPOT_PROP_SOURCE: 'enrichment_source',
  ENRICHMENT_API_BASE_URL: '',
  ENRICHMENT_API_PATH: '/companies/find',
  ENRICHMENT_DOMAIN_PARAM: 'domain',
  ENRICHMENT_PROVIDER_NAME: 'generic',
  ENRICH_RESPONSE_ROOT: '',
  ENRICH_PATH_INDUSTRY: 'category.industry|industry|industry_name',
  ENRICH_PATH_EMPLOYEES: 'metrics.employees|employee_count|employees|headcount',
  ENRICH_PATH_EMPLOYEE_RANGE: 'metrics.employeesRange|employee_range|size',
  ENRICH_PATH_TECH: 'tech|technologies|tech_stack',
  EMPLOYEE_RANGE_STRATEGY: 'midpoint',
  TECH_STACK_MAX_ITEMS: '50',
  INDUSTRY_MAP_JSON: '',
  OVERWRITE_EXISTING: 'false',
  FORCE_REENRICH: 'false',
  WRITE_NORMALIZED_DOMAIN: 'true',
  EXTRA_PUBLIC_SUFFIXES: '',
  EXTRA_BLOCKED_DOMAINS: '',
  LOG_DOMAINS: 'true',
});

const PLACEHOLDER_PATTERN = /^\{\{.*\}\}$|^<?(your[-_]|YOUR_|REPLACE_)/;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const PATH_PATTERN = /^[A-Za-z0-9_$]+(\.[A-Za-z0-9_$]+)*$/;
const HEADER_PATTERN = /^[a-z0-9-]{1,64}$/;
const DOMAIN_LIKE_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RANGE_STRATEGIES = Object.freeze(['lower', 'midpoint', 'upper']);
const MIN_SECRET_LENGTH = 16;

/** Thrown when configuration is invalid. `problems` lists every issue found. */
class ConfigError extends Error {
  constructor(problems) {
    super('Invalid enrichment router configuration:\n  - ' + problems.join('\n  - '));
    this.name = 'ConfigError';
    this.problems = problems.slice();
  }
}

/** True when a value is a template placeholder rather than a real setting. */
function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_PATTERN.test(value.trim());
}

/** Reader that records problems instead of throwing on the first one. */
function createReader(env, problems) {
  const source = env && typeof env === 'object' ? env : {};

  function raw(key) {
    let value;
    try {
      value = source[key];
    } catch (err) {
      value = undefined; // n8n may block $env access; treat as unset
    }
    if (value === undefined || value === null || String(value).trim() === '') {
      return DEFAULTS[key] !== undefined ? DEFAULTS[key] : '';
    }
    return String(value).trim();
  }

  function str(key) {
    const value = raw(key);
    return isPlaceholder(value) ? '' : value;
  }

  function bool(key) {
    const value = raw(key).toLowerCase();
    if (['true', '1', 'yes', 'on'].indexOf(value) !== -1) return true;
    if (['false', '0', 'no', 'off'].indexOf(value) !== -1) return false;
    problems.push(`${key} must be true or false, received "${value}"`);
    return DEFAULTS[key] === 'true';
  }

  function int(key, min, max) {
    const value = raw(key);
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      problems.push(`${key} must be an integer, received "${value}"`);
      return Number(DEFAULTS[key]) || 0;
    }
    if (parsed < min || parsed > max) problems.push(`${key} must be between ${min} and ${max}, received ${parsed}`);
    return parsed;
  }

  function list(key) {
    return str(key)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !isPlaceholder(part));
  }

  function paths(key) {
    const parts = raw(key)
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) problems.push(`${key} must list at least one field path`);
    parts.forEach((p) => {
      if (!PATH_PATTERN.test(p)) problems.push(`${key} contains an invalid field path "${p}" (use dot.notation, separate alternatives with |)`);
    });
    return parts;
  }

  return { raw, str, bool, int, list, paths };
}

/** Parse INDUSTRY_MAP_JSON ({"fintech": "FINANCIAL_SERVICES"}) into a lowercase-keyed map. */
function parseIndustryMap(value, problems) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    problems.push('INDUSTRY_MAP_JSON must be valid JSON, e.g. {"fintech":"FINANCIAL_SERVICES"}');
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('INDUSTRY_MAP_JSON must be a JSON object');
    return {};
  }
  const map = {};
  Object.keys(parsed).forEach((k) => {
    const target = String(parsed[k] || '').trim();
    if (!/^[A-Z0-9_]+$/.test(target)) {
      problems.push(`INDUSTRY_MAP_JSON value for "${k}" must be a HubSpot industry option like COMPUTER_SOFTWARE`);
      return;
    }
    map[k.trim().toLowerCase()] = target;
  });
  return map;
}

function deepFreeze(obj) {
  Object.keys(obj).forEach((key) => {
    const value = obj[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  });
  return Object.freeze(obj);
}

/**
 * Parse and validate configuration.
 * @param {Record<string,string|undefined>} [env] process.env in Node, $env in n8n.
 * @returns {object} Deeply frozen config.
 * @throws {ConfigError}
 */
function loadConfig(env) {
  const sourceEnv = env !== undefined ? env : typeof process !== 'undefined' && process.env ? process.env : {};
  const problems = [];
  const warnings = [];
  const r = createReader(sourceEnv, problems);

  const sandboxMode = r.bool('SANDBOX_MODE');

  // --- Inbound events ------------------------------------------------------
  const webhook = {
    secret: r.str('WEBHOOK_SECRET'),
    header: r.raw('WEBHOOK_SECRET_HEADER').toLowerCase(),
    requireSecret: r.bool('REQUIRE_WEBHOOK_SECRET'),
  };
  if (!HEADER_PATTERN.test(webhook.header)) problems.push('WEBHOOK_SECRET_HEADER must be a lowercase HTTP header name');
  const events = {
    acceptedTypes: r.list('ACCEPTED_EVENT_TYPES').map((t) => t.toLowerCase()),
    maxPerRun: r.int('MAX_EVENTS_PER_RUN', 1, 1000),
  };
  if (events.acceptedTypes.length === 0) problems.push('ACCEPTED_EVENT_TYPES must list at least one event type');

  // --- HubSpot -------------------------------------------------------------
  const hubspot = {
    apiBaseUrl: r.raw('HUBSPOT_API_BASE_URL').replace(/\/+$/, ''),
    props: {
      techStack: r.raw('HUBSPOT_PROP_TECH_STACK'),
      industryRaw: r.raw('HUBSPOT_PROP_INDUSTRY_RAW'),
      status: r.raw('HUBSPOT_PROP_STATUS'),
      lastRun: r.raw('HUBSPOT_PROP_LAST_RUN'),
      rootDomain: r.raw('HUBSPOT_PROP_ROOT_DOMAIN'),
      source: r.raw('HUBSPOT_PROP_SOURCE'),
    },
  };
  if (!/^https:\/\/\S+$/.test(hubspot.apiBaseUrl)) problems.push('HUBSPOT_API_BASE_URL must be an https:// URL');
  Object.keys(hubspot.props).forEach((label) => {
    const name = hubspot.props[label];
    if (!PROPERTY_NAME_PATTERN.test(name)) problems.push(`HubSpot property name for ${label} ("${name}") must be lowercase snake_case`);
  });

  // --- Enrichment provider -------------------------------------------------
  const enrichment = {
    baseUrl: r.str('ENRICHMENT_API_BASE_URL').replace(/\/+$/, ''),
    path: r.raw('ENRICHMENT_API_PATH'),
    domainParam: r.raw('ENRICHMENT_DOMAIN_PARAM'),
    providerName: r.raw('ENRICHMENT_PROVIDER_NAME'),
    responseRoot: r.raw('ENRICH_RESPONSE_ROOT'),
    paths: {
      industry: r.paths('ENRICH_PATH_INDUSTRY'),
      employees: r.paths('ENRICH_PATH_EMPLOYEES'),
      employeeRange: r.paths('ENRICH_PATH_EMPLOYEE_RANGE'),
      tech: r.paths('ENRICH_PATH_TECH'),
    },
    employeeRangeStrategy: r.raw('EMPLOYEE_RANGE_STRATEGY').toLowerCase(),
    techStackMax: r.int('TECH_STACK_MAX_ITEMS', 1, 500),
  };
  if (enrichment.baseUrl && !/^https:\/\/[^\s?#]+$/.test(enrichment.baseUrl)) {
    problems.push('ENRICHMENT_API_BASE_URL must be an https:// URL without a query string');
  }
  if (!/^\/[A-Za-z0-9/_.{}-]*$/.test(enrichment.path)) problems.push('ENRICHMENT_API_PATH must start with "/"');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(enrichment.domainParam)) problems.push('ENRICHMENT_DOMAIN_PARAM must be a simple query parameter name');
  if (!/^[A-Za-z0-9 _.-]{1,60}$/.test(enrichment.providerName)) problems.push('ENRICHMENT_PROVIDER_NAME may contain letters, numbers, spaces, ".", "_" and "-" only');
  if (enrichment.responseRoot && !PATH_PATTERN.test(enrichment.responseRoot)) problems.push('ENRICH_RESPONSE_ROOT must be a dot.notation path or blank');
  if (RANGE_STRATEGIES.indexOf(enrichment.employeeRangeStrategy) === -1) {
    problems.push(`EMPLOYEE_RANGE_STRATEGY must be one of ${RANGE_STRATEGIES.join(', ')}`);
  }

  // --- Mapping policy ------------------------------------------------------
  const mapping = {
    industryMap: parseIndustryMap(r.str('INDUSTRY_MAP_JSON'), problems),
    overwriteExisting: r.bool('OVERWRITE_EXISTING'),
    forceReenrich: r.bool('FORCE_REENRICH'),
    writeNormalizedDomain: r.bool('WRITE_NORMALIZED_DOMAIN'),
  };

  // --- Domain rules --------------------------------------------------------
  const domains = {
    extraSuffixes: r.list('EXTRA_PUBLIC_SUFFIXES').map((s) => s.toLowerCase().replace(/^\.+/, '')),
    extraBlocked: r.list('EXTRA_BLOCKED_DOMAINS').map((s) => s.toLowerCase()),
  };
  domains.extraSuffixes.concat(domains.extraBlocked).forEach((d) => {
    if (!DOMAIN_LIKE_PATTERN.test(d)) problems.push(`"${d}" in EXTRA_PUBLIC_SUFFIXES / EXTRA_BLOCKED_DOMAINS is not a valid domain`);
  });

  const logging = { logDomains: r.bool('LOG_DOMAINS') };

  // --- Live-mode requirements (fail fast) ----------------------------------
  const liveIssues = [];
  if (!enrichment.baseUrl) liveIssues.push('ENRICHMENT_API_BASE_URL is not set; enrichment lookups will be skipped');
  if (webhook.requireSecret && !webhook.secret) {
    liveIssues.push('WEBHOOK_SECRET is required when REQUIRE_WEBHOOK_SECRET=true');
  } else if (webhook.secret && webhook.secret.length < MIN_SECRET_LENGTH) {
    liveIssues.push(`WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (!webhook.requireSecret) warnings.push('REQUIRE_WEBHOOK_SECRET=false: webhook calls are accepted without authentication');
  if (mapping.overwriteExisting) warnings.push('OVERWRITE_EXISTING=true: enriched values will replace data already on company records');

  if (sandboxMode) liveIssues.forEach((issue) => warnings.push(`[sandbox] ${issue}`));
  else liveIssues.forEach((issue) => problems.push(issue));

  if (problems.length > 0) throw new ConfigError(problems);

  return deepFreeze({
    sandboxMode,
    webhook,
    events,
    hubspot,
    enrichment,
    mapping,
    domains,
    logging,
    warnings,
  });
}

/** Human-readable summary with every secret removed (safe to print or log). */
function describeConfig(config) {
  return {
    mode: config.sandboxMode ? 'SANDBOX (dry run)' : 'LIVE',
    webhookSecret: config.webhook.secret ? 'set' : 'not set',
    webhookSecretRequired: config.webhook.requireSecret,
    acceptedEventTypes: config.events.acceptedTypes.slice(),
    enrichmentProvider: config.enrichment.providerName,
    enrichmentApiConfigured: Boolean(config.enrichment.baseUrl),
    overwriteExisting: config.mapping.overwriteExisting,
    forceReenrich: config.mapping.forceReenrich,
    hubspotProperties: Object.assign({}, config.hubspot.props),
    warnings: config.warnings.slice(),
  };
}

module.exports = {
  ENV_KEYS,
  DEFAULTS,
  MIN_SECRET_LENGTH,
  ConfigError,
  isPlaceholder,
  parseIndustryMap,
  loadConfig,
  describeConfig,
};

// ---- CLI (stripped from n8n build) ----
/* istanbul ignore next */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const fs = require('node:fs');

  /** Minimal .env parser: KEY=value lines, # comments, optional surrounding quotes. */
  const parseEnvFile = (text) => {
    const env = {};
    text.split(/\r?\n/).forEach((line) => {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) return;
      env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    });
    return env;
  };

  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--env-path');
  let env = process.env;
  if (fileIndex !== -1) {
    const file = args[fileIndex + 1];
    if (!file || !fs.existsSync(file)) {
      console.error(`config.validator: env file not found: ${file || '(missing path)'}`);
      process.exit(2);
    }
    env = Object.assign({}, process.env, parseEnvFile(fs.readFileSync(file, 'utf8')));
  }

  try {
    const summary = describeConfig(loadConfig(env));
    console.log('config.validator: configuration is valid');
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : `config.validator: ${err.message}`);
    process.exit(1);
  }
}
