/**
 * Writes `grab/channels.xml`: what the iptv-org/epg grabber fetches today. Only published channels
 * that no ready-made feed carries in the live guide, each once, on a site iptv-org marks working.
 */
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

import { grabPlan, workingSites, channelsXml } from './lib.js';

const PAGES_URL = process.env.PAGES_URL || 'https://streamloomepg.github.io/epg';
const ACTIVE_IDS_URL = process.env.ACTIVE_IDS_URL || 'https://catalogue.softarchium.com/catalogue/active-channel-ids.json';

async function get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
}

const [ids, guides, sites, live] = await Promise.all([
    get(ACTIVE_IDS_URL).then(r => r.json()),
    get('https://iptv-org.github.io/api/guides.json').then(r => r.json()),
    get('https://raw.githubusercontent.com/iptv-org/epg/master/SITES.md').then(r => r.text()),
    get(`${PAGES_URL}/guide.json.gz`).then(async r => JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())))),
]);
const published = new Set(ids.ids);
// Covered means a ready-made feed has it; what the grab itself delivered last time is grabbed again.
const covered = new Set(Object.entries(live.channels).filter(([, ch]) => ch.source !== 'grab').map(([id]) => id));
// Already sources of their own, read directly.
const ok = workingSites(sites);
ok.delete('epgshare01.online');
ok.delete('i.mjh.nz');

const plan = grabPlan(guides, published, covered, ok);
const bySite = {};
for (const p of plan) bySite[p.site] = (bySite[p.site] || 0) + 1;
mkdirSync('grab', { recursive: true });
writeFileSync('grab/channels.xml', channelsXml(plan));
console.log(`${plan.length} channels to grab from ${Object.keys(bySite).length} working sites:`,
    Object.entries(bySite).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', '));
