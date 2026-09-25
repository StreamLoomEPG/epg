import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    clean, feedCountry, createFeedMatcher, mappedFeeds, decodeXmlEntities, parseXmltvTime, parseXmltv,
    nextCheck, isDue, scheduleHash, changedSince, LOOKAHEAD_H, IDLE_RECHECK_H,
} from '../lib.js';

const H = 3600 * 1000;

test('clean, feedCountry, entities and XMLTV time', () => {
    assert.equal(clean('BBC One (HD)!'), 'bbconehd');
    assert.equal(feedCountry('UK1'), 'UK');
    assert.equal(feedCountry('BEIN1'), null);
    assert.equal(feedCountry('US_LOCALS1'), null);
    assert.equal(decodeXmlEntities('Tom &amp; Jerry &#65; &amp;lt;'), 'Tom & Jerry A &lt;', 'no double decoding');
    assert.equal(decodeXmlEntities('<![CDATA[News]]>'), 'News');
    assert.equal(parseXmltvTime('20260920040000 +0530'), Date.parse('2026-09-19T22:30:00Z'));
    assert.equal(parseXmltvTime('20260920040000'), Date.parse('2026-09-20T04:00:00Z'));
    assert.equal(parseXmltvTime('nonsense'), null);
});

test('matching: unpublished homonyms claim their own feed; shared names stay in-country; unique names cross', () => {
    const all = [
        { id: 'BBCOne.uk', name: 'BBC One', country: 'UK' },
        { id: 'BBCOne.us', name: 'BBC One', country: 'US' },
        { id: 'NewsNation.in', name: 'News Nation', country: 'IN' },
        { id: 'NewsNation.us', name: 'News Nation', country: 'US' },
        { id: 'DW.de', name: 'DW', country: 'DE' },
    ];
    const pub = new Set(['BBCOne.us', 'NewsNation.in', 'NewsNation.us', 'DW.de']);
    const any = createFeedMatcher(all, pub);
    assert.equal(any('BBCOne.uk', 'BBC One'), null, 'claimed by the unpublished BBCOne.uk, never handed to BBCOne.us');
    assert.equal(any('x', 'News Nation'), 'NewsNation.in', 'without a country the first name wins');
    const us = createFeedMatcher(all, pub, { country: 'US' });
    assert.equal(us('x', 'News Nation'), 'NewsNation.us');
    assert.equal(us('x', 'DW'), 'DW.de');
    assert.equal(createFeedMatcher(all, pub, { country: 'FR' })('x', 'News Nation'), null);
    assert.equal(us('dw-de', ''), 'DW.de', 'an id match ignores case and punctuation and is exempt');
    assert.equal(us('zzz', ''), null);
});

test('mappedFeeds groups published channels by file, first entry per channel', () => {
    const guides = [
        { channel: 'A.us', site: 'i.mjh.nz', site_id: 'PlutoTV/us#p1' },
        { channel: 'A.us', site: 'i.mjh.nz', site_id: 'Plex/us#x9' },
        { channel: 'B.us', site: 'i.mjh.nz', site_id: 'PlutoTV/us#p2' },
        { channel: 'C.us', site: 'i.mjh.nz', site_id: 'Roku/all#r1' },
        { channel: 'D.us', site: 'i.mjh.nz', site_id: 'Roku/all#r2' },
        { channel: null, site: 'i.mjh.nz', site_id: 'Roku/all#r3' },
        { channel: 'B.us', site: 'tvtv.us', site_id: '1' },
        { channel: 'E.us', site: 'i.mjh.nz', site_id: 'broken' },
    ];
    const feeds = mappedFeeds(guides, new Set(['A.us', 'B.us', 'C.us', 'E.us']), 'i.mjh.nz', f => `u/${f}`);
    assert.deepEqual(feeds.map(f => [f.name, f.url, [...f.map]]), [
        ['i.mjh.nz/PlutoTV/us', 'u/PlutoTV/us', [['p1', 'A.us'], ['p2', 'B.us']]],
        ['i.mjh.nz/Roku/all', 'u/Roku/all', [['r1', 'C.us']]],
    ]);
});

test('parseXmltv keeps matched, unclaimed channels inside the window, sorted, one per start', () => {
    const xml = `<tv>
      <channel id="a"><display-name>A</display-name></channel>
      <channel id="a2"><display-name>A again</display-name></channel>
      <channel id="b"><display-name>B</display-name></channel>
      <programme start="20260925120000 +0000" stop="20260925130000 +0000" channel="a"><title>Noon &amp; on</title><desc>d</desc></programme>
      <programme start="20260925100000 +0000" stop="20260925120000 +0000" channel="a"><title>Ten</title></programme>
      <programme start="20260925120000 +0000" stop="20260925123000 +0000" channel="a2"><title>Dup start</title></programme>
      <programme start="20260920000000 +0000" stop="20260920010000 +0000" channel="a"><title>Too old</title></programme>
      <programme start="20260925100000 +0000" stop="20260925110000 +0000" channel="a"><title></title></programme>
      <programme start="20260925100000 +0000" stop="20260925110000 +0000" channel="b"><title>Claimed</title></programme>
    </tv>`;
    const match = raw => ({ a: 'A.us', a2: 'A.us', b: 'B.us' })[raw] || null;
    const win = { from: Date.parse('2026-09-25T06:00:00Z'), to: Date.parse('2026-09-27T12:00:00Z') };
    const out = parseXmltv(xml, match, new Set(['B.us']), win);
    assert.deepEqual([...out.keys()], ['A.us']);
    assert.deepEqual(out.get('A.us').map(p => p[2]), ['Ten', 'Noon & on']);
    assert.equal(out.get('A.us')[1][3], 'd');
});

test('a source is due when its earliest-ending channel comes within the lookahead', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const guide = new Map([['A', [[0, now + 40 * H]]], ['B', [[0, now + 20 * H]]]]);
    assert.equal(nextCheck(guide, now), now + (20 - LOOKAHEAD_H) * H);
    assert.equal(nextCheck(new Map(), now), now + IDLE_RECHECK_H * H, 'a source with none of ours waits a day');
    assert.equal(isDue(undefined, now), true, 'never seen');
    assert.equal(isDue({ checkAt: now + 1 }, now), false);
    assert.equal(isDue({ checkAt: now }, now), true);
    assert.equal(scheduleHash([[1, 2, 't', '']]), scheduleHash([[1, 2, 't', '']]));
    assert.notEqual(scheduleHash([[1, 2, 't', '']]), scheduleHash([[1, 3, 't', '']]));
});

test('changedSince: where the schedule starts to differ, including a removal from the middle', () => {
    const a = [10, 11, 12].map(t => [t, t + 1, `p${t}`, '']);
    assert.equal(changedSince(a, a), null, 'identical');
    assert.equal(changedSince(a, [...a, [13, 14, 'p13', '']]), 13, 'grew at the end');
    assert.equal(changedSince(a, [a[0], a[2]]), 11, 'middle removal: the removed programme\'s start, not the next one\'s');
    assert.equal(changedSince(a, [a[0], [11, 12, 'renamed', ''], a[2]]), 11, 'a changed programme');
    assert.equal(changedSince(a, [a[0], [11.5, 12, 'moved', ''], a[2]]), 11, 'moved later: from the old start');
    assert.equal(changedSince(a, a.slice(0, 2)), 12, 'removed at the end');
});
