import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_FILE = path.join(__dirname, "..", "posts.json");
const RESULTS_FILE = path.join(__dirname, "..", "results.json");

const ANSWERS = {
  "1": "1", "INC": "1", "INDIA": "1", "CONGRESS": "1",
  "2": "2", "BJP": "2", "NDA": "2",
  "3": "3", "CJP_INDIA": "3", "CJP (ELSE INDIA)": "3", "CJP(ELSE INDIA)": "3",
  "4": "4", "CJP_NDA": "4", "CJP_BJP": "4", "CJP (ELSE BJP)": "4", "CJP(ELSE BJP)": "4", "CJP (ELSE NDA)": "4", "CJP(ELSE NDA)": "4", "CJP": "4"
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeRedditRssUrl(rawUrl) {
  const u = String(rawUrl || "").trim().replace(/\.(rss|json)$/i, "").replace(/\/+$/, "");
  return `${u}/.rss`;
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

  for (let attempt = 0; attempt < 5; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    try {
      const cmd = `curl -s -i -A "${ua}" "${canonicalUrl}"`;
      const res = execSync(cmd, { encoding: "utf-8", timeout: 20000 });
      const [headers, ...bodyParts] = res.split("\r\n\r\n");
      const body = bodyParts.join("\r\n\r\n");
      const statusLine = (headers.split("\r\n")[0] || "").trim();

      if (statusLine.includes(" 200") && (body.includes("<feed") || body.includes("<rss") || body.includes("<?xml"))) {
        return parseFeedXml(body);
      }

      if (statusLine.includes(" 429")) {
        const resetMatch = headers.match(/x-ratelimit-reset:\s*(\d+)/i);
        const resetSec = resetMatch ? Number(resetMatch[1]) : 15;
        const waitMs = Math.max(5, resetSec + 2) * 1000;
        console.warn(`Rate limited (429) on ${canonicalUrl}. Waiting ${Math.ceil(waitMs / 1000)}s before retry ${attempt + 1}...`);
        await sleep(waitMs);
        continue;
      }
    } catch (err) {
      console.warn(`Attempt ${attempt + 1} error for ${canonicalUrl}:`, err.message);
    }
    await sleep(2000 * (attempt + 1));
  }

  console.error(`Failed to fetch RSS for ${canonicalUrl} after 5 attempts.`);
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
      if (!raw) continue; // ignore non-vote comments

      const username = (e.author || "").trim().toLowerCase();
      if (!username || username === "[deleted]" || username === "automoderator") continue;

      if (!userVotes.has(username)) {
        userVotes.set(username, {});
      }
      const counts = userVotes.get(username);
      counts[raw] = (counts[raw] || 0) + 1;
    }

    if (i < posts.length - 1) {
      await sleep(2000);
    }
  }

  const results = { "1": 0, "2": 0, "3": 0, "4": 0 };
  let totalUniqueVoters = 0;

  for (const [user, counts] of userVotes.entries()) {
    const winner = resolveUserVote(counts);
    console.log(`User @${user} vote summary:`, counts, "-> Resolved:", winner || "IGNORED (tie)");
    if (winner && results[winner] !== undefined) {
      results[winner]++;
      totalUniqueVoters++;
    }
  }

  let existing = {};
  try {
    const existingRaw = await fs.readFile(RESULTS_FILE, "utf-8");
    existing = JSON.parse(existingRaw);
  } catch (e) {}

  const hasChanged = (
    Number(existing["1"]) !== results["1"] ||
    Number(existing["2"]) !== results["2"] ||
    Number(existing["3"]) !== results["3"] ||
    Number(existing["4"]) !== results["4"] ||
    Number(existing.total) !== totalUniqueVoters
  );

  if (!hasChanged) {
    console.log("No changes in vote counts. results.json remains untouched (no commit needed).");
    return;
  }

  const resultData = {
    "1": results["1"],
    "2": results["2"],
    "3": results["3"],
    "4": results["4"],
    updatedAt: new Date().toISOString(),
    total: totalUniqueVoters
  };

  console.log("Vote counts updated! Writing to results.json:", JSON.stringify(resultData, null, 2));
  await fs.writeFile(RESULTS_FILE, JSON.stringify(resultData, null, 2) + "\n", "utf-8");
  console.log("Successfully wrote results to:", RESULTS_FILE);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
