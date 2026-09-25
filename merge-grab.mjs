/**
 * Merges the grabber's per-site outputs (`grab/out/<site>.xml`) into one XMLTV document,
 * `grab/guide.xml.gz`, the release asset the build reads. A site that produced nothing is reported
 * and skipped; a grab that produced nothing at all fails, so an empty file is never published.
 */
import zlib from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const dir = 'grab/out';
const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.xml')) : [];
const channels = [];
const programmes = [];
const report = [];
for (const f of files) {
    const xml = readFileSync(`${dir}/${f}`, 'utf8');
    const ch = xml.match(/<channel\s[\s\S]*?<\/channel>/g) || [];
    const pr = xml.match(/<programme\s[\s\S]*?<\/programme>/g) || [];
    channels.push(...ch);
    programmes.push(...pr);
    report.push(`${f.replace(/\.xml$/, '')} ${ch.length}/${pr.length}`);
}
console.log(`Merged ${files.length} site(s): ${channels.length} channels, ${programmes.length} programmes.`);
console.log(report.join(', '));
if (programmes.length === 0) {
    console.error('The grab produced no programmes; not publishing an empty guide.');
    process.exit(1);
}
const doc = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${channels.join('\n')}\n${programmes.join('\n')}\n</tv>\n`;
writeFileSync('grab/guide.xml.gz', zlib.gzipSync(doc, { level: 9 }));
