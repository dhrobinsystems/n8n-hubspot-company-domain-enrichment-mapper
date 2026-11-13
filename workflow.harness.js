#!/usr/bin/env node
'use strict';

/**
 * workflow.harness.js
 * ---------------------------------------------------------------------------
 * Offline validation harness for workflow.json.
 *
 * It executes the generated n8n Code nodes inside an isolated VM context that
 * mimics the n8n Code node runtime ($input, $json, $env, $execution, $()),
 * and replays the whole pipeline against the mock payloads in test/fixtures.
 * HTTP nodes (HubSpot GET / PATCH, enrichment API) are replaced by fixture
 * lookups, so no network calls are made and no credentials are needed.
 *
 *   node workflow.harness.js           sandbox simulation (default)
 *   node workflow.harness.js --live    simulate live mode with mocked PATCH calls
 *   node workflow.harness.js --json    print the full result as JSON
 *
 * Also used by test/workflow.test.js (exports runCodeNode and simulatePipeline).
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

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/** Test-only values. Never real endpoints or secrets. */
const HARNESS_ENV = Object.freeze({
  SANDBOX_MODE: 'true',
  ENRICHMENT_API_BASE_URL: 'https://api.enrichment-provider.example/v1',
  WEBHOOK_SECRET: 'test-only-webhook-secret-0000',
  ENRICHMENT_PROVIDER_NAME: 'mock-provider',
});

function loadWorkflow(file) {
  return JSON.parse(fs.readFileSync(file || path.join(ROOT, 'workflow.json'), 'utf8'));
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** JSON round-trip so objects created inside the VM compare cleanly outside it. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`Node "${name}" not found in workflow`);
  return node;
}

/** Build the $('Node') accessor backed by arrays of paired item JSON. */
function makeNodeAccessor(paired, currentIndex) {
  return (nodeName) => {
    const list = (paired && paired[nodeName]) || [];
    const wrap = (json) => (json === undefined ? undefined : { json });
    return {
      get item() {
        if (list[currentIndex] === undefined) throw new Error(`No paired item for "${nodeName}" at index ${currentIndex}`);
        return wrap(list[currentIndex]);
      },
      itemMatching(i) {
        if (list[i] === undefined) throw new Error(`No paired item for "${nodeName}" at index ${i}`);
        return wrap(list[i]);
      },
      all: () => list.map(wrap),
      first: () => wrap(list[0]),
    };
  };
}

/**
 * Execute one Code node the way n8n does.
 * @param {object} workflow Parsed workflow.json.
 * @param {string} name Code node name.
 * @param {object[]} inputJsons Input item JSON.
 * @param {{ env?: object, blockEnv?: boolean, executionId?: string, paired?: Record<string, object[]> }} [options]
 * @returns {Promise<{ output: object[], logs: string[] }>}
 */
async function runCodeNode(workflow, name, inputJsons, options) {
  const opts = options || {};
  const node = getNode(workflow, name);
  if (node.type !== 'n8n-nodes-base.code') throw new Error(`"${name}" is not a Code node`);
  const code = node.parameters.jsCode;
  const items = (inputJsons || []).map((json) => ({ json }));
  const logs = [];
  const eachItem = node.parameters.mode === 'runOnceForEachItem';

  const baseContext = (index) => {
    const ctx = {
      $execution: { id: opts.executionId || 'harness-exec-1' },
      $input: {
        all: () => items,
        first: () => items[0],
        last: () => items[items.length - 1],
        item: items[index],
      },
      $: makeNodeAccessor(opts.paired, index),
      console: { log: (...args) => logs.push(args.join(' ')), warn: () => {}, error: () => {} },
    };
    if (eachItem) ctx.$json = items[index] ? items[index].json : undefined;
    if (opts.blockEnv) {
      Object.defineProperty(ctx, '$env', {
        get() {
          throw new Error('access to env vars denied');
        },
      });
    } else {
      ctx.$env = opts.env || {};
    }
    return ctx;
  };

  const run = (ctx) => vm.runInNewContext(`(async () => {\n${code}\n})()`, ctx, { timeout: 5000 });

  if (!eachItem) {
    const result = await run(baseContext(0));
    return { output: plain(result) || [], logs };
  }
  const output = [];
  for (let i = 0; i < items.length; i += 1) {
    const result = plain(await run(baseContext(i)));
    if (result) output.push(result);
  }
  return { output, logs };
}

/**
 * Replay the full workflow against fixtures, following workflow.json's routing:
 * events -> normalize -> GET company -> extract -> (enrich | skip) -> map ->
 * (dry-run telemetry | has changes -> PATCH -> log). The map node and everything
 * after it runs once per incoming branch, exactly as n8n's v1 execution order does.
 */
async function simulatePipeline(input) {
  const opts = input || {};
  const workflow = opts.workflow || loadWorkflow();
  const env = Object.assign({}, HARNESS_ENV, opts.env || {});
  const companies = opts.companies || loadFixture('hubspot-companies.json').companies;
  const enrichment = opts.enrichment || loadFixture('enrichment-responses.json').responses;
  const triggerItems = opts.events !== undefined ? opts.events : loadFixture('hubspot-trigger-events.json').events;
  const webhookItems = opts.webhookItems || [];
  const logs = [];
  const requests = { hubspotGet: [], enrichment: [], hubspotPatch: [] };

  const normalized = await runCodeNode(workflow, 'Normalize & Verify Events', triggerItems.concat(webhookItems), { env });
  logs.push(...normalized.logs);

  const fetched = normalized.output.map((item) => {
    requests.hubspotGet.push({ url: item.json.companyUrl, properties: item.json.requestProperties });
    return companies[item.json.companyId] || { error: { message: 'Request failed with status code 404', httpCode: '404' } };
  });

  const extracted = await runCodeNode(workflow, 'Extract Root Domain', fetched, {
    env,
    paired: { 'Normalize & Verify Events': normalized.output.map((i) => i.json) },
  });

  const toEnrich = extracted.output.filter((i) => i.json.shouldEnrich === true).map((i) => i.json);
  const skipped = extracted.output.filter((i) => i.json.shouldEnrich !== true).map((i) => i.json);

  const enrichmentResults = toEnrich.map((ctx) => {
    requests.enrichment.push({ url: ctx.enrichmentUrl });
    return enrichment[ctx.rootDomain] || { error: { message: 'Request failed with status code 404', httpCode: '404' } };
  });

  // Branch runs (n8n runs the Map node once per incoming branch that has data).
  const branchRuns = [];
  if (enrichmentResults.length > 0) {
    branchRuns.push(await runCodeNode(workflow, 'Map Enrichment to HubSpot', enrichmentResults, { env, paired: { 'Extract Root Domain': toEnrich } }));
  }
  if (skipped.length > 0) {
    branchRuns.push(await runCodeNode(workflow, 'Map Enrichment to HubSpot', skipped, { env }));
  }

  const mapped = [];
  const reports = [];
  const liveLogs = [];
  for (const run of branchRuns) {
    const updates = run.output.map((i) => i.json);
    mapped.push(...updates);
    const sandboxItems = updates.filter((u) => u.sandbox === true);
    const liveItems = updates.filter((u) => u.sandbox !== true);

    if (sandboxItems.length > 0) {
      const report = await runCodeNode(workflow, 'Dry-Run Telemetry', sandboxItems, { env });
      reports.push(...report.output.map((i) => i.json));
      logs.push(...report.logs);
    }
    const changed = liveItems.filter((u) => u.hasUpdate === true);
    if (changed.length > 0) {
      const responses = changed.map((u) => {
        requests.hubspotPatch.push({ url: u.updateUrl, body: { properties: u.properties } });
        const failure = opts.patchFailures && opts.patchFailures[u.companyId];
        return failure || { id: u.companyId, properties: Object.assign({}, u.properties), updatedAt: '2026-01-01T00:00:00.000Z' };
      });
      const log = await runCodeNode(workflow, 'Log Update Results', responses, { env, paired: { 'Map Enrichment to HubSpot': changed } });
      liveLogs.push(...log.output.map((i) => i.json));
      logs.push(...log.logs);
    }
  }

  return {
    normalized: normalized.output.map((i) => i.json),
    extracted: extracted.output.map((i) => i.json),
    mapped,
    reports,
    liveLogs,
    requests,
    logs,
  };
}

/** Webhook fixture with the placeholder header swapped for a given secret. */
function webhookFixture(secret) {
  const item = loadFixture('webhook-payload.json').item;
  item.headers['x-webhook-secret'] = secret;
  return item;
}

async function main(argv) {
  const args = new Set(argv);
  const env = args.has('--live') ? { SANDBOX_MODE: 'false' } : {};
  const result = await simulatePipeline({ env, webhookItems: [webhookFixture(HARNESS_ENV.WEBHOOK_SECRET)] });

  if (args.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`Mode: ${args.has('--live') ? 'LIVE (mocked HubSpot PATCH)' : 'SANDBOX'}`);
  console.log(`Events accepted: ${result.normalized.length}`);
  console.log(`Enrichment lookups: ${result.requests.enrichment.length}`);
  console.log(`HubSpot PATCH requests: ${result.requests.hubspotPatch.length}`);
  console.log('');
  console.log('company  status                     root domain            properties written');
  result.mapped
    .slice()
    .sort((a, b) => Number(a.companyId) - Number(b.companyId))
    .forEach((u) => {
      console.log(`${String(u.companyId).padEnd(8)} ${String(u.status).padEnd(26)} ${String(u.rootDomain || '-').padEnd(22)} ${Object.keys(u.properties || {}).join(', ') || '-'}`);
    });
  console.log('');
  result.logs.forEach((line) => console.log(line));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => (process.exitCode = code))
    .catch((err) => {
      console.error(`Harness failed: ${err.stack || err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { HARNESS_ENV, loadWorkflow, loadFixture, runCodeNode, simulatePipeline, webhookFixture, plain };
