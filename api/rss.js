import Parser from "rss-parser";

// ---- Source Webflow feeds (one per CMS Collection) ----
const SOURCES = [
  "https://curaforthegamer.com/play/rss.xml",
  "https://curaforthegamer.com/optimize/rss.xml",
  "https://curaforthegamer.com/gear/rss.xml",
  "https://curaforthegamer.com/beyond/rss.xml"
];

// Where your unified feed is served (no trailing slash)
const SELF_FEED_URL = "https://feed.curaforthegamer.com";

// ---- Parser setup ----
const parser = new Parser({
  customFields: {
    feed: [["link", "link"]],
    item: [
      ["media:content", "media:content", { keepArray: true }],
      ["media:thumbnail", "media:thumbnail"],
      ["content:encoded", "content:encoded"],
      ["dc:date", "dc:date"]
    ]
  }
});

// ---- Helpers ----
const xmlEscape = (s) =>
  (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const toAbs = (url, base) => {
  if (!url) return null;
  try { return new URL(url, base).toString(); } catch { return null; }
};

const firstImgFromHtml = (html) => {
  if (!html) return null;
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
};

function pickImage(it, baseUrl) {
  // Prefer explicit media fields
  const tn = it["media:thumbnail"];
  if (tn) {
    if (typeof tn === "string") return toAbs(tn, baseUrl);
    if (tn.url) return toAbs(tn.url, baseUrl);
  }
  const mc = it["media:content"];
  if (Array.isArray(mc) && mc[0]?.$?.url) return toAbs(mc[0].$.url, baseUrl);
  if (mc?.$?.url) return toAbs(mc.$.url, baseUrl);

  // fallback: first <img> inside HTML
  const htmlImg = firstImgFromHtml(it["content:encoded"]) || firstImgFromHtml(it.content);
  if (htmlImg) return toAbs(htmlImg, baseUrl);

  // last resort: enclosure url (some generators use it for images)
  if (it.enclosure?.url) return toAbs(it.enclosure.url, baseUrl);

  return null;
}

function pickMimeFromUrl(u) {
  try {
    const ext = new URL(u).pathname.split(".").pop()?.toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "avif") return "image/avif"; // some readers won’t render, but it’s correct MIME
    if (ext === "svg") return "image/svg+xml";
  } catch {}
  return "image/jpeg";
}

function toRfc822(isoLike) {
  const d = isoLike ? new Date(isoLike) : new Date();
  return d.toUTCString();
}

// HEAD the image to get a real Content-Length (omit if unavailable)
async function headContentLength(url, timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    clearTimeout(t);
    const len = resp.headers.get("content-length");
    return len && /^\d+$/.test(len) ? String(len) : null;
  } catch {
    return null;
  }
}

// Pretty-print XML for human readability (ignored by RSS clients)
function prettyXml(xml) {
  try {
    const normalized = xml.replace(/>\s+</g, '><').replace(/></g, '>\n<');
    const lines = normalized.split('\n');
    const indent = '  ';
    let depth = 0;
    const out = [];

    for (let line of lines) {
      line = line.trim();
      // closing tag reduces depth first
      if (/^<\/[^>]+>/.test(line)) depth = Math.max(depth - 1, 0);

      out.push(indent.repeat(depth) + line);

      // opening tag (not self-closing/comment/declaration) increases depth
      if (/^<[^!?/][^>]*[^/]>$/.test(line)) depth++;
    }
    return out.join('\n');
  } catch {
    return xml;
  }
}

export default async function handler(req, res) {
  try {
    // 1) Fetch & normalize
    const lists = await Promise.all(
      SOURCES.map(async (url) => {
        try {
          const feed = await parser.parseURL(url);
          const base = feed.link || url;

          return feed.items.map((it) => {
            const title = it.title || "";
            const link = it.link || it.guid || "";
            const guid = link; // stable
            const description =
              it.contentSnippet || it.summary || it.content || it["content:encoded"] || "";
            const pubISO = it.isoDate || it.pubDate || it["dc:date"] || new Date().toISOString();
            const pubDate = toRfc822(pubISO);
            const dcDate = new Date(pubISO).toISOString();
            const image = pickImage(it, base);

            return { title, link, guid, description, pubDate, dcDate, image };
          });
        } catch (e) {
          console.error("Feed error:", url, e.message);
          return [];
        }
      })
    );

    // 2) Merge & sort (newest first), cap to 50
    const items = lists
      .flat()
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .slice(0, 50);

    // 3) Precompute real byte sizes for enclosures (parallel)
    const lengths = await Promise.all(
      items.map((it) => (it.image ? headContentLength(it.image) : Promise.resolve(null)))
    );

    // 4) Build RSS manually (full control & compatibility)
    const channelTitle = "CURA";
    const channelLink = "https://curaforthegamer.com"; // no trailing slash
    const channelDesc = "Curating for gamers. The useful, the interesting, the worthwhile.";
    const channelImage = "https://cdn.prod.website-files.com/683ffb660726a2d09bc46217/68feee3558458969f98a1007_cura-logo-512.jpg";
    const channelFavicon = "https://cdn.prod.website-files.com/683ffb660726a2d09bc46217/68e61815eb8d0dfb4cb3536f_cura-favicon.png";
    const buildDate = items[0]?.pubDate || new Date().toUTCString();

    let xml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<rss version="2.0"` +
      ` xmlns:atom="http://www.w3.org/2005/Atom"` +
      ` xmlns:media="http://search.yahoo.com/mrss/"` +
      ` xmlns:dc="http://purl.org/dc/elements/1.1/"` +
      ` xmlns:content="http://purl.org/rss/1.0/modules/content/"` +
      `>` +
      `<channel>` +
      `<title>${xmlEscape(channelTitle)}</title>` +
      `<link>${xmlEscape(channelLink)}</link>` +
      `<description>${xmlEscape(channelDesc)}</description>` +
      `<lastBuildDate>${xmlEscape(buildDate)}</lastBuildDate>` +
      `<generator>CURA unified feed</generator>` +
      `<language>en</language>` +
      `<atom:link href="${xmlEscape(SELF_FEED_URL)}" rel="self" type="application/rss+xml"/>` +
      `<image><title>${xmlEscape(channelTitle)}</title><url>${xmlEscape(channelImage)}</url><link>${xmlEscape(channelLink)}</link></image>` +
      `<icon>${xmlEscape(channelFavicon)}</icon>`;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];

      // enclosure (with real length when available)
      let enclosure = "";
      if (it.image) {
        const type = pickMimeFromUrl(it.image);
        const len = lengths[i];
        const lengthAttr = len ? ` length="${len}"` : "";
        enclosure = `<enclosure url="${xmlEscape(it.image)}" type="${xmlEscape(type)}"${lengthAttr}/>`;
      }

      // content:encoded with inline IMG (fallback for picky clients)
      const htmlBody = it.image
        ? `<p><img src="${it.image}" alt=""/></p>${it.description}`
        : it.description;
      const contentEncoded = `<![CDATA[${htmlBody}]]>`;

      xml +=
        `<item>` +
        `<title>${xmlEscape(it.title)}</title>` +
        `<link>${xmlEscape(it.link)}</link>` +
        `<guid isPermaLink="true">${xmlEscape(it.guid)}</guid>` +
        `<description>${xmlEscape(it.description)}</description>` +
        `<pubDate>${xmlEscape(it.pubDate)}</pubDate>` +
        `<dc:date>${xmlEscape(it.dcDate)}</dc:date>` +
        enclosure +
        (it.image
          ? `<media:content url="${xmlEscape(it.image)}" medium="image"/>` +
            `<media:thumbnail url="${xmlEscape(it.image)}"/>`
          : "") +
        `<content:encoded>${contentEncoded}</content:encoded>` +
        `</item>`;
    }

    xml += `</channel></rss>`;

    // Safety: never allow length="0" to slip in
    xml = xml.replace(/(<enclosure\b[^>]*?)\s+length="0"([^>]*>)/g, "$1$2");

    // Pretty-print unless explicitly disabled (?pretty=0)
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pretty = url.searchParams.get('pretty') !== '0';
    if (pretty) {
      xml = prettyXml(xml);
    }

    // Send
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=900, stale-while-revalidate=86400"
    );
    res.status(200).send(xml);
  } catch (e) {
    console.error("Unified feed error", e);
    res.status(500).send("Feed error");
  }
}
