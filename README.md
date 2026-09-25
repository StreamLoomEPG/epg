# Streamloom EPG

Builds the programme guide for the channels the Streamloom catalogue publishes, from free XMLTV
feeds, and serves it from GitHub Pages:

- `https://streamloomepg.github.io/epg/guide.json.gz`: the guide
- `https://streamloomepg.github.io/epg/state.json`: per-source ETag and when it is next due
- `https://github.com/StreamLoomEPG/epg/releases/download/grab/guide.xml.gz`: the grabber's daily output, one of the sources

The backend (`Stream-Loom/streamloom-backend`) ingests the guide at the start of each catalogue
sync. This repository holds **no credential**. It reads the published channel ids from the public
catalogue CDN (`catalogue/active-channel-ids.json`), channel names from iptv-org, and its own
previous output from Pages.

## Only what is needed, only when it is needed

- **Targeted.** Only feeds that carry a published channel are used, in priority order:
  1. **epgshare01 country feeds**, chosen by a dry run of all 103 against the catalogue.
  2. **i.mjh.nz** (Pluto, Plex, Roku, Samsung TV Plus, Foxtel…), picked and mapped **by exact id**
     through iptv-org's [`guides.json`](https://iptv-org.github.io/api/guides.json).
  3. **iptv-epg.org** country files (us, ua, in, ru, vn), used with the site owner's agreement.
  4. **The iptv-org grabber** (`grab.yml`, daily). `plan-grab.mjs` asks it only for published
     channels no feed above carries, once each, on a site iptv-org marks working. Its output is
     the `grab` release asset.
- **Due, not scheduled.** A source is re-checked only when the earliest-ending of its channels'
  guides comes within 12 hours (`LOOKAHEAD_H` in `lib.js`). Otherwise its last schedule is
  reused.
- **Changed, not re-downloaded.** A re-check is a conditional request (`If-None-Match` /
  `If-Modified-Since`), so an unchanged feed costs a 304.
- **Once a day, everything.** Every 24 h each source is downloaded regardless of its ETag, so a
  newly published channel in an unchanged feed is picked up within a day.
- **Timed to the consumer.** The workflow runs 20 minutes before each six-hourly backend sync;
  a guide built between syncs would never be read.

## Matching

In order: an exact `guides.json` mapping; then our channel id (case- and punctuation-insensitive);
then display name. A name match must be the feed's own country, or a name no other iptv-org
channel shares. A channel takes its schedule from the first source that has one (epgshare01 before
the mapped feeds), so two feeds' timings never overlap.

## Output

```json
{ "generated": "ISO time", "previous": "the build this one follows", "window": { "from": 0, "to": 0 },
  "channels": { "<channel id>": { "source": "epgshare01/UK1", "hash": "…", "since": 0,
                                  "programmes": [[startMs, endMs, "title", "description"]] } } }
```

Window: now −6 h to now +48 h.
- `hash` changes only when a channel's schedule does. Programmes expiring off the back of the
  window don't count.
- `since` marks the first programme that differs from `previous`, so a backend that ingested
  `previous` writes only from there.
- A build whose share of published channels halves fails instead of publishing, unless forced.

## Run it

```bash
npm test
npm run build            # writes dist/, reusing the live Pages output as its previous state
FORCE=true npm run build # re-fetch everything
```

Setup, once: Settings → Pages → Source: **GitHub Actions**.
