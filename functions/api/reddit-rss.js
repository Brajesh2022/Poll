const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com"]);
const CACHE_TTL_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [250, 750, 1_500];

function errorResponse(status, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function toRssUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || !REDDIT_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.(rss|json)$/i, "").replace(/\/+$/, "") + ".rss";
  return url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, 10_000);
  }
  return RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1);
}

async function fetchRedditFeed(rssUrl) {
  let lastFailure = "Reddit did not return a usable feed.";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(rssUrl, {
        headers: {
          accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
          "user-agent": "ElectionSurveyRSS/1.0",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      if (response.ok) {
        const body = await response.text();
        if (body.trim() && /<feed[\s>]/i.test(body)) return body;
        lastFailure = "Reddit returned an invalid RSS feed.";
      } else {
        lastFailure = `Reddit returned HTTP ${response.status}.`;
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
      }

      if (attempt < MAX_ATTEMPTS - 1) await sleep(retryDelay(response, attempt));
    } catch {
      lastFailure = "Could not reach Reddit.";
      if (attempt < MAX_ATTEMPTS - 1) await sleep(retryDelay(null, attempt));
    }
  }

  throw new Error(lastFailure);
}

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);
  const rssUrl = toRssUrl(requestUrl.searchParams.get("url") || "");
  if (!rssUrl) return errorResponse(400, "Provide a valid https Reddit post URL.");

  // Cache by the canonical Reddit RSS URL so query-string variations share one entry.
  const cacheKey = new Request(`${requestUrl.origin}/api/reddit-rss?url=${encodeURIComponent(rssUrl.href)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-rss-cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  try {
    const feed = await fetchRedditFeed(rssUrl.href);
    const response = new Response(feed, {
      headers: {
        "content-type": "application/atom+xml; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
        "x-rss-cache": "MISS",
      },
    });

    // Only a complete, successful feed reaches the cache. Error responses are always no-store.
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    return errorResponse(502, error instanceof Error ? error.message : "Unable to load Reddit RSS.", {
      "retry-after": "5",
    });
  }
}
