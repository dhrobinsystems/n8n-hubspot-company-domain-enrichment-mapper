# n8n-hubspot-company-domain-enrichment-mapper

An asynchronous enrichment router for [n8n](https://n8n.io). When a company is created in HubSpot, it extracts the company's root domain, queries a company-metadata API for **industry**, **employee count** and **tech stack**, and maps the results back onto HubSpot company properties, without overwriting data your team already entered.

![CI](https://github.com/dhrobinsystems/n8n-hubspot-company-domain-enrichment-mapper/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933)
![Dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of contents

1. [Architecture overview](#architecture-overview)
2. [Root-domain extraction](#root-domain-extraction)
3. [Data mapping](#data-mapping)
4. [Enrichment status and fallback states](#enrichment-status-and-fallback-states)
5. [Repository layout](#repository-layout)
6. [Prerequisites](#prerequisites)
7. [Environment variables](#environment-variables)
8. [HubSpot setup](#hubspot-setup)
9. [Enrichment provider setup](#enrichment-provider-setup)
10. [Deployment steps](#deployment-steps)
11. [Testing protocols](#testing-protocols)
12. [Resilience and error handling](#resilience-and-error-handling)
13. [Security and privacy](#security-and-privacy)
14. [Troubleshooting](#troubleshooting)
15. [Disclaimer](#️-disclaimer--liability-limitation)
16. [License](#license)

---

## Architecture overview

```mermaid
flowchart LR
    T["HubSpot Company Created<br/>(HubSpot Trigger: company.creation)"] --> N
    W["Company Created Webhook<br/>(responds immediately)"] --> N
    N["Normalize & Verify Events<br/>config fail-fast · secret check · dedupe"] --> G["HubSpot Get Company<br/>(HTTP GET)"]
    G --> X["Extract Root Domain<br/>normalize · skip rules"]
    X --> E{Domain Enrichable?}
    E -- yes --> A["Enrichment API Lookup<br/>(HTTP GET, Header Auth)"]
    E -- no --> M
    A --> M["Map Enrichment to HubSpot<br/>industry · employees · tech stack"]
    M --> S{Sandbox Mode?}
    S -- true --> D["Dry-Run Telemetry<br/>(log only)"]
    S -- false --> C{Has Property Changes?}
    C -- yes --> U["HubSpot Update Company<br/>(HTTP PATCH)"]
    U --> L["Log Update Results"]
```

**Why it is asynchronous.** The webhook entry point acknowledges HubSpot immediately (`responseMode: onReceived`) and does the work afterwards. Both entry points accept batches, and every HTTP call is batched (5 requests per second) and retried, so a bulk import of companies is processed without blocking HubSpot or exceeding rate limits.

**Single source of truth.** All logic lives in four dependency-free modules. `scripts/build-workflow.js` inlines them into the n8n Code nodes, so what runs in n8n is exactly what the tests cover. CI fails if `workflow.json` drifts from the source.

| Module | Responsibility |
| --- | --- |
| `config.validator.js` | Parses and validates every environment variable; collects all problems into one `ConfigError`; doubles as a pre-flight CLI. |
| `src/domain.js` | URL / hostname / email → root domain; multi-part suffixes; personal-domain blocklist. |
| `src/mapper.js` | Classifies API responses; maps industry, employee count and tech stack; applies the overwrite policy. |
| `src/router.js` | Event intake and webhook-secret check, extraction stage, dry-run and live telemetry. |

### Node-by-node

| Node | Type | Purpose |
| --- | --- | --- |
| HubSpot Company Created | HubSpot Trigger | Receives `company.creation` events from a HubSpot developer app. |
| Company Created Webhook | Webhook | Alternative entry for a HubSpot workflow "Send a webhook" action. |
| Normalize & Verify Events | Code (all items) | Validates config, verifies the webhook secret, filters event types, dedupes company IDs, caps batch size. |
| HubSpot Get Company | HTTP Request | `GET /crm/v3/objects/companies/{id}` with only the properties the router needs. |
| Extract Root Domain | Code (each item) | Picks `domain` → `website` → `hs_additional_domains`, normalizes, decides skip reasons. |
| Domain Enrichable? | IF | Sends enrichable companies to the API; everything else goes straight to the mapper. |
| Enrichment API Lookup | HTTP Request | `GET {base}{path}?domain=<root>` with Header Auth. Errors continue as items. |
| Map Enrichment to HubSpot | Code (each item) | Builds the PATCH body and status from the response (or skip reason). |
| Sandbox Mode? | IF | `SANDBOX_MODE=true` → dry run; otherwise live. |
| Dry-Run Telemetry | Code (all items) | Logs what would be written. Nothing is sent to HubSpot. |
| Has Property Changes? | IF | Skips PATCH calls that would change nothing. |
| HubSpot Update Company | HTTP Request | `PATCH /crm/v3/objects/companies/{id}`. |
| Log Update Results | Code (all items) | Sanitized success / failure summary per company. |

---

## Root-domain extraction

`src/domain.js` reduces any URL, hostname or email address to its registrable root domain:

| Input | Root domain |
| --- | --- |
| `http://www.example.com/path` | `example.com` |
| `HTTP://WWW.Example.COM:8080/a?q=1#top` | `example.com` |
| `https://blog.eu.example.com/post` | `example.com` |
| `jane.doe@sales.example.com` | `example.com` |
| `https://user:pass@www.example.com:443/x` | `example.com` |
| `https://shop.acme-widgets.co.uk/en` | `acme-widgets.co.uk` |
| `https://acme.myshopify.com/collections` | `acme.myshopify.com` |
| `https://www.xn--mnchen-3ya.de/` | `xn--mnchen-3ya.de` |

**Steps:** strip scheme, protocol-relative prefix, `mailto:`, userinfo, port, path, query, fragment and trailing dots; lowercase; drop `www` / `www2`; validate every label; then find the longest matching multi-part suffix (country second-level domains such as `co.uk`, `com.au`, `co.jp`, and hosting platforms such as `github.io`, `myshopify.com`, `netlify.app`) and keep one label in front of it.

**Rejected inputs** (each returns a reason code that becomes the skip status):

| Reason | Example | Status written |
| --- | --- | --- |
| `EMPTY` | blank domain and website | `SKIPPED_NO_DOMAIN` |
| `IP_ADDRESS` | `http://192.168.1.10`, `[2001:db8::1]` | `SKIPPED_INVALID_DOMAIN` |
| `SINGLE_LABEL` | `localhost`, `http://intranet/` | `SKIPPED_INVALID_DOMAIN` |
| `INVALID_HOSTNAME` / `INVALID_TLD` | `bad_name.example.com`, `example.c0m` | `SKIPPED_INVALID_DOMAIN` |
| `PUBLIC_SUFFIX_ONLY` | `co.uk` | `SKIPPED_INVALID_DOMAIN` |
| `BLOCKED_DOMAIN` | `gmail.com`, `outlook.com`, `linkedin.com` | `SKIPPED_BLOCKED_DOMAIN` |

The built-in suffix list covers the common cases rather than the full Public Suffix List. Add your own with `EXTRA_PUBLIC_SUFFIXES`, and extra never-enrich domains with `EXTRA_BLOCKED_DOMAINS`.

---

## Data mapping

| Enrichment field | Read from (configurable) | HubSpot property | Rule |
| --- | --- | --- | --- |
| Industry | `category.industry` \| `industry` \| `industry_name` | `industry` (dropdown) | Translated to a HubSpot industry option by exact synonym, then keyword, then `INDUSTRY_MAP_JSON`. **Unknown values never reach the dropdown.** |
| Industry (raw text) | same | `enriched_industry_raw` | Always stored as provided (cleaned, max 200 chars). |
| Employee count | `metrics.employees` \| `employee_count` \| `employees` \| `headcount`, then `metrics.employeesRange` \| `employee_range` \| `size` | `numberofemployees` | Parses `250`, `"1,200"`, `"1.2k"`, `"10K+"`, `"51-200"`, `{min,max}`. Ranges use `EMPLOYEE_RANGE_STRATEGY` (default midpoint: `51-200` → `126`). Junk → not written. |
| Tech stack | `tech` \| `technologies` \| `tech_stack` | `enriched_tech_stack` | Accepts strings, `{name}` objects, delimited text or category maps; trimmed, de-duplicated (case-insensitive), sorted, capped at `TECH_STACK_MAX_ITEMS`, joined with `; `. |
| Root domain | normalized | `domain` | Written only when `domain` is empty and `WRITE_NORMALIZED_DOMAIN=true`. |
| Bookkeeping | | `enrichment_root_domain`, `enrichment_status`, `enrichment_last_run_at`, `enrichment_source` | Written on every run, so failures are visible and re-runnable from HubSpot views. |

**Overwrite policy.** With `OVERWRITE_EXISTING=false` (default) the router only fills empty fields. Values your team already entered are reported in `preserved` and left alone. Set `OVERWRITE_EXISTING=true` only if the provider should be the source of truth.

**Response shapes.** The mapper auto-unwraps `{ "data": {...}, "meta": {...} }` envelopes. For other shapes, point `ENRICH_RESPONSE_ROOT` at the company object (e.g. `result.company`; arrays use their first element) and adjust the `ENRICH_PATH_*` variables.

---

## Enrichment status and fallback states

| `enrichment_status` | Meaning | Written to HubSpot |
| --- | --- | --- |
| `ENRICHED` | Industry (mapped), employees and tech stack all found | Data + status |
| `PARTIAL` | Some fields found (or industry text could not be mapped) | Data + status |
| `NO_CHANGES` | Provider data matches the record | Status only |
| `NOT_FOUND` | 404 / 422, empty body, or no usable fields | Status only |
| `RATE_LIMITED` | 429 after retries; safe to re-run later | Status only |
| `ERROR_AUTH` | 401 / 403 from the provider (check the credential) | Status only |
| `ERROR_PROVIDER` | 5xx, timeout or malformed response | Status only |
| `SKIPPED_NO_DOMAIN` / `SKIPPED_INVALID_DOMAIN` / `SKIPPED_BLOCKED_DOMAIN` | No usable domain | Status only |
| `SKIPPED_NO_PROVIDER` | `ENRICHMENT_API_BASE_URL` not configured (sandbox only) | Status only |
| `SKIPPED_ALREADY_ENRICHED` | Already `ENRICHED` and `FORCE_REENRICH=false` | **Nothing** |
| `ERROR_HUBSPOT_FETCH` | Company could not be read from HubSpot | **Nothing** |
| `ERROR_INTERNAL` | Unexpected engine error (caught) | Status only |

Build a HubSpot company view filtered on `enrichment_status` (`RATE_LIMITED`, `ERROR_*`) to find records that need a retry or a fix.

---

## Repository layout

```
n8n-hubspot-company-domain-enrichment-mapper/
├── .github/workflows/ci.yml      # Runs build.sh --check on Node 20 and 22
├── config.validator.js           # Env validation (module + pre-flight CLI)
├── workflow.harness.js           # Offline harness: runs the Code nodes against mock payloads
├── build.sh                      # Validate → lint → build → secret scan → tests → harness
├── scripts/build-workflow.js     # Compiles the modules into workflow.json
├── src/
│   ├── domain.js                 # Root-domain extraction and normalization
│   ├── mapper.js                 # Response classification and HubSpot mapping
│   └── router.js                 # Event intake, extraction stage, telemetry
├── test/
│   ├── fixtures/                 # Synthetic HubSpot, webhook and provider payloads
│   ├── domain.test.js
│   ├── mapper.test.js
│   ├── config.test.js
│   └── workflow.test.js          # Structure + end-to-end pipeline via the harness
├── workflow.json                 # Importable n8n workflow (generated)
├── .env.example                  # Configuration template (SANDBOX_MODE=true)
├── .gitignore
├── DISCLAIMER.md
├── LICENSE
├── package.json                  # Zero dependencies
└── README.md
```

---

## Prerequisites

- **n8n 1.x** (self-hosted or cloud) with HubSpot Trigger, Webhook v2, Code v2, IF v2 and HTTP Request v4.2 nodes.
- **Node.js ≥ 20** and **bash** for local validation (no npm packages).
- **HubSpot**: a private app (company read/write) and, for the trigger entry point, a developer app subscribed to `company.creation`. A HubSpot developer test account is recommended for staging.
- **A company-metadata API** that accepts a domain and returns JSON with industry, employee and technology fields, plus an API key you can send as a header.

---

## Environment variables

Copy `.env.example` to `.env`, replace the `{{PLACEHOLDER}}` values and load it into the n8n process. Code nodes read variables through `$env`, which requires `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. If env access is blocked, the router runs on its defaults, including `SANDBOX_MODE=true`.

> **Credentials are not environment variables here.** `{{HUBSPOT_ACCESS_TOKEN}}` and `{{ENRICHMENT_API_KEY}}` belong in the n8n credential store (HubSpot App Token and Header Auth). The only secret the Code nodes read is `WEBHOOK_SECRET`, and it is never logged or returned.

| Variable | Default | Description |
| --- | --- | --- |
| `SANDBOX_MODE` | `true` | `true` = dry run (no HubSpot writes). `false` = live. |
| `WEBHOOK_SECRET` | *(unset)* | Shared secret for the webhook entry (min 16 chars). Required live when `REQUIRE_WEBHOOK_SECRET=true`. |
| `WEBHOOK_SECRET_HEADER` | `x-webhook-secret` | Header carrying the secret. |
| `REQUIRE_WEBHOOK_SECRET` | `true` | Reject unauthenticated webhook calls. |
| `ACCEPTED_EVENT_TYPES` | `company.creation` | Comma-separated HubSpot subscription types. |
| `MAX_EVENTS_PER_RUN` | `100` | Cap on companies per execution (1–1000). |
| `HUBSPOT_API_BASE_URL` | `https://api.hubapi.com` | HubSpot API base. |
| `HUBSPOT_PROP_TECH_STACK` | `enriched_tech_stack` | Custom property for the tech stack. |
| `HUBSPOT_PROP_INDUSTRY_RAW` | `enriched_industry_raw` | Custom property for raw industry text. |
| `HUBSPOT_PROP_STATUS` | `enrichment_status` | Custom property for the status. |
| `HUBSPOT_PROP_LAST_RUN` | `enrichment_last_run_at` | Custom property for the last run time. |
| `HUBSPOT_PROP_ROOT_DOMAIN` | `enrichment_root_domain` | Custom property for the normalized domain. |
| `HUBSPOT_PROP_SOURCE` | `enrichment_source` | Custom property for the provider name. |
| `ENRICHMENT_API_BASE_URL` | `{{ENRICHMENT_API_BASE_URL}}` | Provider base URL (https). Required live. |
| `ENRICHMENT_API_PATH` | `/companies/find` | Lookup path. |
| `ENRICHMENT_DOMAIN_PARAM` | `domain` | Query parameter that carries the domain. |
| `ENRICHMENT_PROVIDER_NAME` | `generic` | Written to `enrichment_source`. |
| `ENRICH_RESPONSE_ROOT` | *(auto)* | Dot path to the company object in the response. |
| `ENRICH_PATH_INDUSTRY` | `category.industry\|industry\|industry_name` | Field paths, first non-empty wins. |
| `ENRICH_PATH_EMPLOYEES` | `metrics.employees\|employee_count\|employees\|headcount` | Field paths for an exact count. |
| `ENRICH_PATH_EMPLOYEE_RANGE` | `metrics.employeesRange\|employee_range\|size` | Field paths for a range (used when no count). |
| `ENRICH_PATH_TECH` | `tech\|technologies\|tech_stack` | Field paths for technologies. |
| `EMPLOYEE_RANGE_STRATEGY` | `midpoint` | `lower`, `midpoint` or `upper`. |
| `TECH_STACK_MAX_ITEMS` | `50` | Max technologies stored (1–500). |
| `INDUSTRY_MAP_JSON` | *(blank)* | Extra translations, e.g. `{"devtools":"COMPUTER_SOFTWARE"}`. |
| `OVERWRITE_EXISTING` | `false` | Replace values already on the record. |
| `FORCE_REENRICH` | `false` | Re-enrich companies already `ENRICHED`. |
| `WRITE_NORMALIZED_DOMAIN` | `true` | Fill an empty `domain` with the root domain. |
| `EXTRA_PUBLIC_SUFFIXES` | *(blank)* | Extra multi-part suffixes. |
| `EXTRA_BLOCKED_DOMAINS` | *(blank)* | Extra root domains never sent for enrichment. |
| `LOG_DOMAINS` | `true` | `false` masks domains in logs (`ex*****.com`). |

**Validation (fail fast).** Booleans, integer ranges, https URLs, field-path syntax, snake_case property names, industry-map JSON and domain lists are all checked. In live mode, a missing provider URL or webhook secret is fatal. Every problem is reported together, and the run stops before any API call. Check a file before deploying:

```bash
node config.validator.js --env-path .env
```

---

## HubSpot setup

1. **Private app** (*Settings → Integrations → Private Apps*) with `crm.objects.companies.read` and `crm.objects.companies.write`. Save its token as an n8n **HubSpot App Token** credential (`{{HUBSPOT_ACCESS_TOKEN}}`).
2. **Trigger entry point (optional):** a HubSpot developer app with a webhook subscription to `company.creation`, saved as an n8n **HubSpot Developer API** credential. Activating the workflow registers the subscription.
3. **Webhook entry point (optional):** a HubSpot workflow (*Company enrollment: Create date is known*) with a **Send a webhook** action: `POST` to the n8n production webhook URL, authentication via API key in the `x-webhook-secret` header set to `{{WEBHOOK_SECRET}}`. Include the record ID (`hs_object_id`) in the request body.
4. **Custom company properties** (*Settings → Properties → Company*):

| Internal name | Field type |
| --- | --- |
| `enriched_tech_stack` | Multi-line text |
| `enriched_industry_raw` | Single-line text |
| `enrichment_status` | Single-line text (or dropdown with the statuses above) |
| `enrichment_last_run_at` | Date and time |
| `enrichment_root_domain` | Single-line text |
| `enrichment_source` | Single-line text |

5. Check that your portal's **Industry** dropdown contains the options the mapper uses (e.g. `COMPUTER_SOFTWARE`, `FINANCIAL_SERVICES`). Add translations for anything else with `INDUSTRY_MAP_JSON`.

---

## Enrichment provider setup

The connector is provider-agnostic. Configure it in three places:

1. **Credential:** create an n8n **Header Auth** credential, typically name `Authorization`, value `Bearer {{ENRICHMENT_API_KEY}}` (or the header your provider documents, e.g. `X-API-Key`). Select it on *Enrichment API Lookup*.
2. **Endpoint:** set `ENRICHMENT_API_BASE_URL`, `ENRICHMENT_API_PATH` and `ENRICHMENT_DOMAIN_PARAM` so the request becomes `GET https://<provider>/<path>?domain=example.com`.
3. **Field paths:** run one real lookup in sandbox mode, inspect the response in the n8n execution view, and set `ENRICH_RESPONSE_ROOT` / `ENRICH_PATH_*` to match.

Check the provider's terms for caching, storage and redistribution of the data you write into HubSpot.

---

## Deployment steps

1. **Clone and validate**
   ```bash
   git clone https://github.com/dhrobinsystems/n8n-hubspot-company-domain-enrichment-mapper.git
   cd n8n-hubspot-company-domain-enrichment-mapper
   ./build.sh            # no npm install needed
   ```
2. **Configure**: `cp .env.example .env`, fill in the placeholders, keep `SANDBOX_MODE=true`, then `./build.sh --env .env`. Load `.env` into n8n with `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and restart n8n.
3. **Prepare HubSpot** in a developer test account: private app, custom properties, and the trigger or webhook entry point.
4. **Import** `workflow.json` (*Workflows → Import from File*). Select credentials on *HubSpot Company Created*, *HubSpot Get Company*, *Enrichment API Lookup* and *HubSpot Update Company*. Delete the entry point you do not use.
5. **Dry run**: create a few test companies, then open *Dry-Run Telemetry* in the execution view. Check `byStatus`, `planned` and `lines`; tune field paths and industry translations.
6. **Go live in stages**: set `SANDBOX_MODE=false`, restart n8n, activate the workflow and watch *Log Update Results* for the first batches. Keep `OVERWRITE_EXISTING=false` unless you have a backup and a reason.
7. **Monitor**: set an n8n *Error Workflow* for fail-fast config errors, and a HubSpot view on `enrichment_status` for `RATE_LIMITED` and `ERROR_*` records.

To change logic: edit `config.validator.js` or `src/*.js`, run `./build.sh`, and re-import `workflow.json`.

---

## Testing protocols

| Command | What it does |
| --- | --- |
| `./build.sh` | Node version check → `.env.example` validation → lint → build `workflow.json` → secret scan → all tests → harness. |
| `./build.sh --check` | Same, but fails if `workflow.json` is stale (used by CI). |
| `./build.sh --env .env` | Additionally validates your real environment file. |
| `npm test` | `node:test` suites in `test/`. |
| `npm run test:coverage` | Tests with Node's built-in coverage report. |
| `npm run harness` | Replays the full workflow against `test/fixtures` (sandbox). |
| `node workflow.harness.js --live` | Simulates live mode with mocked HubSpot PATCH calls. |
| `node config.validator.js --env-path <file>` | Pre-flight config check. |

**Coverage**

- `test/domain.test.js`: URL, email, port, userinfo, `www` handling; multi-part suffixes and hosting platforms; IPs, single labels, invalid labels and TLDs; blocklist; IDN; domain-field precedence; masking.
- `test/mapper.test.js`: field paths; industry synonyms, keywords and custom maps; employee parsing (ranges, `k`, `+`, objects, junk); tech-stack cleaning; HTTP error → status mapping; envelopes; overwrite policy; skip statuses; dry-run and live telemetry; redaction.
- `test/config.test.js`: defaults, placeholders, live-mode requirements, aggregated errors, secret never exposed, CLI exit codes.
- `test/workflow.test.js`: structure, build consistency, credential placeholders, retry and batching; each Code node executed in a VM (webhook secret enforcement, blocked `$env`, empty and junk input, missing pairing); the end-to-end pipeline against fixtures in sandbox and live mode; repository secret scan.

**Mock payloads** (`test/fixtures/`) are synthetic and use reserved example domains: HubSpot Trigger events (including a duplicate, a wrong event type and a missing ID), a webhook call, company records covering each skip path, and provider responses in four different shapes plus 404 and 429 errors.

---

## Resilience and error handling

| Failure | Behaviour |
| --- | --- |
| Invalid configuration | `ConfigError` lists every problem; execution stops before any API call. |
| `$env` blocked | Defaults apply; sandbox stays on. |
| Bad webhook secret, wrong event type, missing ID, duplicate | Event dropped and counted in the log; others continue. |
| Empty or junk trigger batch | Returns no items; execution ends cleanly. |
| HubSpot GET fails | `ERROR_HUBSPOT_FETCH`; company ID recovered from the paired event; nothing written. |
| Provider 404 / 429 / 401 / 5xx / timeout | Retried 3× by n8n, then mapped to `NOT_FOUND` / `RATE_LIMITED` / `ERROR_AUTH` / `ERROR_PROVIDER` and recorded. |
| Unparseable fields | That field is skipped; others are still mapped (`PARTIAL`). |
| Unexpected exception in a Code node | Caught; explicit fallback item with `ERROR_INTERNAL` and a redacted message. |
| HubSpot PATCH fails | Logged per company in *Log Update Results*; other companies continue. |
| Rate limits | HTTP nodes batched at 5 requests per second, with retries. |

---

## Security and privacy

- **No secrets in code or JSON.** Credentials are placeholder references (`{{HUBSPOT_ACCESS_TOKEN}}`, `{{ENRICHMENT_API_KEY}}`, `REPLACE_WITH_…` IDs). `build.sh` and the test suite scan the repository for real-looking tokens and email addresses.
- **Sandbox by default.** A fresh install cannot write to HubSpot.
- **Authenticated webhook.** Constant-time comparison of the shared secret; live mode refuses to start without one unless explicitly disabled.
- **Data minimisation.** Only the root domain leaves your systems. The router never sends company names, contacts or owners to the provider, and does not carry them through the workflow.
- **Sanitized logs.** Logs contain company IDs, statuses and property names, not values. Emails, tokens and API keys are redacted, and `LOG_DOMAINS=false` masks domains.
- **CRM integrity.** Fill-empty-only by default, no invalid dropdown values, and no writes to records that are already enriched or could not be read.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Everything ends in *Dry-Run Telemetry* | `SANDBOX_MODE` is still `true`, or `$env` is blocked. |
| `Invalid enrichment router configuration` | Read the listed problems; each names its variable. |
| Webhook calls produce no output | Secret header missing or wrong (`WEBHOOK_SECRET_MISMATCH` in the log). |
| Every company is `NOT_FOUND` | Field paths do not match the provider response; set `ENRICH_RESPONSE_ROOT` / `ENRICH_PATH_*`. |
| `ERROR_AUTH` | Header Auth credential missing or wrong header name. |
| Industry never set, raw text is | No translation for that value; add it to `INDUSTRY_MAP_JSON`. |
| HubSpot PATCH 400 | A custom property is missing, or its type differs from the table above. |
| Existing values not updated | Expected with `OVERWRITE_EXISTING=false`; see `preserved` in the logs. |

---

## ⚠️ Disclaimer & Liability Limitation

Use at your own risk. The code, workflows, and scripts provided in this repository (`n8n-hubspot-company-domain-enrichment-mapper`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` enabled before connecting live HubSpot credentials.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, the chosen enrichment data provider and any connected services, including the provider's data licensing terms and reviewing every automated company property update.

> **DISCLAIMER & LIABILITY LIMITATION:**
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. THE USER ASSUMES FULL RESPONSIBILITY FOR CRM DATA INTEGRITY, BACKUPS, API RATE LIMITS, AND COMPLIANCE WITH THIRD-PARTY TERMS OF SERVICE WHEN EXECUTING AUTOMATED WORKFLOWS IN PRODUCTION ENVIRONMENTS.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-hubspot-company-domain-enrichment-mapper/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-company-domain-enrichment-mapper/blob/main/LICENSE).
