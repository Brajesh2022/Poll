import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_FILE = path.join(__dirname, "..", "posts.json");
const RESULTS_FILE = path.join(__dirname, "..", "results.json");

const ANSWERS = {
  "1": "INDIA", "INDIA": "INDIA", "INC": "INDIA", "CONGRESS": "INDIA",
  "2": "NDA", "NDA": "NDA", "BJP": "NDA",
  "3": "CJP_INDIA", "4": "CJP_NDA", "CJP": "CJP"
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (compatible; ElectionSurvey/1.0)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeRedditRssUrl(rawUrl) {
  const parsed = new URL(rawUrl.trim());
  parsed.protocol = "https:";
  parsed.search = "";
  parsed.hash = "";
  const cleanPath = parsed.pathname.replace(/\.(rss|json)$/i, "").replace(/\/+$/, "");
  parsed.pathname = cleanPath + ".rss";
  return parsed.toString();
}

function normalizeVote(text) {
  const value = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  const clean = value.replace(/^[\s"'`*_.,:;!?()[\]{}<>-]+|[\s"'`*_.,:;!?()[\]{}<>-]+$/g, "");
  return ANSWERS[clean] || null;
}

function resolveUserVote(counts) {
  let maxCount = 0;
  let winner = null;
  let isTie = false;

  for (const vote in counts) {
    const count = counts[vote];
    if (count > maxCount) {
      maxCount = count;
      winner = vote;
      isTie = false;
    } else if (count === maxCount) {
      isTie = true;
    }
  }

  return isTie ? null : winner;
}

function parseFeedXml(xmlText) {
  const entries = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = entryRegex.exec(xmlText)) !== null) {
    const entryBlock = match[1];

    const idMatch = /<id\b[^>]*>([\s\S]*?)<\/id>/i.exec(entryBlock);
    const id = idMatch ? idMatch[1].trim() : "";

    const authorMatch = /<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i.exec(entryBlock);
    const author = authorMatch ? authorMatch[1].trim().replace(/^\/u\//, "") : "";

    const contentMatch = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(entryBlock);
    const rawContent = contentMatch ? contentMatch[1] : "";
    // Decode HTML entities if present
    const content = rawContent
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");

    entries.push({
      id,
      author,
      content,
      type: id.startsWith("t3_") ? "post" : id.startsWith("t1_") ? "comment" : "other"
    });
  }

  return entries;
}

async function fetchRssFeed(url) {
  const canonicalUrl = normalizeRedditRssUrl(url);
  const candidateHosts = ["www.reddit.com", "old.reddit.com", "reddit.com"];
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const host = candidateHosts[attempt % candidateHosts.length];
    const targetUrl = new URL(canonicalUrl);
    targetUrl.hostname = host;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(targetUrl.toString(), {
        headers: {
          "User-Agent": USER_AGENTS[attempt % USER_AGENTS.length],
          "Accept": "application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const text = await res.text();
        if (text.includes("<feed") || text.includes("<rss") || text.includes("<?xml")) {
          return parseFeedXml(text);
        }
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }

    await sleep(1000 * (attempt + 1));
  }

  console.warn(`Could not fetch ${url} live: ${lastError?.message || "unknown error"}`);
  return [];
}

async function main() {
  console.log("Loading posts from:", POSTS_FILE);
  const postsRaw = await fs.readFile(POSTS_FILE, "utf-8");
  const posts = JSON.parse(postsRaw);

  const userVotes = new Map();

  for (let i = 0; i < posts.length; i++) {
    const postUrl = typeof posts[i] === "string" ? posts[i] : posts[i].url;
    console.log(`Fetching post ${i + 1}/${posts.length}: ${postUrl}`);
    const entries = await fetchRssFeed(postUrl);

    for (const e of entries) {
      if (e.type !== "comment") continue;
      const raw = normalizeVote(e.content);
      if (!raw) continue; // ignore random comments

      const username = (e.author || "").trim().toLowerCase();
      if (!username || username === "[deleted]" || username === "automoderator") continue;

      if (!userVotes.has(username)) {
        userVotes.set(username, {});
      }
      const counts = userVotes.get(username);
      counts[raw] = (counts[raw] || 0) + 1;
    }
  }

  const rawVotes = [];
  for (const counts of userVotes.values()) {
    const winner = resolveUserVote(counts);
    if (winner) {
      rawVotes.push(winner);
    }
  }

  const counts = { INDIA: 0, NDA: 0, CJP: 0 };
  for (const vote of rawVotes) {
    if (vote === "CJP_INDIA" || vote === "CJP_NDA" || vote === "CJP") {
      counts.CJP++;
    } else if (vote === "NDA") {
      counts.NDA++;
    } else if (vote === "INDIA") {
      counts.INDIA++;
    }
  }

  const total = counts.INDIA + counts.NDA + counts.CJP;
  const resultData = {
    updatedAt: new Date().toISOString(),
    totalResponses: total,
    rawVotes,
    counts,
    percentages: {
      INDIA: total ? Math.round((counts.INDIA / total) * 100) : 0,
      NDA: total ? Math.round((counts.NDA / total) * 100) : 0,
      CJP: total ? Math.round((counts.CJP / total) * 100) : 0
    }
  };

  console.log("Result Summary:", JSON.stringify(resultData, null, 2));
  await fs.writeFile(RESULTS_FILE, JSON.stringify(resultData, null, 2) + "\n", "utf-8");
  console.log("Successfully wrote results to:", RESULTS_FILE);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
