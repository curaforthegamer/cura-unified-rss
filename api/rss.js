import Parser from "rss-parser";
import { Feed } from "feed";

const SOURCES = [
  "https://curaforthegamer.com/play/rss.xml",
  "https://curaforthegamer.com/optimize/rss.xml",
  "https://curaforthegamer.com/gear/rss.xml",
  "https://curaforthegamer.com/beyond/rss.xml"
];

const SURFACE_UPDATES = false;

const parser = new Parser({
  customFields: {
    feed: [
      ["link", "link"]
    ],
    item: [
      ["media:content", "media:content", { keepArray: true }],
      ["media:thumbnail", "media:thumbnail"],
      ["content:encoded", "content:encoded"],
      ["dc:date", "dc:date"],
      // grab a few oddballs used by some generators
      ["webfeeds:cover", "webfeeds:cover"],
      ["webfeeds:featuredimage", "webfeeds:featuredimage"],
      ["image", "image"],
      ["featuredImage", "featuredImage"]
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
    if (ext === "avif") return "image/avif"; // many readers still won’t render AVIF
    if (ext === "svg") return "image/svg+xml";
  } catch {}
  return "image/jpeg";
}

function toAbsolute(url, base) {
  if (!url) return null;
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

function firstImgFromHtml(html) {
  if (!html) return null;
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function pickImage(it, baseUrl) {
  // 1) enclosure
  if (it.enclosure?.url) return toAbsolute(it.enclosure.url, baseUrl);
  // 2) media:thumbnail (object or string)
  if (it["media:thumbnail"]) {
    const thumb = it["media:thumbnail"];
    if (typeof thumb === "string") return toAbsolute(thumb, baseUrl);
    if (thumb.url) return toAbsolute(thumb.url, baseUrl);
  }
  // 3) media:content (array or object)
  const mc = it["media:content"];
  if (Array.isArray(mc) && mc[0]?.$?.url) return toAbsolute(mc[0].$.url, baseUrl);
  if (mc?.$?.url) return toAbsolute(mc.$.url, baseUrl);
  // 4) known custom fields
  if (it["webfeeds:featuredimage"]) return toAbsolute(it["webfeeds:featuredimage"], baseUrl);
  if (it["webfeeds:cover"]) return toAbsolute(it["webfeeds:cover"], baseUrl);
  if (it.image) return toAbsolute(it.image, baseUrl);
  if (it.featuredImage) return toAbsolute(it.featuredImage, baseUrl);
  // 5) inline <img> in HTML content
  const fromHtml =
    firstImgFromHtml(it["content:encoded"]) ||
    firstImgFromHtml(it.content);
  if (fromHtml) return toAbsolute(fromHtml, baseUrl);
  return null;
}

export default async function handler(req, res) {
  try {
    const lists = await Promise.all(
      SOURCES.map(async (url) => {
        try {
          const feed = await parser.parseURL(url);
          const baseUrl = feed.link || url;
          return feed.items.map((it) => {
            const publishedISO =
              it.isoDate || it.pubDate || it["dc:date"] || new Date().toISOString();
            const date = new Date(publishedISO);

            const imageUrl = pickImage(it, baseUrl);

            const description =
              it.contentSnippet || it.summary || it["content:encoded"] || it.content || "";

            return {
              title: it.title || "",
              link: it.link || it.guid || "",
              description,
              date,
              image: imageUrl
            };
          });
        } catch (e) {
          console.error("Feed error", url, e.message);
          return [];
        }
      })
    );

    const items = lists.flat().sort((a, b) => b.date - a.date).slice(0, 50);

    const siteUrl = "https://curaforthegamer.com";
    const feed = new Feed({
      title: "CURA",
      description: "Curating for gamers. The useful, the interesting, the worthwhile.",
      id: `${siteUrl}/`,
      link: `${siteUrl}/`,
      language: "en",
      favicon: "https://cdn.prod.website-files.com/683ffb660726a2d09bc46217/68e61815eb8d0dfb4cb3536f_cura-favicon.png",
      image: "https://cdn.prod.website-files.com/683ffb660726a2d09bc46217/68feee3558458969f98a1007_cura-logo-512.jpg",
      updated: items[0]?.date || new Date(),
      feedLinks: { rss2: `${siteUrl}/rss.xml` },
      generator: "CURA unified feed"
    });

    items.forEach((it) => {
      const descWithImg = it.image
        ? `<p><img src="${it.image}" alt=""/></p>${it.description}`
        : it.description;

      const item = {
        title: it.title,
        id: it.link,
        link: it.link,
        description: descWithImg,
        date: it.date
      };

      if (it.image) {
        item.enclosure = {
          url: it.image,
          type: mimeFromUrl(it.image)
        };
      }

      feed.addItem(item);
    });

    const xml = feed.rss2();
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=900, stale-while-revalidate=86400");
    res.status(200).send(xml);
  } catch (e) {
    console.error("Unified feed error", e);
    res.status(500).send("Feed error");
  }
}
