'use strict';

/**
 * src/router.js
 * ---------------------------------------------------------------------------
 * Event intake, extraction stage and telemetry for the enrichment router.
 *
 *   HubSpot Trigger / Webhook items ──► normalizeEvents()      verify secret, dedupe, cap
 *   HubSpot company record          ──► prepareEnrichment()    root domain + skip decisions
 *   Mapper output (company_update)  ──► buildDryRunReport()    sandbox telemetry
 *   HubSpot PATCH responses         ──► summarizeUpdateResults() live run log
 *
 * Depends on src/domain.js (Domain) and src/mapper.js (Mapper). In Node these
 * are passed in by the caller; in n8n the build script provides them as the
 * module-level `Domain` and `Mapper` objects. No require() calls.
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

const REJECT_REASONS = Object.freeze({
  INVALID_ITEM: 'INVALID_ITEM',
  WEBHOOK_SECRET_MISSING: 'WEBHOOK_SECRET_MISSING',
  WEBHOOK_SECRET_MISMATCH: 'WEBHOOK_SECRET_MISMATCH',
  EVENT_TYPE_NOT_ACCEPTED: 'EVENT_TYPE_NOT_ACCEPTED',
  MISSING_COMPANY_ID: 'MISSING_COMPANY_ID',
  DUPLICATE: 'DUPLICATE',
  RUN_LIMIT_REACHED: 'RUN_LIMIT_REACHED',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strip emails, bearer tokens, HubSpot / Slack tokens and secrets from free text. */
function redact(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted-token]')
    .replace(/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/([?&](?:api_?key|key|token|access_token|secret)=)[^&\s]+/gi, '$1[redacted]');
}

/** Constant-time string comparison (avoids leaking the secret through timing). */
function safeEqual(a, b) {
  const x = String(a === undefined || a === null ? '' : a);
  const y = String(b === undefined || b === null ? '' : b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

function headerValue(headers, name) {
  if (!isPlainObject(headers)) return undefined;
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === target);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

/** HubSpot sends property values either flat or as { value: ... }. */
function unwrap(value) {
  return isPlainObject(value) && 'value' in value ? value.value : value;
}

function extractCompanyId(event) {
  if (!isPlainObject(event)) return null;
  const props = isPlainObject(event.properties) ? event.properties : {};
  const candidates = [event.objectId, event.companyId, event.hs_object_id, unwrap(props.hs_object_id), event.id, event.vid];
  for (const c of candidates) {
    const id = String(c === undefined || c === null ? '' : c).trim();
    if (/^\d{1,20}$/.test(id)) return id;
  }
  return null;
}

/**
 * Turn raw trigger / webhook items into a de-duplicated list of company IDs.
 * @param {object[]} itemJsons n8n item JSON objects.
 * @param {object} config From loadConfig().
 * @returns {{ companies: object[], rejected: object[], unverifiedWebhook: boolean }}
 */
function normalizeEvents(itemJsons, config) {
  const companies = [];
  const rejected = [];
  const seen = {};
  let unverifiedWebhook = false;
  const list = Array.isArray(itemJsons) ? itemJsons : [];

  const accept = (event, source) => {
    const type = isPlainObject(event) && event.subscriptionType ? String(event.subscriptionType).toLowerCase() : null;
    if (type && config.events.acceptedTypes.indexOf(type) === -1) {
      rejected.push({ source, reason: REJECT_REASONS.EVENT_TYPE_NOT_ACCEPTED, eventType: type });
      return;
    }
    const companyId = extractCompanyId(event);
    if (!companyId) {
      rejected.push({ source, reason: REJECT_REASONS.MISSING_COMPANY_ID });
      return;
    }
    if (seen[companyId]) {
      rejected.push({ source, reason: REJECT_REASONS.DUPLICATE, companyId });
      return;
    }
    if (companies.length >= config.events.maxPerRun) {
      rejected.push({ source, reason: REJECT_REASONS.RUN_LIMIT_REACHED, companyId });
      return;
    }
    seen[companyId] = true;
    companies.push({
      stage: 'event',
      companyId,
      source,
      eventType: type || 'webhook',
      occurredAt: isPlainObject(event) && event.occurredAt ? event.occurredAt : null,
      sandbox: Boolean(config.sandboxMode),
    });
  };

  list.forEach((item) => {
    if (!isPlainObject(item)) {
      rejected.push({ source: 'unknown', reason: REJECT_REASONS.INVALID_ITEM });
      return;
    }
    const isWebhook = isPlainObject(item.headers) && 'body' in item;
    if (!isWebhook) {
      accept(item, 'hubspot_trigger');
      return;
    }

    // Webhook path: authenticate before reading the body.
    const provided = headerValue(item.headers, config.webhook.header);
    if (config.webhook.secret) {
      if (provided === undefined || provided === '') {
        rejected.push({ source: 'webhook', reason: REJECT_REASONS.WEBHOOK_SECRET_MISSING });
        return;
      }
      if (!safeEqual(provided, config.webhook.secret)) {
        rejected.push({ source: 'webhook', reason: REJECT_REASONS.WEBHOOK_SECRET_MISMATCH });
        return;
      }
    } else if (config.webhook.requireSecret && !config.sandboxMode) {
      // Defensive: loadConfig() already fails fast in this state.
      rejected.push({ source: 'webhook', reason: REJECT_REASONS.WEBHOOK_SECRET_MISSING });
      return;
    } else {
      unverifiedWebhook = true;
    }

    const body = item.body;
    const events = Array.isArray(body) ? body : Array.isArray(body && body.events) ? body.events : [body];
    events.forEach((event) => accept(event, 'webhook'));
  });

  return { companies, rejected, unverifiedWebhook };
}

/** Summarize rejections by reason (no payload content). */
function countBy(list, key) {
  const out = {};
  (list || []).forEach((entry) => (out[entry[key]] = (out[entry[key]] || 0) + 1));
  return out;
}

/**
 * Decide whether a fetched HubSpot company should be enriched.
 * @param {object} companyJson Response of GET /crm/v3/objects/companies/{id} (or an n8n error item).
 * @param {object} eventJson The paired event item from normalizeEvents().
 * @param {object} config
 * @param {{ Domain: object, Mapper: object }} deps
 */
function prepareEnrichment(companyJson, eventJson, config, deps) {
  const Domain = deps.Domain;
  const STATUS = deps.Mapper.STATUS;
  const event = isPlainObject(eventJson) ? eventJson : {};
  const company = isPlainObject(companyJson) ? companyJson : {};
  const props = config.hubspot.props;
  const base = {
    stage: 'extracted',
    companyId: String(company.id || event.companyId || '') || null,
    source: event.source || null,
    sandbox: Boolean(config.sandboxMode),
    shouldEnrich: false,
    rootDomain: null,
    domainField: null,
    enrichmentUrl: null,
    skipStatus: null,
    skipReason: null,
    currentProperties: {},
  };

  if (company.error || !isPlainObject(company.properties)) {
    const err = company.error;
    const message = isPlainObject(err) ? err.message || err.description : err;
    return Object.assign(base, {
      skipStatus: STATUS.ERROR_HUBSPOT_FETCH,
      skipReason: redact(String(message || 'Company record could not be fetched')).slice(0, 200),
    });
  }

  const p = company.properties;
  // Keep only the properties the mapper needs (no names, owners or contact data).
  ['domain', 'industry', 'numberofemployees', props.techStack, props.industryRaw, props.status, props.rootDomain].forEach((name) => {
    if (p[name] !== undefined && p[name] !== null) base.currentProperties[name] = p[name];
  });

  if (!config.mapping.forceReenrich && String(p[props.status] || '').toUpperCase() === STATUS.ENRICHED) {
    return Object.assign(base, { skipStatus: STATUS.SKIPPED_ALREADY_ENRICHED, skipReason: 'Company already enriched (set FORCE_REENRICH=true to refresh)' });
  }

  const picked = Domain.pickCompanyDomain(p, { extraSuffixes: config.domains.extraSuffixes, extraBlocked: config.domains.extraBlocked });
  if (!picked.ok) {
    const R = Domain.REASONS;
    const skipStatus =
      picked.reason === R.EMPTY ? STATUS.SKIPPED_NO_DOMAIN : picked.reason === R.BLOCKED_DOMAIN ? STATUS.SKIPPED_BLOCKED_DOMAIN : STATUS.SKIPPED_INVALID_DOMAIN;
    return Object.assign(base, {
      domainField: picked.field,
      rootDomain: picked.reason === R.BLOCKED_DOMAIN ? picked.rootDomain : null,
      skipStatus,
      skipReason: picked.reason,
    });
  }

  base.rootDomain = picked.rootDomain;
  base.domainField = picked.field;
  if (!config.enrichment.baseUrl) {
    return Object.assign(base, { skipStatus: STATUS.SKIPPED_NO_PROVIDER, skipReason: 'ENRICHMENT_API_BASE_URL is not configured' });
  }
  base.shouldEnrich = true;
  base.enrichmentUrl = `${config.enrichment.baseUrl}${config.enrichment.path}?${encodeURIComponent(config.enrichment.domainParam)}=${encodeURIComponent(picked.rootDomain)}`;
  return base;
}

/** Domain for logs, masked when LOG_DOMAINS=false. */
function logDomain(domain, config, Domain) {
  if (!domain) return '-';
  return config.logging.logDomains ? domain : Domain.maskDomain(domain);
}

/**
 * Sandbox telemetry: what WOULD be written to HubSpot, without writing it.
 * @param {object[]} updates company_update objects from Mapper.buildCompanyUpdate().
 */
function buildDryRunReport(updates, config, deps, meta) {
  const list = (Array.isArray(updates) ? updates : []).filter((u) => isPlainObject(u) && u.kind === 'company_update');
  const info = meta || {};
  const byStatus = countBy(list, 'status');
  const planned = list.filter((u) => u.hasUpdate);
  const lines = [
    `[enrichment-router] DRY RUN${info.runId ? ` run=${info.runId}` : ''} companies=${list.length} plannedUpdates=${planned.length}`,
    `[enrichment-router] statuses ${Object.keys(byStatus)
      .sort()
      .map((k) => `${k}=${byStatus[k]}`)
      .join(' ') || '(none)'}`,
  ];
  list.forEach((u) => {
    lines.push(
      `[enrichment-router]   company=${u.companyId || '-'} domain=${logDomain(u.rootDomain, config, deps.Domain)} status=${u.status}` +
        ` write=[${Object.keys(u.properties || {}).join(',')}] preserved=[${(u.preserved || []).map((p) => p.property).join(',')}]` +
        `${u.httpStatus && u.httpStatus !== 200 ? ` http=${u.httpStatus}` : ''}`
    );
  });
  return {
    kind: 'dry_run_report',
    mode: 'SANDBOX',
    runId: info.runId || null,
    totals: { companies: list.length, plannedUpdates: planned.length, preservedFields: list.reduce((n, u) => n + (u.preserved || []).length, 0) },
    byStatus,
    planned: planned.map((u) => ({ companyId: u.companyId, status: u.status, properties: Object.keys(u.properties) })),
    lines: lines.map(redact),
  };
}

/**
 * Live run log: pair HubSpot PATCH responses with the updates that produced them.
 * @param {object[]} responses n8n item JSON from the HubSpot Update Company node.
 * @param {object[]} updates   Matching company_update objects (same order).
 */
function summarizeUpdateResults(responses, updates, meta) {
  const res = Array.isArray(responses) ? responses : [];
  const upd = Array.isArray(updates) ? updates : [];
  const results = res.map((r, i) => {
    const u = upd[i] || {};
    const failed = !isPlainObject(r) || Boolean(r.error);
    const err = failed && isPlainObject(r) ? r.error : null;
    return {
      companyId: u.companyId || (isPlainObject(r) && r.id ? String(r.id) : null),
      status: u.status || null,
      written: failed ? [] : Object.keys(u.properties || {}),
      ok: !failed,
      error: failed ? redact(isPlainObject(err) ? err.message || 'Update failed' : err || 'Invalid response').slice(0, 200) : null,
    };
  });
  return {
    kind: 'live_run_log',
    mode: 'LIVE',
    runId: (meta && meta.runId) || null,
    totals: { attempted: results.length, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
    results,
  };
}

module.exports = {
  REJECT_REASONS,
  redact,
  safeEqual,
  extractCompanyId,
  normalizeEvents,
  countBy,
  prepareEnrichment,
  buildDryRunReport,
  summarizeUpdateResults,
};
