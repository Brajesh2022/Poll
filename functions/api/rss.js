/**
 * Cloudflare Pages Function: /api/rss
 * 
 * Secure, edge-cached RSS proxy for Reddit feeds with built-in retry,
 * domain fallbacks, 15-minute caching for successful responses, and zero-caching for errors.
 */

const CACHE_TTL_SECONDS = 900; // 15 minutes
const MAX_UPSTREAM_RETRIES = 3;
const RETRY_DELAYS = [500, 1200, 2500]; // ms
const REQUEST_TIMEOUT_MS = 8000; // 8s per attempt

const ALLOWED_HOST_REGEX = /^(?:[a-zA-Z0-9-]+\.)?reddit\.com$/i;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (compatible; ElectionSurvey/1.0)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCORSHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };
}

function normalizeRedditRssUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("Missing or invalid 'url' parameter");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Malformed URL provided");
  }

  if (!ALLOWED_HOST_REGEX.test(parsed.hostname)) {
    throw new Error("Only reddit.com URLs are permitted");
  }

  parsed.protocol = "https:";
  parsed.search = "";
  parsed.hash = "";

  // Normalize path to .rss
  let cleanPath = parsed.pathname.replace(/\.(rss|json)$/i, "").replace(/\/+$/, "");
  parsed.pathname = cleanPath + ".rss";

  return parsed.toString();
}

async function fetchFromRedditWithRetry(canonicalUrl) {
  let lastError = null;
  const candidateHosts = ["www.reddit.com", "old.reddit.com", "reddit.com"];

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    // Rotate host or user-agent across retries if encountering issues
    const host = candidateHosts[attempt % candidateHosts.length];
    const targetUrl = new URL(canonicalUrl);
    targetUrl.hostname = host;

    const userAgent = USER_AGENTS[attempt % USER_AGENTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const upstreamResponse = await fetch(targetUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          "Accept": "application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (upstreamResponse.ok) {
        const bodyText = await upstreamResponse.text();
        // Verify that the body is actual XML feed content and not an HTML error or block page
        if (bodyText.includes("<feed") || bodyText.includes("<rss") || bodyText.includes("<?xml")) {
          return {
            status: 200,
            text: bodyText,
            source: host,
          };
        } else {
          lastError = new Error(`Upstream returned non-XML content from ${host}`);
        }
      } else {
        lastError = new Error(`HTTP ${upstreamResponse.status} from ${host}`);
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }

    if (attempt < MAX_UPSTREAM_RETRIES) {
      const baseDelay = RETRY_DELAYS[attempt] || 1500;
      const jitter = Math.floor(Math.random() * 200);
      await sleep(baseDelay + jitter);
    }
  }

  throw lastError || new Error("Failed to fetch RSS from Reddit after retries");
}

export async function onRequest(context) {
  const { request } = context;
  const method = request.method.toUpperCase();

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCORSHeaders(),
    });
  }

  if (method !== "GET" && method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        ...getCORSHeaders(),
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  }

  const requestUrl = new URL(request.url);
  const targetParam = requestUrl.searchParams.get("url");

  let canonicalUrl;
  try {
    canonicalUrl = normalizeRedditRssUrl(targetParam);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: {
        ...getCORSHeaders(),
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  }

  // 15-minute Edge Caching with Cloudflare Cache API
  let cache;
  try {
    cache = caches.default;
  } catch {
    cache = null;
  }

  // Construct stable cache key based on normalized canonical URL
  const cacheKeyUrl = new URL(requestUrl.origin + requestUrl.pathname);
  cacheKeyUrl.searchParams.set("url", canonicalUrl);
  const cacheKey = new Request(cacheKeyUrl.toString(), {
    method: "GET",
  });

  if (cache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const headers = new Headers(cachedResponse.headers);
        Object.entries(getCORSHeaders()).forEach(([k, v]) => headers.set(k, v));
        headers.set("X-Cache", "HIT");
        return new Response(method === "HEAD" ? null : cachedResponse.body, {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers,
        });
      }
    } catch {
      // If cache matching encounters an issue, proceed to live fetch
    }
  }

  // Live upstream fetch with retries
  try {
    const { text, source } = await fetchFromRedditWithRetry(canonicalUrl);

    const headers = new Headers({
      ...getCORSHeaders(),
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      "X-Cache": "MISS",
      "X-Upstream-Source": source,
      "X-Fetched-At": new Date().toISOString(),
    });

    const response = new Response(method === "HEAD" ? null : text, {
      status: 200,
      headers,
    });

    // Store successful 200 response in Cloudflare edge cache
    if (cache) {
      const cacheResponse = new Response(text, {
        status: 200,
        headers,
      });

      if (context.waitUntil) {
        context.waitUntil(cache.put(cacheKey, cacheResponse));
      } else {
        await cache.put(cacheKey, cacheResponse);
      }
    }

    return response;
  } catch (err) {
    // CRITICAL: NEVER cache errors!
    return new Response(JSON.stringify({ error: err.message || "Failed to fetch Reddit RSS" }), {
      status: 502,
      headers: {
        ...getCORSHeaders(),
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "X-Cache": "BYPASS",
      },
    });
  }
}
