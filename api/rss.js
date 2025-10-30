import Parser from "rss-parser";
import { Feed } from "feed";

const SOURCES = [
  "https://curaforthegamer.com/play/rss.xml",
  "https://curaforthegamer.com/optimize/rss.xml",
  "https://curaforthegamer.com/gear/rss.xml",
  "https://curaforthegamer.com/beyond/rss.xml"
];

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
  if (it.enclosure?.url) return toAbs(it.enclosure.url, baseUrl);
  const tn = it["media:thumbnail"];
  if (tn) {
    if (typeof tn === "string") return toAbs(tn, baseUrl);
    if (tn.url) return toAbs(tn.url, baseUrl);
  }
  const mc = it["media:content"];
  if (Array.isArray(mc) && mc[0]?.$?.url) return toAbs(mc[0].$.url, baseUrl);
  if (mc?.$?.url) return toAbs(mc.$.url, baseUrl);
  const htmlImg =
    firstImgFromHtml(it["content:encoded"]) || firstImgFromHtml(it.content);
  if (htmlImg) return toAbs(htmlImg, baseUrl);
  return null;
}

// escape text for use in a RegExp literal
function rxEscape(str) {
  return str.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
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

    const items = lists.flat().sort((a, b) => b.date - a.date).slice(0, 50);

    // 2) Build base RSS with feed lib
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

    items.forEach((it) => {
      const item = {
        title: it.title,
        id: it.link,
        link: it.link,
        description: it.image
          ? `<p><img src="${it.image}" alt=""/></p>${it.description}`
          : it.description,
        date: it.date,
        enclosure: it.image
          ? { url: it.image, type: mimeFromUrl(it.image) }
          : undefined
      };
      feed.addItem(item);
    });

    // 3) Generate XML
    let xml = feed.rss2();

    // 4) Add Media RSS namespace if missing
    if (!/xmlns:media=/.test(xml)) {
      xml = xml.replace(
        /<rss([^>]*)>/,
        `<rss$1 xmlns:media="http://search.yahoo.com/mrss/">`
      );
    }

    // 5) Inject proper <media:content> and <media:thumbnail> per item (no <_attr>)
    //    We find each <item> block by its <link> and append media tags before </item>.
    for (const it of items) {
      if (!it.image || !it.link) continue;

      const mediaTags =
        `\n      <media:content url="${it.image}" medium="image"/>` +
        `\n      <media:thumbnail url="${it.image}"/>`;

      // Match the specific item by its <link> value
      const linkXml = `<link>${it.link}</link>`;
      const itemPattern = new RegExp(
        `(\\<item\\>[\\s\\S]*?${rxEscape(linkXml)}[\\s\\S]*?)(\\<\\/item\\>)`
      );

      xml = xml.replace(itemPattern, `$1${mediaTags}\n    $2`);
    }

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
