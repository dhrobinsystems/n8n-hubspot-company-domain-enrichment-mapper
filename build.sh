#!/usr/bin/env bash
# =============================================================================
# build.sh: build and validation pipeline for
# n8n-hubspot-company-domain-enrichment-mapper
#
#   ./build.sh            validate, lint, build workflow.json, test, run harness
#   ./build.sh --check    same, but FAIL if workflow.json is out of date (CI mode)
#   ./build.sh --env .env also validate a real environment file (pre-deploy)
#
# Zero npm dependencies: requires Node.js >= 20 and bash only.
#
# DISCLAIMER & LIABILITY LIMITATION:
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE. THE USER ASSUMES FULL RESPONSIBILITY FOR CRM DATA INTEGRITY,
# BACKUPS, API RATE LIMITS, AND COMPLIANCE WITH THIRD-PARTY TERMS OF SERVICE
# WHEN EXECUTING AUTOMATED WORKFLOWS IN PRODUCTION ENVIRONMENTS.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

CHECK_MODE=false
ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_MODE=true; shift ;;
    --env) ENV_FILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAILED:\033[0m %s\n' "$1" >&2; exit 1; }

step "1/7 Checking Node.js version"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js >= 20 required (found $(node -v))"
echo "Node $(node -v)"

step "2/7 Validating configuration template (.env.example)"
node config.validator.js --env-path .env.example >/dev/null || fail ".env.example is not a valid configuration"
echo ".env.example OK (sandbox defaults)"
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || fail "env file not found: $ENV_FILE"
  node config.validator.js --env-path "$ENV_FILE" || fail "$ENV_FILE failed validation"
fi

step "3/7 Linting (syntax check)"
for f in config.validator.js workflow.harness.js scripts/build-workflow.js src/*.js test/*.js; do
  node --check "$f" || fail "syntax error in $f"
done
for f in test/fixtures/*.json package.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || fail "invalid JSON in $f"
done
echo "OK"

step "4/7 Building workflow.json"
if [[ "$CHECK_MODE" == "true" ]]; then
  node scripts/build-workflow.js --check || fail "workflow.json is stale; run ./build.sh and commit it"
else
  node scripts/build-workflow.js
fi
node -e "JSON.parse(require('fs').readFileSync('workflow.json','utf8'))" || fail "workflow.json is not valid JSON"

step "5/7 Scanning for secrets and real credentials"
# Matches real-looking HubSpot / Slack / AWS / bearer tokens; placeholders like {{...}} are fine.
if grep -RInE --exclude-dir=node_modules --exclude-dir=.git --exclude=workflow.test.js \
  'pat-(na|eu|ap)[0-9]-[0-9a-f]{8}-|xox[abposr]-[0-9]{6,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9]{24,}' . ; then
  fail "possible secret found (see matches above)"
fi
if [[ -f .env ]] && git ls-files --error-unmatch .env >/dev/null 2>&1; then
  fail ".env is tracked by git; remove it from the repository"
fi
echo "No secrets found"

step "6/7 Running tests (node:test)"
node --test --test-reporter=spec test/domain.test.js test/mapper.test.js test/config.test.js test/workflow.test.js

step "7/7 Running workflow harness against mock payloads"
node workflow.harness.js | sed -n '1,16p'

printf '\n\033[32mBuild and validation passed.\033[0m Import workflow.json into n8n with SANDBOX_MODE=true first.\n'
