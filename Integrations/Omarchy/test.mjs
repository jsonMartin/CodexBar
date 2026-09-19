import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const model = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../Linux/Shared/Usage.js', import.meta.url), 'utf8'), model);
test('quota is clamped, missing quota stays unknown', () => {
    assert.equal(model.remaining({usedPercent: 28}), 72);
    assert.equal(model.remaining({usedPercent: 150}), 0);
    assert.equal(model.remaining({usedPercent: -5}), 100);
    for (const value of [null, {}, {usedPercent: null}, {usedPercent: '12'}, {usedPercent: Infinity}])
        assert.equal(model.remaining(value), null);
});
test('partial provider failures preserve healthy rows without leaking raw errors or identity', () => {
    const rows = model.rows(JSON.stringify([
        {provider: 'codex', usage: {primary: {usedPercent: 28, windowMinutes: 300}, identity: {accountEmail: 'private@example.com'}}},
        {provider: 'claude', error: {message: 'secret upstream response'}}
    ]));
    assert.equal(model.summary(rows), 'CX 72%  ·  CL —');
    assert.equal(rows[0].windows[0].label, '5 hour');
    assert.ok(rows[1].error);
    assert.ok(!JSON.stringify(rows).includes('secret'));
    assert.ok(!JSON.stringify(rows).includes('private'));
});
test('malformed and unrecognized responses cannot replace the last good snapshot', () => {
    for (const value of ['', '[]', '{}', 'null', '[null]', 'oops'])
        assert.throws(() => model.rows(value));
});
test('reset countdown handles invalid and elapsed timestamps', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(model.resetLabel('bad', now), 'Reset time unavailable');
    assert.equal(model.resetLabel('2025-12-31T23:00:00Z', now), 'Reset due · refresh to update');
    assert.equal(model.resetLabel('2026-01-01T01:30:00Z', now), 'Resets in 1h 30m');
});
test('account selection is scoped to a single provider and arguments never use a shell', () => {
    const command = model.command({provider: 'both', allAccounts: true, accountIndex: 2});
    assert.ok(!command.includes('--all-accounts'));
    assert.ok(!command.includes('--account-index'));
    assert.ok(!model.command({provider: 'enabled'}).includes('--provider'));
    const single = model.command({provider: 'codex', allAccounts: true, source: 'oauth', executable: '/a path/codexbar'});
    assert.ok(single.includes('--all-accounts'));
    assert.ok(single.includes('/a path/codexbar'));
    assert.ok(single.includes('oauth'));
    assert.ok(!model.command({accountIndex: '2;bad'}).includes('--account-index'));
});
test('identity is opt-in and stays within its provider row', () => {
    const input = JSON.stringify([{provider: 'codex', usage: {identity: {accountEmail: 'one@example.com', loginMethod: 'pro'}}},
        {provider: 'claude', usage: {}}]);
    assert.equal(model.rows(input)[0].accountLabel, '');
    assert.equal(model.rows(input, true)[0].accountLabel, 'one@example.com');
    assert.equal(model.rows(input, true)[1].accountLabel, '');
    assert.equal(model.rows(input, true)[1].plan, '');
});
test('cost history preserves unknown amounts and uses the actual calendar day', () => {
    const input = JSON.stringify([{provider: 'codex', sessionCostUSD: 99, last30DaysCostUSD: 5,
        historyCoverageIsEstablished: true, daily: [{date: '2026-01-01', totalCost: 5}, {date: '2026-01-02', totalCost: null}]}]);
    const row = model.costs(input, '2026-01-02')[0];
    assert.equal(row.today, null);
    assert.equal(row.month, 5);
    assert.equal(row.chart.points.length, 1);
    assert.equal(model.costs(input, '2026-01-03')[0].today, 0);
    assert.equal(model.money(null), 'Unavailable');
    assert.equal(model.money(0), '$0.00');
});
test('generic charts bound data and keep negative values', () => {
    const result = model.chart({kind: 'line', points: [{label: 'a', value: -4}, {label: 'b', value: null}, {label: 'c', value: Infinity}]});
    assert.equal(result.points.length, 1);
    assert.equal(result.points[0].value, -4);
    assert.equal(model.chart(null), null);
    assert.equal(model.count(5358220), '5,358,220');
    assert.equal(model.count(null), '—');
});
test('provider detail rows redact emails unless explicitly enabled', () => {
    const input = JSON.stringify({provider: 'codex', usage: {details: [{rows: [{label: 'Account', value: 'private@example.com'}]}]}});
    assert.equal(model.rows(input)[0].details[0].rows[0].value, '[hidden email]');
    assert.equal(model.rows(input, true)[0].details[0].rows[0].value, 'private@example.com');
});

test('display preferences keep underlying quota and reset data intact', () => {
    assert.equal(model.quotaValue(60, 'used'), 40);
    assert.equal(model.quotaValue(60, 'remaining'), 60);
    assert.equal(model.resetText('invalid', 0, 'absolute'), 'Reset time unavailable');
    const time = '2030-01-01T00:00:00Z';
    assert.ok(model.resetText(time, 0, 'absolute').startsWith('Resets '));
    assert.ok(model.resetText(time, 0, 'both').includes(' · '));
});

const lanes = (windows, pace) => model.rows(JSON.stringify([{provider: 'codex', usage: windows, pace}]));
const session = {usedPercent: 63, windowMinutes: 300, resetsAt: '2030-01-01T00:00:00Z'};
const weekly = {usedPercent: 39, windowMinutes: 10080, resetsAt: '2030-01-02T00:00:00Z'};

test('bar shows session quota, weekly quota, then the weekly pace', () => {
    const rows = lanes({primary: session, secondary: weekly}, {secondary: {deltaPercent: 14, summary: '14% in deficit'}});
    assert.equal(model.barLabel(rows, 'remaining'), '5H 37% · 7D 61% · +14%');
    assert.equal(model.barLabel(rows, 'used'), '5H 63% · 7D 39% · +14%');
    assert.equal(rows[0].windows[1].minutes, 10080);
});
test('a weekly reserve keeps its negative sign and an exact pace reads as zero', () => {
    assert.equal(model.barLabel(lanes({primary: session, secondary: weekly},
        {secondary: {deltaPercent: -8}}), 'remaining'), '5H 37% · 7D 61% · -8%');
    assert.equal(model.barLabel(lanes({secondary: weekly}, {secondary: {deltaPercent: 0.4}}), 'remaining'), '7D 61% · 0%');
});
test('pace always describes the weekly window, never the most constrained lane', () => {
    const rows = lanes({primary: session, secondary: weekly},
        {primary: {deltaPercent: 31}, secondary: {deltaPercent: -8}});
    assert.equal(model.barLabel(rows, 'remaining'), '5H 37% · 7D 61% · -8%');
});
test('a provider without a session window omits that segment and its separator', () => {
    const label = model.barLabel(lanes({secondary: weekly}, {secondary: {deltaPercent: 14}}), 'remaining');
    assert.equal(label, '7D 61% · +14%');
    assert.ok(!label.includes('5H'));
    assert.ok(!label.startsWith(' ·'));
});
test('a provider without a weekly window shows the session lane alone', () => {
    const label = model.barLabel(lanes({primary: session}, {primary: {deltaPercent: 14}}), 'remaining');
    assert.equal(label, '5H 37%');
    assert.ok(!label.includes('·'));
    assert.ok(!label.includes('—'));
});
test('an unavailable weekly pace stays unavailable instead of reading as on pace', () => {
    assert.equal(model.barLabel(lanes({secondary: weekly}, null), 'remaining'), '7D 61% · —');
    for (const value of [{}, {deltaPercent: null}, {deltaPercent: 'nope'}, {deltaPercent: Infinity}])
        assert.equal(model.barLabel(lanes({secondary: weekly}, {secondary: value}), 'remaining'), '7D 61% · —');
});
test('missing quota values never produce empty segments or stray separators', () => {
    assert.equal(model.barLabel(lanes({primary: {usedPercent: null, windowMinutes: 300}, secondary: weekly},
        {secondary: {deltaPercent: 14}}), 'remaining'), '7D 61% · +14%');
    assert.equal(model.barLabel(lanes({}, null), 'remaining'), '—');
    assert.equal(model.barLabel([], 'remaining'), '');
    for (const label of [model.barLabel(lanes({secondary: weekly}, null), 'remaining'), model.barLabel(lanes({}, null), 'remaining')])
        assert.ok(!/(^|\s)·\s*·|·\s*$|^\s*·/.test(label));
});
test('an unreported cadence keeps its own lane rather than borrowing weekly pace', () => {
    const monthly = {usedPercent: 25, windowMinutes: 43200, resetsAt: '2030-01-02T00:00:00Z'};
    assert.equal(model.barLabel(lanes({primary: monthly}, {primary: {deltaPercent: 14}}), 'remaining'), '30D 75%');
    assert.equal(model.barLabel(lanes({primary: {usedPercent: 25}}, null), 'remaining'), 'Session 75%');
});
test('a failed provider row keeps the healthy provider labelled and never fabricates pace', () => {
    const rows = model.rows(JSON.stringify([
        {provider: 'codex', usage: {secondary: weekly}, pace: {secondary: {deltaPercent: 14}}},
        {provider: 'claude', error: {message: 'secret upstream response'}}]));
    assert.equal(model.barLabel(rows, 'remaining'), 'CX 7D 61% · +14%  ·  CL —');
    assert.ok(!JSON.stringify(rows).includes('secret'));
});
