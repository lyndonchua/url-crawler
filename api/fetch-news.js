const UA = 'Mozilla/5.0 (compatible; DailyNewsUrlSieve/1.0; +https://example.com)';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { url, date, mode = 'auto', timezone = 'Asia/Singapore' } = req.body || {};
    if (!url || !date) return res.status(400).json({ error: 'URL and date are required.' });
    const base = new URL(url);
    const target = date;
    const candidates = buildCandidates(base);
    let all = [], modeUsed = mode;

    if (mode === 'rss' || mode === 'auto') {
      for (const feed of candidates.rss) all.push(...await readFeed(feed, target, timezone));
      if (all.length && mode === 'auto') modeUsed = 'rss';
    }
    if (!all.length && (mode === 'sitemap' || mode === 'auto')) {
      for (const sm of candidates.sitemaps) all.push(...await readSitemap(sm, target, timezone));
      if (all.length && mode === 'auto') modeUsed = 'sitemap';
    }
    if (!all.length && (mode === 'homepage' || mode === 'auto')) {
      all.push(...await readHomepage(base.href, target, timezone));
      if (all.length && mode === 'auto') modeUsed = 'homepage';
    }

    all = dedupe(all).filter(x => sameHostOrSub(base.hostname, new URL(x.url).hostname));
    res.status(200).json({ date: target, modeUsed, items: all, message: `Found ${all.length} URL${all.length === 1 ? '' : 's'} for ${target}.` });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unable to fetch this site.' });
  }
}

function buildCandidates(base) {
  const origin = base.origin;
  const y = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric'}).format(new Date());
  const ym = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit'}).format(new Date()).replace('-', '/');
  const host = base.hostname.replace(/^www\./,'');
  const rss = [
    `${origin}/rss`, `${origin}/rss.xml`, `${origin}/feed`, `${origin}/feed.xml`, `${origin}/feeds`, `${origin}/feeds.xml`, `${origin}/RSS-Feeds`
  ];
  if (host.includes('straitstimes.com')) rss.unshift(`${origin}/RSS-Feeds`);
  if (host.includes('channelnewsasia.com')) rss.unshift(`${origin}/api/v1/rss-outbound-feed?_format=xml`, `${origin}/rss`);
  if (host.includes('businesstimes.com.sg')) rss.unshift(`${origin}/rss-feeds`);
  const sitemaps = [
    `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/news-sitemap.xml`, `${origin}/sitemap-news.xml`, `${origin}/sitemap/${ym}/feeds.xml`, `${origin}/sitemap/${y}/feeds.xml`
  ];
  return { rss: unique(rss), sitemaps: unique(sitemaps) };
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept': 'text/html,application/xml,text/xml,*/*' }, redirect: 'follow' });
  if (!r.ok) return '';
  return await r.text();
}

async function readFeed(feedUrl, target, tz) {
  const txt = await fetchText(feedUrl); if (!txt) return [];
  const chunks = [...txt.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi)].map(m=>m[0]);
  if (!chunks.length) return [];
  return chunks.map(ch => {
    const link = tag(ch,'link') || attrLink(ch) || tag(ch,'guid');
    const pub = tag(ch,'pubDate') || tag(ch,'published') || tag(ch,'updated') || tag(ch,'dc:date');
    const title = strip(tag(ch,'title') || '');
    if (!link || !pub || dateKey(pub, tz) !== target) return null;
    return { url: cleanUrl(link), published: pub, source: 'RSS', title };
  }).filter(Boolean);
}

async function readSitemap(smUrl, target, tz, depth = 0) {
  const txt = await fetchText(smUrl); if (!txt) return [];
  const locs = [...txt.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m=>decode(m[1].trim()));
  const lastmods = [...txt.matchAll(/<lastmod>([\s\S]*?)<\/lastmod>/gi)].map(m=>decode(m[1].trim()));
  let out = [];
  for (let i=0;i<locs.length;i++) {
    const loc = locs[i], lm = lastmods[i] || '';
    if (/\.xml(\.gz)?($|\?)/i.test(loc) && depth < 1) out.push(...await readSitemap(loc, target, tz, depth + 1));
    else if (lm && dateKey(lm, tz) === target) out.push({ url: cleanUrl(loc), published: lm, source: 'Sitemap', title: '' });
  }
  return out;
}

async function readHomepage(homeUrl, target, tz) {
  const txt = await fetchText(homeUrl); if (!txt) return [];
  const base = new URL(homeUrl);
  const anchors = [...txt.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const pageDate = dateKey(new Date().toISOString(), tz);
  if (pageDate !== target) return [];
  return anchors.map(m => {
    try {
      const u = new URL(decode(m[1]), base).href;
      const title = strip(m[2]);
      if (!looksArticle(u, title)) return null;
      return { url: cleanUrl(u), published: target, source: 'Homepage link', title };
    } catch { return null; }
  }).filter(Boolean);
}

function looksArticle(u, title='') {
  if (u.includes('#') || /\/($|\?)/.test(u)) return false;
  if (/(subscribe|login|newsletter|podcast|video|rss|about-us|terms|privacy|advertise|epaper)/i.test(u)) return false;
  return title.trim().length > 12 || /\/\d{4}\/\d{2}\//.test(u) || /\/[a-z0-9-]{25,}$/i.test(new URL(u).pathname);
}
function dateKey(s, tz) {
  const d = new Date(s); if (Number.isNaN(d.getTime())) return String(s).slice(0,10);
  const p = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const o = Object.fromEntries(p.map(x=>[x.type,x.value])); return `${o.year}-${o.month}-${o.day}`;
}
function tag(xml, name) { const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'); const m = xml.match(re); return m ? decode(m[1].trim()) : ''; }
function attrLink(xml) { const m = xml.match(/<link[^>]+href=["']([^"']+)["']/i); return m ? decode(m[1]) : ''; }
function decode(s='') { return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
function strip(s='') { return decode(s.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim(); }
function cleanUrl(u) { const x = new URL(u); ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','cx_testId','cx_testVariant'].forEach(k=>x.searchParams.delete(k)); x.hash=''; return x.href; }
function unique(a){return [...new Set(a)];}
function dedupe(items){ const seen=new Set(); return items.filter(x=>{ if(!x.url||seen.has(x.url))return false; seen.add(x.url); return true; }); }
function sameHostOrSub(a,b){ a=a.replace(/^www\./,''); b=b.replace(/^www\./,''); return a===b || b.endsWith('.'+a) || a.endsWith('.'+b); }
