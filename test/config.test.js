'use strict';

/**
 * test/config.test.js
 * Configuration parsing and fail-fast validation (config.validator.js),
 * including the pre-flight CLI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig, ConfigError, ENV_KEYS, DEFAULTS, isPlaceholder, parseIndustryMap, describeConfig, MIN_SECRET_LENGTH } = require('../config.validator');

const ROOT = path.resolve(__dirname, '..');
const LIVE = Object.freeze({
  SANDBOX_MODE: 'false',
  ENRICHMENT_API_BASE_URL: 'https://api.enrichment-provider.example/v1',
  WEBHOOK_SECRET: 'test-only-webhook-secret-0000',
});
const live = (overrides) => loadConfig(Object.assign({}, LIVE, overrides || {}));

test('defaults load with no environment and keep sandbox on', () => {
  const c = loadConfig({});
  assert.equal(c.sandboxMode, true);
  assert.equal(c.enrichment.baseUrl, '');
  assert.deepEqual(c.events.acceptedTypes, ['company.creation']);
  assert.equal(c.mapping.overwriteExisting, false);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.enrichment.paths));
  assert.ok(c.warnings.some((w) => w.includes('ENRICHMENT_API_BASE_URL')));
  assert.ok(c.warnings.some((w) => w.includes('WEBHOOK_SECRET')));
});

test('every default key is declared in ENV_KEYS', () => {
  Object.keys(DEFAULTS).forEach((k) => assert.ok(ENV_KEYS.includes(k), k));
});

test('placeholder values count as unset', () => {
  ['{{ENRICHMENT_API_KEY}}', '{{ WEBHOOK_SECRET }}', 'YOUR_TOKEN', 'your-portal-id', 'REPLACE_ME'].forEach((v) => assert.equal(isPlaceholder(v), true, v));
  ['https://api.enrichment-provider.example', 'secret-value'].forEach((v) => assert.equal(isPlaceholder(v), false, v));
  const c = loadConfig({ ENRICHMENT_API_BASE_URL: '{{ENRICHMENT_API_BASE_URL}}', WEBHOOK_SECRET: '{{WEBHOOK_SECRET}}' });
  assert.equal(c.enrichment.baseUrl, '');
  assert.equal(c.webhook.secret, '');
});

test('valid live configuration', () => {
  const c = live({ EXTRA_PUBLIC_SUFFIXES: 'internal.example', INDUSTRY_MAP_JSON: '{"Fintech Platform":"FINANCIAL_SERVICES"}' });
  assert.equal(c.sandboxMode, false);
  assert.deepEqual(c.domains.extraSuffixes, ['internal.example']);
  assert.equal(c.mapping.industryMap['fintech platform'], 'FINANCIAL_SERVICES');
  assert.deepEqual(c.enrichment.paths.industry, ['category.industry', 'industry', 'industry_name']);
});

test('live mode fails fast without provider URL or webhook secret', () => {
  assert.throws(() => live({ ENRICHMENT_API_BASE_URL: '' }), /ENRICHMENT_API_BASE_URL is not set/);
  assert.throws(() => live({ WEBHOOK_SECRET: '{{WEBHOOK_SECRET}}' }), /WEBHOOK_SECRET is required/);
  assert.throws(() => live({ WEBHOOK_SECRET: 'short' }), new RegExp(`at least ${MIN_SECRET_LENGTH}`));
  const noSecret = live({ WEBHOOK_SECRET: '', REQUIRE_WEBHOOK_SECRET: 'false' });
  assert.ok(noSecret.warnings.some((w) => w.includes('without authentication')));
});

test('all invalid settings are reported together', () => {
  assert.throws(
    () =>
      loadConfig({
        SANDBOX_MODE: 'perhaps',
        MAX_EVENTS_PER_RUN: '0',
        ENRICHMENT_API_BASE_URL: 'http://insecure.example',
        ENRICHMENT_API_PATH: 'no-slash',
        ENRICH_PATH_TECH: 'bad path!',
        EMPLOYEE_RANGE_STRATEGY: 'average',
        TECH_STACK_MAX_ITEMS: '1000',
        HUBSPOT_PROP_STATUS: 'Bad-Name',
        INDUSTRY_MAP_JSON: '{not json',
        EXTRA_PUBLIC_SUFFIXES: 'not a domain',
        WEBHOOK_SECRET_HEADER: 'X Secret',
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      const text = err.problems.join('\n');
      ['SANDBOX_MODE', 'MAX_EVENTS_PER_RUN', 'ENRICHMENT_API_BASE_URL', 'ENRICHMENT_API_PATH', 'ENRICH_PATH_TECH', 'EMPLOYEE_RANGE_STRATEGY', 'TECH_STACK_MAX_ITEMS', 'snake_case', 'INDUSTRY_MAP_JSON', 'not a domain', 'WEBHOOK_SECRET_HEADER'].forEach(
        (needle) => assert.ok(text.includes(needle), `missing problem for ${needle}`)
      );
      return true;
    }
  );
});

test('parseIndustryMap validates targets', () => {
  const problems = [];
  const map = parseIndustryMap('{"A": "BANKING", "b": "not valid"}', problems);
  assert.deepEqual({ ...map }, { a: 'BANKING' });
  assert.equal(problems.length, 1);
  const arrayProblems = [];
  parseIndustryMap('[1,2]', arrayProblems);
  assert.equal(arrayProblems.length, 1);
});

test('describeConfig never exposes the webhook secret', () => {
  const summary = describeConfig(live());
  assert.equal(summary.webhookSecret, 'set');
  assert.ok(!JSON.stringify(summary).includes(LIVE.WEBHOOK_SECRET));
  assert.equal(summary.mode, 'LIVE');
});

test('CLI validates .env.example (sandbox template) successfully', () => {
  const res = spawnSync(process.execPath, ['config.validator.js', '--env-path', '.env.example'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /configuration is valid/);
  assert.match(res.stdout, /SANDBOX/);
});

test('CLI exits non-zero on invalid configuration and on a missing file', () => {
  const bad = spawnSync(process.execPath, ['config.validator.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SANDBOX_MODE: 'false' },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /ENRICHMENT_API_BASE_URL/);
  const missing = spawnSync(process.execPath, ['config.validator.js', '--env-path', 'does-not-exist.env'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(missing.status, 2);
});
