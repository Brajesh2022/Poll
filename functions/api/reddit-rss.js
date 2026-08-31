const CACHE_TTL_SECONDS = 15 * 60;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [400, 1200, 2500];
const REQUEST_TIMEOUT_MS = 12000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function jitterMs() {
  return Math.floor(Math.random() * 350);
}

function noStoreHeaders(contentType = "text/plain; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  };
}

function normalizeRedditRssUrl(input) {
  const url = new URL(input.trim());
  if (!/(^|\.)reddit\.com$/i.test(url.hostname)) {
    throw new Error("Not a Reddit URL");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.(rss|json)$/i, "").replace(/\/+$/, "") + ".rss";
  return url.toString();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "poll-rss-worker/1.0",
      },
      cf: {
        cacheEverything: false,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchRssWithRetry(rssUrl) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(rssUrl, REQUEST_TIMEOUT_MS);
      if (response.ok) {
        return response;
      }
      if (!shouldRetryStatus(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < MAX_RETRIES) {
      const delay = (RETRY_DELAYS_MS[attempt] ?? 2500) + jitterMs();
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("RSS fetch failed");
}

export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);
  const inputUrl = requestUrl.searchParams.get("url");

  if (!inputUrl) {
    return new Response("Missing url query parameter", {
      status: 400,
      headers: noStoreHeaders(),
    });
  }

  let rssUrl;
  try {
    rssUrl = normalizeRedditRssUrl(inputUrl);
  } catch (error) {
    return new Response(error.message || "Invalid Reddit URL", {
      status: 400,
      headers: noStoreHeaders(),
    });
  }

  const cacheKeyUrl = new URL(requestUrl.origin + requestUrl.pathname);
  cacheKeyUrl.searchParams.set("url", rssUrl);
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Cache-Status", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  let upstream;
  try {
    upstream = await fetchRssWithRetry(rssUrl);
  } catch (error) {
    return new Response("Upstream fetch failed", {
      status: 502,
      headers: noStoreHeaders(),
    });
  }

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    return new Response(upstreamText || `Upstream error (${upstream.status})`, {
      status: upstream.status,
      headers: noStoreHeaders(upstream.headers.get("Content-Type") || "text/plain; charset=utf-8"),
    });
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/atom+xml; charset=utf-8");
  headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`);
  headers.set("X-Cache-Status", "MISS");

  const successResponse = new Response(upstreamText, {
    status: 200,
    headers,
  });

  await cache.put(cacheKey, successResponse.clone());
  return successResponse;
}
