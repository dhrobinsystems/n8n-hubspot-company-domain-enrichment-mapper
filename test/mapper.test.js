'use strict';

/**
 * test/mapper.test.js
 * Enrichment response classification and HubSpot property mapping (src/mapper.js),
 * plus the extraction stage and telemetry in src/router.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config.validator');
const M = require('../src/mapper');
const Domain = require('../src/domain');
const R = require('../src/router');

const NOW = new Date('2026-01-15T10:00:00.000Z');
const ENV = {
  SANDBOX_MODE: 'true',
  ENRICHMENT_API_BASE_URL: 'https://api.enrichment-provider.example/v1',
  ENRICHMENT_PROVIDER_NAME: 'mock-provider',
};
const cfg = (overrides) => loadConfig(Object.assign({}, ENV, overrides || {}));
const deps = { Domain, Mapper: M };

function ctx(overrides) {
  return Object.assign({ stage: 'extracted', companyId: '101', rootDomain: 'example.com', shouldEnrich: true, skipStatus: null, currentProperties: {} }, overrides);
}

// ---------------------------------------------------------------------------
// Field mappers
// ---------------------------------------------------------------------------

test('getPath reads nested paths and alternatives, skipping empty values', () => {
  const obj = { a: { b: '', c: 'x' }, list: [], n: 0, d: null };
  assert.equal(M.getPath(obj, 'a.b|a.c'), 'x');
  assert.equal(M.getPath(obj, 'missing.path|a.c'), 'x');
  assert.equal(M.getPath(obj, 'list|n'), 0);
  assert.equal(M.getPath(obj, 'd'), undefined);
  assert.equal(M.getPath(null, 'a'), undefined);
  assert.equal(M.getPath(obj, ['a.c']), 'x');
});

test('mapIndustry maps exact synonyms, keywords, custom maps and leaves unknowns unmapped', () => {
  assert.deepEqual(M.mapIndustry('Computer Software'), { option: 'COMPUTER_SOFTWARE', raw: 'Computer Software', method: 'EXACT' });
  assert.equal(M.mapIndustry('Marketing & Advertising').option, 'MARKETING_AND_ADVERTISING');
  assert.equal(M.mapIndustry('Hospitals and Health Care').option, 'HOSPITAL_HEALTH_CARE');
  assert.equal(M.mapIndustry('B2B SaaS Platform').method, 'KEYWORD');
  assert.equal(M.mapIndustry('B2B SaaS Platform').option, 'COMPUTER_SOFTWARE');
  assert.equal(M.mapIndustry('VENTURE_CAPITAL_PRIVATE_EQUITY').method, 'ALREADY_OPTION');
  assert.equal(M.mapIndustry('COMPUTER_SOFTWARE').option, 'COMPUTER_SOFTWARE');
  assert.deepEqual(M.mapIndustry('Underwater Basket Weaving'), { option: null, raw: 'Underwater Basket Weaving', method: 'UNMAPPED' });
  assert.equal(M.mapIndustry('Underwater Basket Weaving', { 'underwater basket weaving': 'ARTS_AND_CRAFTS' }).option, 'ARTS_AND_CRAFTS');
  assert.equal(M.mapIndustry({ name: 'Banking' }).option, 'BANKING');
  assert.equal(M.mapIndustry(['Insurance', 'Other']).option, 'INSURANCE');
  assert.equal(M.mapIndustry('').method, 'EMPTY');
  assert.equal(M.mapIndustry(null).method, 'EMPTY');
});

test('parseEmployeeCount handles numbers, ranges, suffixes and objects', () => {
  assert.equal(M.parseEmployeeCount(250), 250);
  assert.equal(M.parseEmployeeCount('250'), 250);
  assert.equal(M.parseEmployeeCount('1,200'), 1200);
  assert.equal(M.parseEmployeeCount('1.2k'), 1200);
  assert.equal(M.parseEmployeeCount('10K+'), 10000);
  assert.equal(M.parseEmployeeCount('1000+'), 1000);
  assert.equal(M.parseEmployeeCount('51-200'), 126);
  assert.equal(M.parseEmployeeCount('51-200', 'lower'), 51);
  assert.equal(M.parseEmployeeCount('51 to 200', 'upper'), 200);
  assert.equal(M.parseEmployeeCount('1k–5k'), 3000);
  assert.equal(M.parseEmployeeCount({ min: 11, max: 50 }), 31);
  assert.equal(M.parseEmployeeCount({ min: 5000 }), 5000);
});

test('parseEmployeeCount rejects junk instead of guessing', () => {
  [null, undefined, '', 'unknown', 'n/a', -5, 0, NaN, Infinity, '200-50', {}, '99999999999'].forEach((v) =>
    assert.equal(M.parseEmployeeCount(v), null, `expected null for ${String(v)}`)
  );
});

test('normalizeTechStack dedupes, cleans, sorts and caps', () => {
  assert.deepEqual(M.normalizeTechStack(['React', 'hubspot', 'HubSpot', '', '  Cloudflare  ', null]), ['Cloudflare', 'hubspot', 'React']);
  assert.deepEqual(M.normalizeTechStack([{ name: 'Shopify' }, { title: 'Klaviyo' }, { technology: 'Stripe' }]), ['Klaviyo', 'Shopify', 'Stripe']);
  assert.deepEqual(M.normalizeTechStack('WordPress; Google Tag Manager, Salesforce'), ['Google Tag Manager', 'Salesforce', 'WordPress']);
  assert.deepEqual(M.normalizeTechStack({ Analytics: ['Mixpanel', 'Segment'], CRM: 'HubSpot' }), ['HubSpot', 'Mixpanel', 'Segment']);
  assert.equal(M.normalizeTechStack(Array.from({ length: 80 }, (_, i) => `Tool ${i}`), 10).length, 10);
  assert.deepEqual(M.normalizeTechStack(undefined), []);
  assert.equal(M.normalizeTechStack(['A\u0000B\nC'])[0], 'A B C', 'control characters removed');
});

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

test('classifyEnrichmentResponse maps HTTP errors to fallback states', () => {
  const c = cfg();
  const err = (httpCode, message) => M.classifyEnrichmentResponse({ error: { httpCode, message: message || 'failed' } }, c).outcome;
  assert.equal(err('404'), M.STATUS.NOT_FOUND);
  assert.equal(err('422'), M.STATUS.NOT_FOUND);
  assert.equal(err('429'), M.STATUS.RATE_LIMITED);
  assert.equal(err(undefined, 'Too Many Requests'), M.STATUS.RATE_LIMITED);
  assert.equal(err('401'), M.STATUS.ERROR_AUTH);
  assert.equal(err('403'), M.STATUS.ERROR_AUTH);
  assert.equal(err('500'), M.STATUS.ERROR_PROVIDER);
  assert.equal(err(undefined, 'Request failed with status code 503'), M.STATUS.ERROR_PROVIDER);
  assert.equal(M.classifyEnrichmentResponse({ error: 'socket hang up' }, c).outcome, M.STATUS.ERROR_PROVIDER);
});

test('classifyEnrichmentResponse unwraps envelopes and detects empty results', () => {
  const c = cfg();
  assert.equal(M.classifyEnrichmentResponse({ data: { industry: 'Banking' }, meta: {} }, c).data.industry, 'Banking');
  assert.equal(M.classifyEnrichmentResponse([{ industry: 'Banking' }], c).outcome, M.STATUS.ERROR_PROVIDER, 'top-level arrays are not n8n item JSON');
  assert.equal(M.classifyEnrichmentResponse({}, c).outcome, M.STATUS.NOT_FOUND);
  assert.equal(M.classifyEnrichmentResponse(null, c).outcome, M.STATUS.NOT_FOUND);
  assert.equal(M.classifyEnrichmentResponse({ found: false }, c).outcome, M.STATUS.NOT_FOUND);
  assert.equal(M.classifyEnrichmentResponse('text', c).outcome, M.STATUS.ERROR_PROVIDER);
  const rooted = cfg({ ENRICH_RESPONSE_ROOT: 'result.company' });
  assert.equal(M.classifyEnrichmentResponse({ result: { company: { industry: 'Retail' } } }, rooted).data.industry, 'Retail');
  assert.equal(M.classifyEnrichmentResponse({ result: { companies: [{ industry: 'Retail' }] } }, cfg({ ENRICH_RESPONSE_ROOT: 'result.companies' })).data.industry, 'Retail');
});

// ---------------------------------------------------------------------------
// buildCompanyUpdate
// ---------------------------------------------------------------------------

const FULL_RESPONSE = {
  category: { industry: 'Computer Software' },
  metrics: { employeesRange: '51-200' },
  tech: ['React', 'HubSpot'],
};

test('buildCompanyUpdate maps all three fields onto an empty record', () => {
  const u = M.buildCompanyUpdate(ctx(), FULL_RESPONSE, cfg(), NOW);
  assert.equal(u.status, M.STATUS.ENRICHED);
  assert.equal(u.properties.industry, 'COMPUTER_SOFTWARE');
  assert.equal(u.properties.enriched_industry_raw, 'Computer Software');
  assert.equal(u.properties.numberofemployees, '126');
  assert.equal(u.properties.enriched_tech_stack, 'HubSpot; React');
  assert.equal(u.properties.domain, 'example.com');
  assert.equal(u.properties.enrichment_root_domain, 'example.com');
  assert.equal(u.properties.enrichment_status, 'ENRICHED');
  assert.equal(u.properties.enrichment_last_run_at, NOW.toISOString());
  assert.equal(u.properties.enrichment_source, 'mock-provider');
  assert.equal(u.hasUpdate, true);
  assert.equal(u.sandbox, true);
});

test('buildCompanyUpdate preserves existing values unless OVERWRITE_EXISTING=true', () => {
  const current = { domain: 'example.com', industry: 'RETAIL', numberofemployees: '40', enriched_tech_stack: 'Legacy' };
  const preserved = M.buildCompanyUpdate(ctx({ currentProperties: current }), FULL_RESPONSE, cfg(), NOW);
  assert.equal(preserved.properties.industry, undefined);
  assert.equal(preserved.properties.numberofemployees, undefined);
  assert.equal(preserved.properties.enriched_tech_stack, undefined);
  assert.equal(preserved.properties.domain, undefined, 'existing domain is never replaced');
  assert.deepEqual(preserved.preserved.map((p) => p.property).sort(), ['enriched_tech_stack', 'industry', 'numberofemployees']);
  assert.equal(preserved.status, M.STATUS.ENRICHED, 'all three fields were found; preservation is reported separately');
  assert.equal(preserved.properties.enriched_industry_raw, 'Computer Software', 'raw industry text is still recorded');

  const overwritten = M.buildCompanyUpdate(ctx({ currentProperties: current }), FULL_RESPONSE, cfg({ OVERWRITE_EXISTING: 'true' }), NOW);
  assert.equal(overwritten.properties.industry, 'COMPUTER_SOFTWARE');
  assert.equal(overwritten.properties.numberofemployees, '126');
  assert.deepEqual(overwritten.changes.find((c) => c.property === 'industry'), { property: 'industry', from: 'RETAIL', to: 'COMPUTER_SOFTWARE' });
});

test('buildCompanyUpdate never sends an invalid option to the industry dropdown', () => {
  const u = M.buildCompanyUpdate(ctx(), { industry: 'Underwater Basket Weaving', employee_count: 12 }, cfg(), NOW);
  assert.equal(u.properties.industry, undefined);
  assert.equal(u.properties.enriched_industry_raw, 'Underwater Basket Weaving');
  assert.equal(u.status, M.STATUS.PARTIAL);
  assert.equal(u.mapped.industryMethod, 'UNMAPPED');
});

test('buildCompanyUpdate reports NO_CHANGES when enrichment matches the record', () => {
  const current = { industry: 'COMPUTER_SOFTWARE', enriched_industry_raw: 'Computer Software', numberofemployees: '126', enriched_tech_stack: 'HubSpot; React', domain: 'example.com' };
  const u = M.buildCompanyUpdate(ctx({ currentProperties: current }), FULL_RESPONSE, cfg(), NOW);
  assert.equal(u.status, M.STATUS.NO_CHANGES);
  assert.deepEqual(Object.keys(u.properties).sort(), ['enrichment_last_run_at', 'enrichment_root_domain', 'enrichment_source', 'enrichment_status']);
});

test('buildCompanyUpdate writes fallback statuses for provider failures', () => {
  const c = cfg();
  [
    [{ error: { httpCode: '404' } }, 'NOT_FOUND'],
    [{ error: { httpCode: '429' } }, 'RATE_LIMITED'],
    [{ error: { httpCode: '401' } }, 'ERROR_AUTH'],
    [{ error: { httpCode: '502' } }, 'ERROR_PROVIDER'],
    [{ unrelated: true }, 'NOT_FOUND'],
  ].forEach(([response, status]) => {
    const u = M.buildCompanyUpdate(ctx(), response, c, NOW);
    assert.equal(u.status, status);
    assert.equal(u.properties.enrichment_status, status);
    assert.equal(u.properties.industry, undefined);
    assert.equal(u.hasUpdate, true, 'status is still recorded on the company');
  });
});

test('buildCompanyUpdate writes skip statuses but never touches already-enriched or unreadable records', () => {
  const c = cfg();
  const noDomain = M.buildCompanyUpdate(ctx({ rootDomain: null, skipStatus: 'SKIPPED_NO_DOMAIN' }), null, c, NOW);
  assert.deepEqual(Object.keys(noDomain.properties).sort(), ['enrichment_last_run_at', 'enrichment_status']);

  const already = M.buildCompanyUpdate(ctx({ skipStatus: 'SKIPPED_ALREADY_ENRICHED' }), null, c, NOW);
  assert.deepEqual(already.properties, {});
  assert.equal(already.hasUpdate, false);

  const unreadable = M.buildCompanyUpdate(ctx({ skipStatus: 'ERROR_HUBSPOT_FETCH' }), null, c, NOW);
  assert.equal(unreadable.hasUpdate, false);

  const missingId = M.buildCompanyUpdate(ctx({ companyId: null }), FULL_RESPONSE, c, NOW);
  assert.equal(missingId.hasUpdate, false);
});

test('buildCompanyUpdate respects WRITE_NORMALIZED_DOMAIN and custom field paths', () => {
  const noDomainWrite = M.buildCompanyUpdate(ctx(), FULL_RESPONSE, cfg({ WRITE_NORMALIZED_DOMAIN: 'false' }), NOW);
  assert.equal(noDomainWrite.properties.domain, undefined);

  const custom = cfg({ ENRICH_PATH_INDUSTRY: 'firmo.sector', ENRICH_PATH_EMPLOYEES: 'firmo.staff', ENRICH_PATH_TECH: 'stack.items' });
  const u = M.buildCompanyUpdate(ctx(), { firmo: { sector: 'Banking', staff: '75' }, stack: { items: ['Okta'] } }, custom, NOW);
  assert.equal(u.properties.industry, 'BANKING');
  assert.equal(u.properties.numberofemployees, '75');
  assert.equal(u.properties.enriched_tech_stack, 'Okta');
});

test('companyPropertiesToFetch includes mapped and bookkeeping properties without duplicates', () => {
  const list = M.companyPropertiesToFetch(cfg());
  ['domain', 'website', 'industry', 'numberofemployees', 'enriched_tech_stack', 'enrichment_status'].forEach((p) => assert.ok(list.includes(p)));
  assert.equal(new Set(list).size, list.length);
});

// ---------------------------------------------------------------------------
// Extraction stage and telemetry (src/router.js)
// ---------------------------------------------------------------------------

test('prepareEnrichment builds the lookup URL and keeps only mapping-relevant properties', () => {
  const company = { id: '101', properties: { name: 'Example Co', website: 'http://www.example.com/path', hubspot_owner_id: '7' } };
  const out = R.prepareEnrichment(company, { companyId: '101', source: 'hubspot_trigger' }, cfg(), deps);
  assert.equal(out.shouldEnrich, true);
  assert.equal(out.rootDomain, 'example.com');
  assert.equal(out.domainField, 'website');
  assert.equal(out.enrichmentUrl, 'https://api.enrichment-provider.example/v1/companies/find?domain=example.com');
  assert.equal('name' in out.currentProperties, false, 'company names are not carried forward');
  assert.equal('hubspot_owner_id' in out.currentProperties, false);
});

test('prepareEnrichment skip decisions', () => {
  const c = cfg();
  const run = (props, config) => R.prepareEnrichment({ id: '1', properties: props }, {}, config || c, deps);
  assert.equal(run({}).skipStatus, 'SKIPPED_NO_DOMAIN');
  assert.equal(run({ domain: 'gmail.com' }).skipStatus, 'SKIPPED_BLOCKED_DOMAIN');
  assert.equal(run({ domain: 'localhost' }).skipStatus, 'SKIPPED_INVALID_DOMAIN');
  assert.equal(run({ domain: 'example.com', enrichment_status: 'ENRICHED' }).skipStatus, 'SKIPPED_ALREADY_ENRICHED');
  assert.equal(run({ domain: 'example.com', enrichment_status: 'ENRICHED' }, cfg({ FORCE_REENRICH: 'true' })).shouldEnrich, true);
  assert.equal(run({ domain: 'example.com' }, cfg({ ENRICHMENT_API_BASE_URL: '{{ENRICHMENT_API_BASE_URL}}' })).skipStatus, 'SKIPPED_NO_PROVIDER');

  const fetchError = R.prepareEnrichment({ error: { message: 'Unauthorized for ops@example.com' } }, { companyId: '9' }, c, deps);
  assert.equal(fetchError.skipStatus, 'ERROR_HUBSPOT_FETCH');
  assert.equal(fetchError.companyId, '9', 'company ID recovered from the paired event');
  assert.ok(!fetchError.skipReason.includes('ops@example.com'), 'error text is redacted');
});

test('buildDryRunReport summarizes planned writes and can mask domains', () => {
  const c = cfg({ LOG_DOMAINS: 'false' });
  const updates = [
    M.buildCompanyUpdate(ctx(), FULL_RESPONSE, c, NOW),
    M.buildCompanyUpdate(ctx({ companyId: '102', rootDomain: 'acme-widgets.co.uk' }), { error: { httpCode: '429' } }, c, NOW),
    M.buildCompanyUpdate(ctx({ companyId: '103', skipStatus: 'SKIPPED_ALREADY_ENRICHED' }), null, c, NOW),
    { kind: 'something_else' },
  ];
  const report = R.buildDryRunReport(updates, c, deps, { runId: 'r1' });
  assert.equal(report.totals.companies, 3);
  assert.equal(report.totals.plannedUpdates, 2);
  assert.deepEqual(report.byStatus, { ENRICHED: 1, RATE_LIMITED: 1, SKIPPED_ALREADY_ENRICHED: 1 });
  const text = report.lines.join('\n');
  assert.ok(text.includes('ex*****.com') && !text.includes('example.com'), 'domains masked');
  assert.ok(text.includes('http=429'));
  assert.equal(R.buildDryRunReport([], c, deps).totals.companies, 0);
});

test('summarizeUpdateResults pairs responses with updates and redacts errors', () => {
  const log = R.summarizeUpdateResults(
    [{ id: '1', properties: {} }, { error: { message: 'Bearer abc.def rejected' } }, null],
    [{ companyId: '1', status: 'ENRICHED', properties: { industry: 'BANKING' } }, { companyId: '2', status: 'PARTIAL', properties: { a: 1 } }]
  );
  assert.deepEqual(log.totals, { attempted: 3, succeeded: 1, failed: 2 });
  assert.deepEqual(log.results[0].written, ['industry']);
  assert.ok(!log.results[1].error.includes('abc.def'));
});
