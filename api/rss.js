import Parser from "rss-parser";
import { Feed } from "feed";

// --- Source Webflow feeds (one per CMS Collection) ---
const SOURCES = [
  "https://curaforthegamer.com/play/rss.xml",
  "https://curaforthegamer.com/optimize/rss.xml",
  "https://curaforthegamer.com/gear/rss.xml",
  "https://curaforthegamer.com/beyond/rss.xml"
];

// ---------- Parser setup ----------
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

// ---------- Utilities ----------
function mimeFromUrl(u) {
  try {
    const ext = new URL(u).pathname.split(".").pop()?.toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "avif") return "image/avif";
    if (ext === "svg") return "image/svg+xml";
  } catch {}
  return "image/jpeg";
}

const firstImgFromHtml = (html) =>
  html ? (html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null) : null;

const toAbs = (url, base) => {
  if (!url) return null;
  try { return new URL(url, base).toString(); } catch { return null; }
};

function pickImage(it, baseUrl) {
  // 1) enclosure
  if (it.enclosure?.url) return toAbs(it.enclosure.url, baseUrl);

  // 2) media:thumbnail
  const tn = it["media:thumbnail"];
  if (tn) {
    if (typeof tn === "string") return toAbs(tn, baseUrl);
    if (tn.url) return toAbs(tn.url, baseUrl);
  }

  // 3) media:content
  const mc = it["media:content"];
  if (Array.isArray(mc) && mc[0]?.$?.url) return toAbs(mc[0].$.url, baseUrl);
  if (mc?.$?.url) return toAbs(mc.$.url, baseUrl);

  // 4) inline <img>
  const htmlImg =
    firstImgFromHtml(it["content:encoded"]) || firstImgFromHtml(it.content);
  if (htmlImg) return toAbs(htmlImg, baseUrl);

  return null;
}

// HEAD request to fetch Content-Length (Best Fix); omit length if unavailable.
async function headContentLength(url, timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    clearTimeout(timer);
    const len = resp.headers.get("content-length");
    return len && /^\d+$/.test(len) ? String(len) : null;
  } catch {
    return null;
  }
}

// escape text for RegExp literal
function rxEscape(str) {
  return str.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    // 1) Fetch & normalize items from all source feeds
    const lists = await Promise.all(
      SOURCES.map(async (url) => {
        try {
          const feed = await parser.parseURL(url);
          const base = feed.link || url;

          return feed.items.map((it) => {
            const publishedISO =
              it.isoDate || it.pubDate || it["dc:date"] || new Date().toISOString();

            const image = pickImage(it, base);
            const description =
              it.contentSnippet || it.summary || it["content:encoded"] || it.content || "";

            return {
              title: it.title || "",
              link: it.link || it.guid || "",
              description,
              date: new Date(publishedISO),
              image
            };
          });
        } catch (e) {
          console.error("Feed error:", url, e.message);
          return [];
        }
      })
    );

    // 2) Flatten, sort, cap to 50
    const items = lists.flat().sort((a, b) => b.date - a.date).slice(0, 50);

    // 3) Precompute Content-Length for enclosures in parallel (Best Fix)
    //    If HEAD fails, we'll omit the length attribute.
    const lengths = await Promise.all(
      items.map((it) => (it.image ? headContentLength(it.image) : Promise.resolve(null)))
    );

    // 4) Build base RSS via 'feed'
    const siteUrl = "https://curaforthegamer.com";
    const feed = new Feed({
      title: "CURA",
      description: "Curating for gamers. The useful, the interesting, the worthwhile.",
      id: `${siteUrl}/`,
      link: `${siteUrl}/`,
      language: "en",
      favicon:
        "https://cdn.prod.website-files.com/683ffb660726a2d09bc46217/68e61815eb8d0dfb4cb3536f_cura-favicon.png",
      image:
        "https://cdn.prod.website-files.com/683ffb660726a2d09bc46217/68feee3558458969f98a1007_cura-logo-512.jpg",
      updated: items[0]?.date || new Date(),
      feedLinks: { rss2: `${siteUrl}/rss.xml` },
      generator: "CURA unified feed"
    });

    items.forEach((it, idx) => {
      const descWithImg = it.image
        ? `<p><img src="${it.image}" alt=""/></p>${it.description}`
        : it.description;

      const enclosureBase = it.image
        ? { url: it.image, type: mimeFromUrl(it.image) }
        : undefined;

      // Only add length if we have a real number (never "0")
      if (enclosureBase && lengths[idx]) {
        enclosureBase.length = lengths[idx];
      }

      feed.addItem({
        title: it.title,
        id: it.link,
        link: it.link,
        description: descWithImg,
        date: it.date,
        enclosure: enclosureBase
      });
    });

    // 5) Generate XML
    let xml = feed.rss2();

    // 6) Ensure Media RSS namespace exists on <rss>
    if (!/xmlns:media=/.test(xml)) {
      xml = xml.replace(
        /<rss([^>]*)>/,
        `<rss$1 xmlns:media="http://search.yahoo.com/mrss/">`
      );
    }

    // 7) Inject Media RSS tags (self-closing with attributes) for each item that has an image
    for (const it of items) {
      if (!it.image || !it.link) continue;

      const mediaTags =
        `\n      <media:content url="${it.image}" medium="image"/>` +
        `\n      <media:thumbnail url="${it.image}"/>`;

      const linkXml = `<link>${it.link}</link>`;
      const itemPattern = new RegExp(
        `(\\<item\\>[\\s\\S]*?${rxEscape(linkXml)}[\\s\\S]*?)(\\<\\/item\\>)`
      );

      xml = xml.replace(itemPattern, `$1${mediaTags}\n    $2`);
    }

    // 8) Safety: strip any accidental length="0" that some parsers might inject downstream
    xml = xml.replace(/(<enclosure\b[^>]*?)\s+length="0"([^>]*>)/g, "$1$2");

    // 9) Send
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
