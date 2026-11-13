'use strict';

/**
 * test/workflow.test.js
 * Validates workflow.json structurally and executes its Code nodes through
 * workflow.harness.js against the mock payloads in test/fixtures.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../workflow.harness');
const { buildWorkflow, serialize } = require('../scripts/build-workflow');

const ROOT = path.resolve(__dirname, '..');
const workflow = H.loadWorkflow();
const SECRET = H.HARNESS_ENV.WEBHOOK_SECRET;
const node = (name) => {
  const n = workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `missing node ${name}`);
  return n;
};
const byId = (list) => Object.fromEntries(list.map((u) => [u.companyId, u]));

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('workflow.json matches a fresh build of the source modules', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), serialize(buildWorkflow()), 'run ./build.sh');
});

test('workflow has the required nodes, types and execution modes', () => {
  const expected = {
    'HubSpot Company Created': 'n8n-nodes-base.hubspotTrigger',
    'Company Created Webhook': 'n8n-nodes-base.webhook',
    'Normalize & Verify Events': 'n8n-nodes-base.code',
    'HubSpot Get Company': 'n8n-nodes-base.httpRequest',
    'Extract Root Domain': 'n8n-nodes-base.code',
    'Domain Enrichable?': 'n8n-nodes-base.if',
    'Enrichment API Lookup': 'n8n-nodes-base.httpRequest',
    'Map Enrichment to HubSpot': 'n8n-nodes-base.code',
    'Sandbox Mode?': 'n8n-nodes-base.if',
    'Dry-Run Telemetry': 'n8n-nodes-base.code',
    'Has Property Changes?': 'n8n-nodes-base.if',
    'HubSpot Update Company': 'n8n-nodes-base.httpRequest',
    'Log Update Results': 'n8n-nodes-base.code',
  };
  Object.entries(expected).forEach(([name, type]) => assert.equal(node(name).type, type, name));
  assert.equal(node('Extract Root Domain').parameters.mode, 'runOnceForEachItem');
  assert.equal(node('Map Enrichment to HubSpot').parameters.mode, 'runOnceForEachItem');
  assert.equal(node('HubSpot Company Created').parameters.eventsUi.eventValues[0].name, 'company.creation');
  assert.equal(node('Company Created Webhook').parameters.responseMode, 'onReceived', 'webhook must acknowledge immediately (async)');
  assert.equal(workflow.active, false);
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length);
});

test('connections are valid and route sandbox and skip branches correctly', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  const targets = new Set();
  Object.entries(workflow.connections).forEach(([src, v]) => {
    assert.ok(names.has(src), src);
    v.main.forEach((branch) => branch.forEach((c) => (assert.ok(names.has(c.node), c.node), targets.add(c.node))));
  });
  workflow.nodes.filter((n) => !/Trigger$|webhook$|stickyNote$/.test(n.type)).forEach((n) => assert.ok(targets.has(n.name), `${n.name} unreachable`));
  const c = workflow.connections;
  assert.equal(c['Domain Enrichable?'].main[0][0].node, 'Enrichment API Lookup');
  assert.equal(c['Domain Enrichable?'].main[1][0].node, 'Map Enrichment to HubSpot');
  assert.equal(c['Sandbox Mode?'].main[0][0].node, 'Dry-Run Telemetry');
  assert.equal(c['Sandbox Mode?'].main[1][0].node, 'Has Property Changes?');
  assert.equal(c['Has Property Changes?'].main[0][0].node, 'HubSpot Update Company');
});

test('credentials are placeholders; HTTP nodes retry, batch and continue on error', () => {
  workflow.nodes
    .filter((n) => n.credentials)
    .forEach((n) =>
      Object.values(n.credentials).forEach((cred) => {
        assert.match(cred.id, /^REPLACE_WITH_/, n.name);
        assert.match(cred.name, /placeholder/i, n.name);
      })
    );
  ['HubSpot Get Company', 'Enrichment API Lookup', 'HubSpot Update Company'].forEach((name) => {
    const n = node(name);
    assert.equal(n.retryOnFail, true, name);
    assert.equal(n.onError, 'continueRegularOutput', name);
    assert.ok(n.parameters.options.batching.batch.batchSize <= 10, name);
    assert.ok(n.parameters.options.timeout > 0, name);
  });
  assert.equal(node('Enrichment API Lookup').parameters.genericAuthType, 'httpHeaderAuth');
});

// ---------------------------------------------------------------------------
// Code node execution
// ---------------------------------------------------------------------------

test('Normalize & Verify Events: dedupes, filters event types and builds request data', async () => {
  const events = H.loadFixture('hubspot-trigger-events.json').events;
  const { output, logs } = await H.runCodeNode(workflow, 'Normalize & Verify Events', events, { env: H.HARNESS_ENV });
  const ids = output.map((i) => i.json.companyId);
  assert.deepEqual(ids, ['101', '102', '103', '104', '105', '106', '107', '108']);
  assert.match(output[0].json.companyUrl, /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/companies\/101$/);
  assert.ok(output[0].json.requestProperties.includes('website'));
  assert.ok(logs.some((l) => /DUPLICATE":1/.test(l) && /EVENT_TYPE_NOT_ACCEPTED":1/.test(l) && /MISSING_COMPANY_ID":1/.test(l)));
});

test('Normalize & Verify Events: webhook secret is enforced', async () => {
  const run = (secret, env) => H.runCodeNode(workflow, 'Normalize & Verify Events', [H.webhookFixture(secret)], { env: Object.assign({}, H.HARNESS_ENV, env || {}) });
  assert.deepEqual((await run(SECRET)).output.map((i) => i.json.companyId), ['109']);
  const wrong = await run('wrong-secret-value-000000000');
  assert.equal(wrong.output.length, 0);
  assert.ok(wrong.logs.some((l) => l.includes('WEBHOOK_SECRET_MISMATCH')));
  const missing = await H.runCodeNode(workflow, 'Normalize & Verify Events', [{ headers: {}, body: { objectId: 1 } }], { env: H.HARNESS_ENV });
  assert.ok(missing.logs.some((l) => l.includes('WEBHOOK_SECRET_MISSING')));
  // Sandbox without a configured secret: accepted with a warning.
  const unverified = await run('anything', { WEBHOOK_SECRET: '' });
  assert.equal(unverified.output.length, 1);
  assert.ok(unverified.logs.some((l) => l.includes('without a secret')));
});

test('Normalize & Verify Events: fails fast on bad config and tolerates blocked $env', async () => {
  await assert.rejects(() => H.runCodeNode(workflow, 'Normalize & Verify Events', [], { env: { SANDBOX_MODE: 'false' } }), /ENRICHMENT_API_BASE_URL/);
  const blocked = await H.runCodeNode(workflow, 'Normalize & Verify Events', [{ objectId: 5, subscriptionType: 'company.creation' }], { blockEnv: true });
  assert.equal(blocked.output[0].json.sandbox, true, 'defaults keep sandbox on');
  const empty = await H.runCodeNode(workflow, 'Normalize & Verify Events', [], { env: H.HARNESS_ENV });
  assert.deepEqual(empty.output, []);
  const junk = await H.runCodeNode(workflow, 'Normalize & Verify Events', [null, 'x', 42], { env: H.HARNESS_ENV });
  assert.deepEqual(junk.output, []);
});

test('Extract Root Domain: recovers the company ID when the HubSpot fetch failed', async () => {
  const { output } = await H.runCodeNode(workflow, 'Extract Root Domain', [{ error: { message: 'Request failed with status code 404' } }], {
    env: H.HARNESS_ENV,
    paired: { 'Normalize & Verify Events': [{ companyId: '108', source: 'hubspot_trigger' }] },
  });
  assert.equal(output[0].json.companyId, '108');
  assert.equal(output[0].json.skipStatus, 'ERROR_HUBSPOT_FETCH');
  assert.equal(output[0].json.shouldEnrich, false);
});

test('Map Enrichment to HubSpot: works without paired data (explicit fallback)', async () => {
  const { output } = await H.runCodeNode(workflow, 'Map Enrichment to HubSpot', [{ industry: 'Banking' }], { env: H.HARNESS_ENV });
  assert.equal(output[0].json.kind, 'company_update');
  assert.equal(output[0].json.hasUpdate, false, 'no company ID means no write');
});

// ---------------------------------------------------------------------------
// End-to-end pipeline against fixtures
// ---------------------------------------------------------------------------

test('sandbox pipeline: correct status per company and zero HubSpot writes', async () => {
  const result = await H.simulatePipeline({ webhookItems: [H.webhookFixture(SECRET)] });
  const u = byId(result.mapped);
  const statuses = Object.fromEntries(Object.entries(u).map(([id, x]) => [id, x.status]));
  assert.deepEqual(statuses, {
    101: 'ENRICHED',
    102: 'PARTIAL',
    103: 'SKIPPED_BLOCKED_DOMAIN',
    104: 'SKIPPED_NO_DOMAIN',
    105: 'SKIPPED_ALREADY_ENRICHED',
    106: 'NOT_FOUND',
    107: 'RATE_LIMITED',
    108: 'ERROR_HUBSPOT_FETCH',
    109: 'ENRICHED',
  });
  assert.equal(result.requests.hubspotPatch.length, 0, 'sandbox must not write to HubSpot');
  assert.equal(result.requests.enrichment.length, 5);
  assert.equal(result.reports.length, 2, 'one dry-run report per incoming branch');
  assert.equal(result.reports.reduce((n, r) => n + r.totals.companies, 0), 9);
});

test('sandbox pipeline: domain extraction and data mapping match the mock payloads', async () => {
  const result = await H.simulatePipeline({ webhookItems: [H.webhookFixture(SECRET)] });
  const u = byId(result.mapped);

  // 101: website http://www.example.com/path -> example.com; range 51-200 -> midpoint 126
  assert.equal(u['101'].rootDomain, 'example.com');
  assert.equal(u['101'].properties.domain, 'example.com');
  assert.equal(u['101'].properties.industry, 'COMPUTER_SOFTWARE');
  assert.equal(u['101'].properties.numberofemployees, '126');
  assert.equal(u['101'].properties.enriched_tech_stack, 'Cloudflare; Google Analytics; HubSpot; React');

  // 102: co.uk suffix, enveloped response, unmapped industry, existing industry untouched
  assert.equal(u['102'].rootDomain, 'acme-widgets.co.uk');
  assert.equal(u['102'].properties.industry, undefined);
  assert.equal(u['102'].properties.enriched_industry_raw, 'Underwater Basket Weaving');
  assert.equal(u['102'].properties.numberofemployees, '1200');
  assert.equal(u['102'].properties.enriched_tech_stack, 'Klaviyo; Shopify');

  // 109 (webhook): "10K+" headcount, semicolon tech string, "&" industry
  assert.equal(u['109'].properties.industry, 'MARKETING_AND_ADVERTISING');
  assert.equal(u['109'].properties.numberofemployees, '10000');
  assert.equal(u['109'].properties.enriched_tech_stack, 'Google Tag Manager; Salesforce; WordPress');

  // Fallback states are recorded, nothing else written
  assert.equal(u['106'].httpStatus, 404);
  assert.equal(u['107'].properties.enrichment_status, 'RATE_LIMITED');
  assert.deepEqual(u['105'].properties, {});

  // Enrichment requests only ever contain the root domain
  result.requests.enrichment.forEach((r) => assert.match(r.url, /^https:\/\/api\.enrichment-provider\.example\/v1\/companies\/find\?domain=[a-z0-9.-]+$/));
});

test('live pipeline: PATCHes only records with changes and logs results', async () => {
  const result = await H.simulatePipeline({ env: { SANDBOX_MODE: 'false' }, webhookItems: [H.webhookFixture(SECRET)], patchFailures: { 102: { error: { message: 'Property values were not valid' } } } });
  const patched = result.requests.hubspotPatch.map((p) => p.url.split('/').pop()).sort();
  assert.deepEqual(patched, ['101', '102', '103', '104', '106', '107', '109']);
  result.requests.hubspotPatch.forEach((p) => assert.ok(Object.keys(p.body.properties).length > 0));
  assert.equal(result.reports.length, 0, 'no dry-run telemetry in live mode');
  const totals = result.liveLogs.reduce((t, l) => ({ ok: t.ok + l.totals.succeeded, failed: t.failed + l.totals.failed }), { ok: 0, failed: 0 });
  assert.deepEqual(totals, { ok: 6, failed: 1 });
});

test('pipeline handles an empty trigger batch', async () => {
  const result = await H.simulatePipeline({ events: [] });
  assert.deepEqual(result.mapped, []);
  assert.deepEqual(result.reports, []);
});

// ---------------------------------------------------------------------------
// Repository hygiene
// ---------------------------------------------------------------------------

test('repository contains no secrets, live webhooks or non-placeholder email addresses', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (['node_modules', '.git', 'coverage'].includes(e.name)) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|json|md|yml|sh)$|^\.env\.example$|^\.gitignore$|^LICENSE$/.test(e.name)) files.push(full);
    });
  })(ROOT);
  assert.ok(files.length >= 15, `expected repository files, found ${files.length}`);

  const forbidden = [
    ['HubSpot private app token', /pat-(na|eu|ap)\d-[0-9a-f]{8}-/],
    ['Slack token', /xox[abposr]-\d{6,}/],
    ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/],
    ['AWS key', /AKIA[0-9A-Z]{16}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['bearer token', /Bearer [A-Za-z0-9]{24,}/],
  ];
  const allowed = /@([a-z0-9-]+\.)*(example\.(com|org|net)|domain\.com|[a-z0-9-]+\.(example|test|invalid))$/i;
  const publicMailProviders = /@(gmail\.com)$/i; // used only as a blocked-domain test case
  files.forEach((file) => {
    if (file === __filename) return;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    forbidden.forEach(([label, re]) => assert.ok(!re.test(text), `${label} pattern in ${rel}`));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((addr) =>
      assert.ok(allowed.test(addr) || publicMailProviders.test(addr), `non-placeholder email "${addr}" in ${rel}`)
    );
  });
});
