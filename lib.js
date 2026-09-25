/**
 * The pure parts of the guide build: matching feed channels to ours, parsing XMLTV, and deciding
 * which sources are due. `build.mjs` is the I/O boundary; nothing here touches the network.
 */
import { createHash } from 'node:crypto';

/** The guide's window, the same one the backend publishes: six hours back, 48 ahead. */
export const WINDOW_BACK_H = 6;
export const WINDOW_AHEAD_H = 48;

/**
 * A source is re-checked once its guide runs out within this many hours. The build runs just
 * before each six-hourly backend sync, and a scheduled run can be late, so twelve keeps "now" and
 * "next" covered until the build after next. A feed that never carries twelve hours (Samsung TV
 * Plus publishes about six) is simply re-checked every build; unchanged, that is a 304.
 */
export const LOOKAHEAD_H = 12;

/** A source that matched no published channel is looked at again after this long, not every hour. */
export const IDLE_RECHECK_H = 24;

const H = 3600 * 1000;

export function window(now = Date.now()) {
    return { from: now - WINDOW_BACK_H * H, to: now + WINDOW_AHEAD_H * H };
}

/** Lower-cased alphanumerics only, the key channel matching is done on. */
export function clean(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The country an epgshare01 feed is for (`UK1` -> `UK`), or null for a themed one (`BEIN1`). */
export function feedCountry(feed) {
    const m = /^([A-Z]{2})\d+$/.exec(feed);
    return m ? m[1] : null;
}

/**
 * Matches a feed channel to one of ours: exact id, then id without punctuation, then display name.
 *
 * `channels` is every iptv-org channel, not only the published ones, so a feed channel that belongs
 * to an unpublished channel is claimed by it instead of falling through to a published homonym.
 *
 * With `country`, a name match must be that country's channel or a name no other channel shares. A
 * shared name is weak evidence (the US feed's "News Nation" is not NewsNation.in); a unique one is
 * safe across borders because an XMLTV time is absolute (the German feed's "BBC One" is BBC One).
 *
 * @returns {(rawId: string, displayName?: string) => string | null} a published channel id, or null
 */
export function createFeedMatcher(channels, published, { country = null } = {}) {
    const byId = new Map();
    const byCleanId = new Map();
    const byCleanName = new Map();
    const nameCount = new Map();
    for (const ch of channels) nameCount.set(clean(ch.name), (nameCount.get(clean(ch.name)) || 0) + 1);
    for (const ch of channels) {
        byId.set(ch.id.toLowerCase(), ch.id);
        byCleanId.set(clean(ch.id), ch.id);
        const name = clean(ch.name);
        if (!name || byCleanName.has(name)) continue;
        if (country && (ch.country || '').toUpperCase() !== country && nameCount.get(name) > 1) continue;
        byCleanName.set(name, ch.id);
    }
    return (rawId, displayName) => {
        const name = clean(displayName);
        const id = byId.get(rawId.toLowerCase()) || byCleanId.get(clean(rawId)) || (name ? byCleanName.get(name) : null);
        return id && published.has(id) ? id : null;
    };
}

/**
 * The feeds of one guide site that carry a published channel, each with the exact mapping from its
 * channel ids to ours, taken from iptv-org's `guides.json` - the database our ids come from. One
 * entry per channel (its first), so two regional variants never overlap.
 *
 * @returns {{name: string, url: string, map: Map<string, string>}[]}
 */
export function mappedFeeds(guides, published, site, urlOf) {
    const seen = new Set();
    const feeds = new Map();
    for (const g of guides) {
        if (g.site !== site || !published.has(g.channel) || seen.has(g.channel)) continue;
        const hash = g.site_id.indexOf('#');
        if (hash < 1) continue;
        seen.add(g.channel);
        const file = g.site_id.slice(0, hash);
        if (!feeds.has(file)) feeds.set(file, { name: `${site}/${file}`, url: urlOf(file), map: new Map() });
        feeds.get(file).map.set(g.site_id.slice(hash + 1), g.channel);
    }
    return [...feeds.values()];
}

export function decodeXmlEntities(str) {
    if (!str) return '';
    return str
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, '&')
        .trim();
}

/** An XMLTV timestamp (`20260920040000 +0530`) in epoch ms, or null if it does not parse. */
export function parseXmltvTime(str) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])?(\d{2})?(\d{2})?/.exec((str || '').trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, s, sign, oh, om] = m;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    const offset = sign ? (sign === '-' ? -1 : 1) * ((+oh) * 60 + (+om || 0)) * 60000 : 0;
    return Number.isNaN(utc) ? null : utc - offset;
}

/**
 * Parses one XMLTV document into programmes for the channels `match` accepts and nobody has
 * `claimed` yet, keeping those that overlap `win`. A programme is `[startMs, endMs, title, desc]`.
 *
 * @returns {Map<string, [number, number, string, string][]>} by our channel id, sorted by start
 */
export function parseXmltv(xml, match, claimed, win) {
    const feedToOurs = new Map();
    for (const m of xml.matchAll(/<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)) {
        const name = decodeXmlEntities((/<display-name[^>]*>([^<]*)<\/display-name>/i.exec(m[2]) || [])[1]);
        const id = match(decodeXmlEntities(m[1]), name);
        if (id && !claimed.has(id)) feedToOurs.set(m[1], id);
    }
    const out = new Map();
    if (feedToOurs.size === 0) return out;
    for (const m of xml.matchAll(/<programme\s+([^>]+)>([\s\S]*?)<\/programme>/g)) {
        const attrs = m[1];
        const id = feedToOurs.get((/channel="([^"]+)"/.exec(attrs) || [])[1]);
        if (!id) continue;
        const start = parseXmltvTime((/start="([^"]+)"/.exec(attrs) || [])[1]);
        const end = parseXmltvTime((/stop="([^"]+)"/.exec(attrs) || [])[1]);
        if (start === null || end === null || end <= start || end < win.from || start > win.to) continue;
        const title = decodeXmlEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(m[2]) || [])[1]);
        if (!title) continue;
        const desc = decodeXmlEntities((/<desc[^>]*>([\s\S]*?)<\/desc>/i.exec(m[2]) || [])[1]);
        if (!out.has(id)) out.set(id, []);
        out.get(id).push([start, end, title.slice(0, 300), desc.slice(0, 1000)]);
    }
    for (const list of out.values()) {
        list.sort((a, b) => a[0] - b[0]);
        // One programme per start time: two feed channels mapped to one of ours must not stack.
        for (let i = list.length - 1; i > 0; i--) if (list[i][0] === list[i - 1][0]) list.splice(i, 1);
    }
    return out;
}

/**
 * When a source must be looked at again: when the earliest-ending of its channels' guides comes
 * within `LOOKAHEAD_H`, or a day on if it carries none of ours. Earliest, not typical: the point is
 * that no published channel runs out of "now". A re-check that finds the feed unchanged is a 304.
 */
export function nextCheck(programmesByChannel, now = Date.now()) {
    let until = Infinity;
    for (const list of programmesByChannel.values()) until = Math.min(until, list[list.length - 1][1]);
    return until === Infinity ? now + IDLE_RECHECK_H * H : until - LOOKAHEAD_H * H;
}

/** Whether a source is due: never seen, or its re-check time has come. */
export function isDue(state, now = Date.now()) {
    return !state || !(state.checkAt > now);
}

/** A short content hash, so the backend can store only the channels whose schedule changed. */
export function scheduleHash(programmes) {
    return createHash('sha1').update(JSON.stringify(programmes)).digest('base64url').slice(0, 16);
}
