'use strict';

/**
 * test/domain.test.js
 * Root-domain extraction and normalization (src/domain.js).
 * All domains are reserved example domains, fictitious names or well-known public mail providers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/domain');

const root = (input, options) => D.normalizeDomain(input, options).rootDomain;

test('normalizes URLs down to the root domain', () => {
  const cases = {
    'http://www.example.com/path': 'example.com',
    'HTTP://WWW.Example.COM:8080/a/b?q=1#top': 'example.com',
    'https://example.com': 'example.com',
    'example.com/': 'example.com',
    'example.com.': 'example.com',
    'www2.example.com': 'example.com',
    'https://blog.eu.example.com/post': 'example.com',
    '//cdn.acme.io/lib.js': 'acme.io',
    '  https://www.example.org  ': 'example.org',
    'ftp://files.example.net/pub': 'example.net',
    'example.com\\windows\\path': 'example.com',
  };
  Object.keys(cases).forEach((input) => assert.equal(root(input), cases[input], input));
});

test('handles email addresses, mailto links and userinfo', () => {
  assert.equal(root('jane@example.com'), 'example.com');
  assert.equal(root('jane.doe@sales.example.com'), 'example.com');
  assert.equal(root('mailto:team@example.org'), 'example.org');
  assert.equal(root('https://user:pass@www.example.com:443/x'), 'example.com');
});

test('respects multi-part public suffixes', () => {
  assert.equal(root('https://shop.acme-widgets.co.uk/en'), 'acme-widgets.co.uk');
  assert.equal(root('www.example.com.au'), 'example.com.au');
  assert.equal(root('portal.example.co.jp'), 'example.co.jp');
  assert.equal(root('example.com.br'), 'example.com.br');
  assert.equal(root('app.example.co.za'), 'example.co.za');
});

test('treats hosting-platform subdomains as separate organisations', () => {
  assert.equal(root('https://acme.myshopify.com/collections'), 'acme.myshopify.com');
  assert.equal(root('docs.acme.github.io'), 'acme.github.io');
  assert.equal(root('acme-site.netlify.app'), 'acme-site.netlify.app');
});

test('supports EXTRA_PUBLIC_SUFFIXES', () => {
  assert.equal(root('team.acme.internal.example'), 'internal.example');
  assert.equal(root('team.acme.internal.example', { extraSuffixes: ['internal.example'] }), 'acme.internal.example');
});

test('rejects unusable inputs with explicit reason codes', () => {
  const reason = (input) => D.normalizeDomain(input).reason;
  assert.equal(reason(''), D.REASONS.EMPTY);
  assert.equal(reason('   '), D.REASONS.EMPTY);
  assert.equal(reason(null), D.REASONS.EMPTY);
  assert.equal(reason(undefined), D.REASONS.EMPTY);
  assert.equal(reason({}), D.REASONS.NOT_A_STRING);
  assert.equal(reason(['example.com']), D.REASONS.NOT_A_STRING);
  assert.equal(reason('http://192.168.1.10/admin'), D.REASONS.IP_ADDRESS);
  assert.equal(reason('http://[2001:db8::1]/'), D.REASONS.IP_ADDRESS);
  assert.equal(reason('localhost'), D.REASONS.SINGLE_LABEL);
  assert.equal(reason('http://intranet/'), D.REASONS.SINGLE_LABEL);
  assert.equal(reason('bad_name.example.com'), D.REASONS.INVALID_HOSTNAME);
  assert.equal(reason('-leading.example.com'), D.REASONS.INVALID_HOSTNAME);
  assert.equal(reason('a..b.com'), D.REASONS.INVALID_HOSTNAME);
  assert.equal(reason('example.c0m'), D.REASONS.INVALID_TLD);
  assert.equal(reason('example.c'), D.REASONS.INVALID_TLD);
  assert.equal(reason('co.uk'), D.REASONS.PUBLIC_SUFFIX_ONLY);
  assert.equal(reason('https://www.co.uk'), D.REASONS.PUBLIC_SUFFIX_ONLY);
  assert.equal(reason('x'.repeat(64) + '.com'), D.REASONS.INVALID_HOSTNAME);
});

test('blocks personal mailbox and generic platform domains', () => {
  const gmail = D.normalizeDomain('someone@gmail.com');
  assert.equal(gmail.ok, false);
  assert.equal(gmail.reason, D.REASONS.BLOCKED_DOMAIN);
  assert.equal(gmail.rootDomain, 'gmail.com', 'root domain is still reported for telemetry');
  assert.equal(D.normalizeDomain('https://www.linkedin.com/company/acme').reason, D.REASONS.BLOCKED_DOMAIN);
  assert.equal(D.normalizeDomain('outlook.com', { allowBlocked: true }).ok, true);
  assert.equal(D.normalizeDomain('partner.example', { extraBlocked: ['partner.example'] }).reason, D.REASONS.BLOCKED_DOMAIN);
});

test('keeps internationalized and punycode domains', () => {
  assert.equal(root('https://www.xn--mnchen-3ya.de/'), 'xn--mnchen-3ya.de');
  assert.equal(root('https://shop.münchen.example/'), 'münchen.example');
});

test('pickCompanyDomain prefers domain, then website, then additional domains', () => {
  assert.equal(D.pickCompanyDomain({ domain: 'example.com', website: 'https://other.example' }).rootDomain, 'example.com');
  const fromWebsite = D.pickCompanyDomain({ domain: '', website: 'http://www.example.com/path' });
  assert.equal(fromWebsite.rootDomain, 'example.com');
  assert.equal(fromWebsite.field, 'website');
  const fromAdditional = D.pickCompanyDomain({ hs_additional_domains: 'not valid;www.example.org' });
  assert.equal(fromAdditional.rootDomain, 'example.org');
  assert.equal(fromAdditional.field, 'hs_additional_domains');
  // Invalid domain but valid website: website wins.
  assert.equal(D.pickCompanyDomain({ domain: 'localhost', website: 'example.net' }).rootDomain, 'example.net');
});

test('pickCompanyDomain reports the first failure when nothing is usable', () => {
  assert.equal(D.pickCompanyDomain({}).reason, D.REASONS.EMPTY);
  assert.equal(D.pickCompanyDomain(null).reason, D.REASONS.EMPTY);
  const blocked = D.pickCompanyDomain({ domain: 'gmail.com', website: 'localhost' });
  assert.equal(blocked.reason, D.REASONS.BLOCKED_DOMAIN);
  assert.equal(blocked.field, 'domain');
});

test('maskDomain hides the registrable name but keeps the suffix', () => {
  assert.equal(D.maskDomain('example.co.uk'), 'ex*****.co.uk');
  assert.equal(D.maskDomain('ab.io'), 'ab***.io');
  assert.equal(D.maskDomain(''), '');
  assert.equal(D.maskDomain('nodot'), '***');
});

test('suffix list has no duplicates and is lowercase', () => {
  const list = D.MULTI_PART_SUFFIXES;
  assert.equal(new Set(list).size, list.length);
  list.forEach((s) => assert.equal(s, s.toLowerCase()));
});
