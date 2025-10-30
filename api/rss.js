import Parser from "rss-parser";

// ---- Source Webflow feeds (one per CMS Collection) ----
const SOURCES = [
  "https://curaforthegamer.com/play/rss.xml",
  "https://curaforthegamer.com/optimize/rss.xml",
  "https://curaforthegamer.com/gear/rss.xml",
  "https://curaforthegamer.com/beyond/rss.xml"
];

// Parser setup to capture media fields and full HTML
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

// ---------- Helpers ----------
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

function pickImageFromItem(it, baseUrl) {
  // media:thumbnail
  const tn = it["media:thumbnail"];
  if (tn) {
    if (typeof tn === "string") return toAbs(tn, baseUrl);
    if (tn.url) return toAbs(tn.url, baseUrl);
  }
  // media:content
  const mc = it["media:content"];
  if (Array.isArray(mc) && mc[0]?.$?.url) return toAbs(mc[0].$.url, baseUrl);
  if (mc?.$?.url) return toAbs(mc.$.url, baseUrl);
  // fallback: first <img> in HTML
  const htmlImg = firstImgFromHtml(it["content:encoded"]) || firstImgFromHtml(it.content);
  if (htmlImg) return toAbs(htmlImg, baseUrl);
  return null;
}

function getPubDate(it) {
  const iso = it.isoDate || it.pubDate || it["dc:date"];
  const d = iso ? new Date(iso) : new Date();
  // RSS wants RFC-822 style GMT string
  return d.toUTCString();
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    // 1) Fetch all source feeds
    const lists = await Promise.all(
      SOURCES.map(async (url) => {
        try {
          const feed = await parser.parseURL(url);
          const base = feed.link || url;

          return feed.items.map((it) => {
            const title = it.title || "";
            const link = it.link || it.guid || "";
            const guid = link; // strict format requested
            const description =
              // Prefer concise text; your sources already use plain text
              it.contentSnippet || it.summary || it.content || it["content:encoded"] || "";
            const pubDate = getPubDate(it);
            const image = pickImageFromItem(it, base);

            return { title, link, guid, description, pubDate, image };
          });
        } catch (e) {
          console.error("Feed error:", url, e.message);
          return [];
        }
      })
    );

    // 2) Merge, sort by pubDate desc, cap to 50
    const items = lists
      .flat()
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .slice(0, 50);

    // 3) Build RSS XML manually to strictly control item shape
    const channelTitle = "CURA";
    const channelLink = "https://curaforthegamer.com/";
    const channelDesc = "Curating for gamers. The useful, the interesting, the worthwhile.";

    let xml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">` +
      `<channel>` +
      `<title>${xmlEscape(channelTitle)}</title>` +
      `<link>${xmlEscape(channelLink)}</link>` +
      `<description>${xmlEscape(channelDesc)}</description>` +
      `<lastBuildDate>${items[0] ? items[0].pubDate : new Date().toUTCString()}</lastBuildDate>` +
      `<generator>CURA unified feed</generator>` +
      `<language>en</language>`;

    for (const it of items) {
      xml +=
        `<item>` +
        `<title>${xmlEscape(it.title)}</title>` +
        `<link>${xmlEscape(it.link)}</link>` +
        `<guid>${xmlEscape(it.guid)}</guid>` +
        `<description>${xmlEscape(it.description)}</description>` +
        `<pubDate>${xmlEscape(it.pubDate)}</pubDate>`;

      if (it.image) {
        const img = xmlEscape(it.image);
        xml +=
          `<media:content url="${img}" medium="image"/>` +
          `<media:thumbnail url="${img}"/>`;
      }

      xml += `</item>`;
    }

    xml += `</channel></rss>`;

    // 4) Send
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
