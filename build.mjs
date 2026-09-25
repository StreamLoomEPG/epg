/**
 * Builds `dist/guide.json.gz` and `dist/state.json` for the channels the Streamloom catalogue
 * publishes, fetching a source only when it is due and downloading it only when it changed.
 *
 * Holds no credential. It reads the published channel ids from the public catalogue CDN and its
 * own previous output from GitHub Pages; the backend reads the guide from Pages and ingests it.
 */
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';

import {
    window, feedCountry, createFeedMatcher, mappedFeeds, parseXmltv, nextCheck, isDue, scheduleHash, changedSince,
} from './lib.js';

const PAGES_URL = process.env.PAGES_URL || 'https://streamloomepg.github.io/epg';
const ACTIVE_IDS_URL = process.env.ACTIVE_IDS_URL || 'https://catalogue.softarchium.com/catalogue/active-channel-ids.json';
const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const GUIDES_URL = 'https://iptv-org.github.io/api/guides.json';
const FORCE = process.env.FORCE === 'true';

/**
 * epgshare01 country feeds, in priority order: a channel takes its schedule from the first source
 * that has one. The first eight are the original set; the rest were kept by a dry run of all 103
 * feeds against the published catalogue on 2026-09-25, each adding at least 15 channels.
 */
const EPGSHARE = [
    'IN1', 'US2', 'UK1', 'FR1', 'DE1', 'CA2', 'AU1', 'ES1',
    'CZ1', 'RO1', 'CH1', 'IN4', 'AE1', 'HU1', 'TR3', 'TH1', 'BR2', 'GR1', 'BE2', 'AL1', 'CO1', 'NL1', 'ID1', 'VN1', 'BG1',
];

/**
 * iptv-epg.org country files, used with the site owner's agreement (2026-09-25). Only those that
 * add at least 15 published channels over the sources before them, by a dry run the same day.
 */
const IPTV_EPG = ['us', 'ua', 'in', 'ru', 'vn'];

/** The grabber's daily output (grab.yml), a release asset of this repository. */
const GRAB_URL = process.env.GRAB_URL || 'https://github.com/StreamLoomEPG/epg/releases/download/grab/guide.xml.gz';

async function get(url, headers = {}) {
    const res = await fetch(url, { headers });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
}

/**
 * Our previous output, or null the first time (Pages not deployed yet: 404). Any other failure
 * throws: building on a guide we could not read would drop every channel it held.
 */
async function previous(path, gz) {
    const res = await fetch(`${PAGES_URL}/${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} reading our previous ${path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return JSON.parse((gz ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}

function output(key, value) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** Once a day every source is downloaded regardless of ETag, to pick up newly published channels. */
const FULL_EVERY_MS = 24 * 3600 * 1000;

async function main() {
    const now = Date.now();
    const prevState = (await previous('state.json')) || { sources: {} };
    const full = FORCE || !(prevState.fullAt > now - FULL_EVERY_MS);
    const states = Object.values(prevState.sources);
    if (!full && !states.some(s => isDue(s, now))) {
        const next = Math.min(...states.map(s => s.checkAt));
        console.log(`Nothing due; next source is due ${new Date(next).toISOString()}.`);
        return output('changed', 'false');
    }

    const prevGuide = await previous('guide.json.gz', true);
    if (!prevGuide && states.length > 0) throw new Error('state.json exists but guide.json.gz does not; refusing to build on half a previous output.');
    const prevChannels = prevGuide?.channels || {};
    const [ids, channels, guides] = await Promise.all(
        [ACTIVE_IDS_URL, CHANNELS_URL, GUIDES_URL].map(async url => (await get(url)).json()),
    );
    const published = new Set(ids.ids);
    if (published.size === 0) throw new Error('The catalogue publishes no channels; refusing to build a guide for none.');
    const all = channels.map(c => ({ id: c.id, name: c.name, country: c.country }));

    // In priority order: epgshare01, then the mapped feeds (Pluto, Plex, Roku, Samsung TV Plus,
    // Foxtel...) by exact id, then iptv-epg.org, epg.pw, then what the grabber scraped (grab.yml) - each
    // fills only the channels the ones before it do not carry.
    const sources = [
        ...EPGSHARE.map(feed => ({
            name: `epgshare01/${feed}`,
            url: `https://epgshare01.online/epgshare01/epg_ripper_${feed}.xml.gz`,
            match: createFeedMatcher(all, published, { country: feedCountry(feed) }),
        })),
        ...mappedFeeds(guides, published, 'i.mjh.nz', file => `https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/${file}.xml.gz`).map(feed => ({
            ...feed,
            match: rawId => feed.map.get(rawId) || null,
        })),
        ...IPTV_EPG.map(cc => ({
            name: `iptv-epg.org/${cc}`,
            url: `https://iptv-epg.org/files/epg-${cc}.xml.gz`,
            match: createFeedMatcher(all, published, { country: cc === 'gb' ? 'UK' : cc.toUpperCase() }),
        })),
        {
            // epg.pw: clean terms (`robots.txt` allows /xmltv/). Only its RU file adds >=15 of ours,
            // mostly non-Russian channels a Russian IPTV service carries, under iptv-org ids.
            name: 'epg.pw/RU',
            url: 'https://epg.pw/xmltv/epg_RU.xml.gz',
            match: createFeedMatcher(all, published, { country: 'RU' }),
        },
        {
            name: 'grab',
            url: GRAB_URL,
            // The grabber writes our ids as its channel ids (xmltv_id), so only an exact id counts.
            match: rawId => (published.has(rawId) ? rawId : null),
        },
    ];

    const win = window(now);
    // A reused schedule keeps its hash: only a re-parsed source can change what a channel holds, so
    // programmes sliding out of the window's back edge never make the backend rewrite a channel.
    const reuse = name => new Map(Object.entries(prevChannels)
        .filter(([, ch]) => ch.source === name)
        .map(([id, ch]) => [id, { hash: ch.hash, programmes: ch.programmes.filter(p => p[1] >= win.from) }])
        .filter(([, ch]) => ch.programmes.length > 0));
    // A re-parsed channel whose schedule is the previous one minus what expired keeps its hash.
    // One that changed carries `since`: the start of its first programme that differs from the
    // previous build, so the backend writes only from there on (it falls back to the whole channel
    // when it did not ingest that previous build, see `previous` below).
    const parsed = got => new Map([...got].map(([id, programmes]) => {
        const prev = prevChannels[id];
        if (!prev) return [id, { hash: scheduleHash(programmes), programmes }];
        const since = changedSince(prev.programmes.filter(p => p[1] >= win.from), programmes);
        if (since === null) return [id, { hash: prev.hash, programmes }];
        return [id, { hash: scheduleHash(programmes), since, programmes }];
    }));

    const claimed = new Set();
    const guide = {};
    const state = { fullAt: full ? now : prevState.fullAt, sources: {} };
    let fetched = 0, unchanged = 0, failed = 0;

    for (const src of sources) {
        const prev = prevState.sources[src.name];
        let got;
        let next = prev;
        if (!full && !isDue(prev, now)) {
            got = reuse(src.name);
        } else {
            try {
                const headers = {};
                if (!full && prev?.etag) headers['If-None-Match'] = prev.etag;
                if (!full && prev?.lastModified) headers['If-Modified-Since'] = prev.lastModified;
                const res = await get(src.url, headers);
                if (res === null) {
                    unchanged += 1;
                    got = reuse(src.name);
                    next = { ...prev };
                } else {
                    fetched += 1;
                    const xml = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
                    got = parsed(parseXmltv(xml, src.match, claimed, win));
                    next = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
                }
                next.checkAt = nextCheck(new Map([...got].map(([id, ch]) => [id, ch.programmes])), now);
            } catch (err) {
                failed += 1;
                console.log(`::warning::${src.name}: ${err.message}`);
                got = reuse(src.name);
            }
        }
        let kept = 0;
        for (const [id, ch] of got) {
            if (claimed.has(id) || !published.has(id)) continue;
            claimed.add(id);
            guide[id] = { source: src.name, ...ch };
            kept += 1;
        }
        // A source that failed before it was ever fetched has no state, so it is due next run.
        if (next) state.sources[src.name] = { ...next, channels: kept };
    }

    const count = Object.keys(guide).length;
    state.share = count / published.size;
    console.log(`${full ? 'Full refresh. ' : ''}${sources.length} sources: ${fetched} downloaded, ${unchanged} unchanged (304), ${failed} failed.`);
    console.log(`${count} of ${published.size} published channels have a guide (${(100 * state.share).toFixed(1)}%).`);
    // A guide whose share of the catalogue suddenly halved is a broken upstream, not a real change.
    // A share, not a count, so a catalogue that really shrank does not lock this shut; FORCE skips it.
    if (!FORCE && prevState.share > 0 && state.share < prevState.share / 2) {
        throw new Error(`Refusing to publish ${(100 * state.share).toFixed(1)}% coverage over the previous ${(100 * prevState.share).toFixed(1)}%.`);
    }

    const same = count === Object.keys(prevChannels).length
        && Object.entries(guide).every(([id, ch]) => prevChannels[id]?.hash === ch.hash && prevChannels[id].programmes.length === ch.programmes.length);
    if (same && JSON.stringify(state) === JSON.stringify(prevState)) {
        console.log('Guide and state unchanged; nothing to deploy.');
        return output('changed', 'false');
    }
    mkdirSync('dist', { recursive: true });
    writeFileSync('dist/guide.json.gz', zlib.gzipSync(JSON.stringify({
        generated: new Date(now).toISOString(), previous: prevGuide?.generated || null, window: win, channels: guide,
    }), { level: 9 }));
    writeFileSync('dist/state.json', JSON.stringify(state));
    output('changed', 'true');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
