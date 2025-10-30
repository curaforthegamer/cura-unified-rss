import Parser from "rss-parser";
import { Feed } from "feed";

// Replace these with your actual feed URLs if they differ
const SOURCES = [
  "https://curaforthegamer.com/play/rss.xml",
  "https://curaforthegamer.com/optimize/rss.xml",
  "https://curaforthegamer.com/gear/rss.xml",
  "https://curaforthegamer.com/beyond/rss.xml"
];

// false = stable (sort by published date), true = treat updates as new
const SURFACE_UPDATES = false;

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "media:content", { keepArray: true }],
      ["media:thumbnail", "media:thumbnail"],
      ["dc:date", "dc:date"]
    ]
  }
});

export default async function handler(req, res) {
  try {
    const lists = await Promise.all(
      SOURCES.map(async (url) => {
        try {
          const feed = await parser.parseURL(url);
          return feed.items.map((it) => {
            const published = it.isoDate || it.pubDate || it["dc:date"] || new Date().toISOString();
            const date = new Date(published);

            const image =
              (it.enclosure && it.enclosure.url) ||
              (it["media:thumbnail"] && it["media:thumbnail"].url) ||
              (it["media:content"] && it["media:content"][0]?.$.url) ||
              null;

            const description = it.contentSnippet || it.summary || it.content || "";

            return {
              title: it.title || "",
              link: it.link || it.guid || "",
              description,
              date,
              image
            };
          });
        } catch (e) {
          console.error("Feed error", url, e.message);
          return [];
        }
      })
    );

    // If SURFACE_UPDATES ever changes, you can modify 'date' above accordingly
    const items = lists.flat().sort((a, b) => b.date - a.date).slice(0, 50);

    const siteUrl = "https://curaforthegamer.com";
    const feed = new Feed({
      title: "CURA",
      description: "Curating for gamers. The useful, the interesting, the worthwhile.",
      id: `${siteUrl}/`,
      link: `${siteUrl}/`,
      language: "en",
      favicon: `${siteUrl}/favicon.ico`,
      updated: items[0]?.date || new Date(),
      feedLinks: { rss2: `${siteUrl}/rss.xml` },
      generator: "CURA unified feed"
    });

    items.forEach((it) =>
      feed.addItem({
        title: it.title,
        id: it.link,
        link: it.link,
        description: it.description,
        date: it.date,
        image: it.image
      })
    );

    const xml = feed.rss2();
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=900, stale-while-revalidate=86400");
    res.status(200).send(xml);
  } catch (e) {
    res.status(500).send("Feed error");
  }
}
