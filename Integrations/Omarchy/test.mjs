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

const scopedEntry = {provider: 'claude', usage: {
    primary: {usedPercent: 21, windowMinutes: 300, resetsAt: '2026-09-18T18:00:00Z'},
    secondary: {usedPercent: 71, windowMinutes: 10080, resetsAt: '2026-09-21T09:00:00Z'},
    extraRateWindows: [{id: 'claude-weekly-scoped-fable', title: 'Fable only',
        window: {usedPercent: 93, windowMinutes: 10080, resetsAt: '2026-09-21T09:00:00Z'}}]}};

test('extra rate windows are appended after the standard lanes so the real weekly lane wins a cadence lookup', () => {
    const row = model.rows(JSON.stringify([scopedEntry]))[0];
    assert.deepEqual([...row.windows.map(window => window.key)],
        ['primary', 'secondary', 'claude-weekly-scoped-fable']);
    assert.deepEqual({...row.windows[2]},
        {key: 'claude-weekly-scoped-fable', label: 'Fable only', remaining: 7,
            resetsAt: '2026-09-21T09:00:00Z', pace: ''});
    assert.equal(row.error, '');
});
test('an extra rate window with an unusable quota is skipped', () => {
    const entry = {provider: 'claude', usage: {extraRateWindows: [
        {id: 'bad', title: 'Broken', window: {usedPercent: '93', windowMinutes: 10080}},
        {id: 'good', title: 'Fable only', window: {usedPercent: 93, windowMinutes: 10080}}]}};
    const row = model.rows(JSON.stringify([entry]))[0];
    assert.deepEqual([...row.windows.map(window => window.key)], ['good']);
});
test('an extra rate window without a title still renders a duration label', () => {
    const entry = {provider: 'claude', usage: {extraRateWindows: [
        {id: 'a', title: '   ', window: {usedPercent: 50, windowMinutes: 10080}},
        {id: 'b', window: {usedPercent: 50, windowMinutes: 300}},
        {id: 'c', window: {usedPercent: 50}}]}};
    const row = model.rows(JSON.stringify([entry]))[0];
    assert.deepEqual([...row.windows.map(window => window.label)], ['7 day', '5 hour', 'Additional']);
});
test('extra rate window titles redact emails unless identity is explicitly enabled', () => {
    const entry = {provider: 'claude', usage: {extraRateWindows: [
        {id: 'scoped', title: 'Fable (private@example.com)', window: {usedPercent: 93, windowMinutes: 10080}}]}};
    const input = JSON.stringify([entry]);
    assert.equal(model.rows(input)[0].windows[0].label, 'Fable [hidden email]');
    assert.equal(model.rows(input, true)[0].windows[0].label, 'Fable (private@example.com)');
});
test('extras without a usable window payload are skipped', () => {
    const entry = {provider: 'claude', usage: {extraRateWindows: [
        null, {id: 'no-window', title: 'No window'}, {id: 'no-percent', window: {windowMinutes: 60}},
        {id: 'good', title: 'Fable only', window: {usedPercent: 93, windowMinutes: 10080}}]}};
    const row = model.rows(JSON.stringify([entry]))[0];
    assert.deepEqual([...row.windows.map(window => window.key)], ['good']);
    assert.equal(row.error, '');
});
test('the extra-window cap counts displayed lanes, not skipped ones', () => {
    const unusable = Array.from({length: 8}, (_, index) => (
        {id: 'junk-' + index, title: 'Junk', window: {usedPercent: null}}));
    const entry = {provider: 'claude', usage: {extraRateWindows: [...unusable,
        {id: 'claude-weekly-scoped-fable', title: 'Fable only', window: {usedPercent: 93, windowMinutes: 10080}}]}};
    assert.deepEqual([...model.rows(JSON.stringify([entry]))[0].windows.map(window => window.key)],
        ['claude-weekly-scoped-fable']);
});
test('extra rate windows are capped at eight per provider', () => {
    const extras = Array.from({length: 10}, (_, index) => (
        {id: 'extra-' + index, title: 'Lane ' + index, window: {usedPercent: index, windowMinutes: 60}}));
    const row = model.rows(JSON.stringify([{provider: 'claude', usage: {extraRateWindows: extras}}]))[0];
    assert.equal(row.windows.length, 8);
});
