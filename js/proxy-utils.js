/**
 * Multi-proxy CORS audio proxy with automatic failover.
 * Tries each proxy in order; dead proxies are skipped for the rest of the session.
 */

// ── Proxy registry ──────────────────────────────────────────────────────────
// Each entry defines how to build the proxied URL for a given target.
// Order matters: first = preferred, last = last resort.
const PROXY_LIST = [
    {
        name: 'binimum',
        buildUrl: (url) => `https://audio-proxy.binimum.org/proxy-audio?url=${encodeURIComponent(url)}`,
    },
    {
        name: 'corsproxy.io',
        buildUrl: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    },
    {
        name: 'corsfix',
        buildUrl: (url) => `https://proxy.corsfix.com/?${encodeURIComponent(url)}`,
    },
    {
        name: 'allorigins',
        buildUrl: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    },
    {
        name: 'cors.sh',
        buildUrl: (url) => `https://proxy.cors.sh/${url}`,
    },
    {
        name: 'codetabs',
        buildUrl: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    },
    {
        name: 'cors-anywhere',
        buildUrl: (url) => `https://cors-anywhere.herokuapp.com/${url}`,
    },
    {
        name: 'everyorigin',
        buildUrl: (url) => `https://api.everyorigin.com/get?url=${encodeURIComponent(url)}`,
    },
    {
        name: 'killcors',
        buildUrl: (url) => `https://proxy.killcors.com?url=${encodeURIComponent(url)}`,
    },
    {
        name: 'whateverorigin',
        buildUrl: (url) => `https://whateverorigin.org/get?url=${encodeURIComponent(url)}`,
    },
    {
        name: 'htmldriven',
        buildUrl: (url) => `https://cors-proxy.htmldriven.com/?url=${encodeURIComponent(url)}`,
    },
    {
        name: 'cors.io',
        buildUrl: (url) => `https://cors.io/?url=${encodeURIComponent(url)}`,
    },
];

// Track which proxies are marked as dead so we skip them on subsequent calls
// within the same session. Resets on page reload.
const _deadProxies = new Set();

// Returns a single proxied URL (used for simple cases like Shaka segment rewriting).
// Picks the first alive proxy from the list.
export const getProxyUrl = (url) => {
    if (window.__tidalOriginExtension) return url;
    if (url.startsWith('blob:')) return url;

    // Pick the first proxy that isn't dead
    for (const proxy of PROXY_LIST) {
        if (!_deadProxies.has(proxy.name)) {
            return proxy.buildUrl(url);
        }
    }

    // All dead? Reset and try the first one anyway
    _deadProxies.clear();
    return PROXY_LIST[0].buildUrl(url);
};

// ── fetchWithProxyRetry ─────────────────────────────────────────────────────
// Fetches a URL through multiple proxies with automatic failover.
// 1. Retries on the same proxy with exponential backoff (for transient errors).
// 2. If a proxy is persistently failing, moves to the next proxy in the list.
// 3. Marks dead proxies so future calls skip them within the session.

/**
 * @param {string} originalUrl - The real (non-proxied) target URL
 * @param {RequestInit} [fetchOptions={}]
 * @param {object} [retryOptions={}]
 * @param {number} [retryOptions.maxRetries=2] - Retries per proxy before moving on
 * @param {number} [retryOptions.baseDelay=3000] - Base delay in ms (doubles each retry, with jitter)
 * @returns {Promise<Response>}
 */
export const fetchWithProxyRetry = async (proxyUrl, fetchOptions = {}, retryOptions = {}) => {
    const { maxRetries = 2, baseDelay = 3000 } = retryOptions;
    const retryableStatuses = new Set([403, 429, 500, 502, 503, 504]);

    // Try to extract the original URL; if we can't, it's not proxy-wrapped
    const originalUrl = _extractTargetUrl(proxyUrl);
    if (!originalUrl) {
        return _retryFetch(proxyUrl, fetchOptions, { maxRetries, baseDelay, retryableStatuses });
    }

    // Try each proxy in order
    let lastError;

    for (const proxy of PROXY_LIST) {
        if (_deadProxies.has(proxy.name)) continue;
        if (fetchOptions.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const url = proxy.buildUrl(originalUrl);

        try {
            const response = await _retryFetch(url, fetchOptions, {
                maxRetries,
                baseDelay,
                retryableStatuses,
            });
            return response;
        } catch (err) {
            if (err.name === 'AbortError') throw err;

            console.warn(`Proxy "${proxy.name}" failed: ${err.message}, trying next...`);
            _deadProxies.add(proxy.name);

            // Pause between proxy switches to avoid rapid-fire requests
            await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
            lastError = err;
        }
    }

    // All proxies exhausted — last resort: try direct fetch (may work for some CDNs)
    console.warn('All proxies failed, attempting direct fetch...');
    try {
        const response = await fetch(originalUrl, fetchOptions);
        if (response.ok) return response;
        lastError = new Error(`Direct fetch failed: ${response.status}`);
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
    }

    throw lastError;
};

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Exponential backoff with random jitter (±30%) to avoid thundering herd.
 * e.g. base=3000: ~3s, ~6s, ~12s (each ±30%)
 */
function _jitteredDelay(baseDelay, attempt) {
    const delay = baseDelay * Math.pow(2, attempt);
    const jitter = delay * 0.3 * (2 * Math.random() - 1); // ±30%
    return Math.max(500, delay + jitter);
}

/**
 * Simple retry loop for a single URL with exponential backoff.
 */
async function _retryFetch(url, fetchOptions, { maxRetries, baseDelay, retryableStatuses }) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (fetchOptions.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        try {
            const response = await fetch(url, fetchOptions);

            if (response.ok) return response;

            if (retryableStatuses.has(response.status) && attempt < maxRetries) {
                const delayMs = _jitteredDelay(baseDelay, attempt);
                console.warn(
                    `Request failed (${response.status}), retrying in ${Math.round(delayMs)}ms... ` +
                    `(attempt ${attempt + 1}/${maxRetries})`
                );
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }

            lastError = new Error(`Fetch failed: ${response.status}`);
            lastError.status = response.status;
            lastError.response = response;
        } catch (err) {
            if (err.name === 'AbortError') throw err;

            if (attempt < maxRetries) {
                const delayMs = _jitteredDelay(baseDelay, attempt);
                console.warn(
                    `Request error: ${err.message}, retrying in ${Math.round(delayMs)}ms... ` +
                    `(attempt ${attempt + 1}/${maxRetries})`
                );
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }

            lastError = err;
        }
    }

    throw lastError;
}

/**
 * Extract the original target URL from a proxy-wrapped URL.
 */
function _extractTargetUrl(proxyUrl) {
    try {
        // Handle ?url= pattern (allorigins, binimum, everyorigin)
        const urlMatch = proxyUrl.match(/[?&]url=([^&]+)/);
        if (urlMatch) return decodeURIComponent(urlMatch[1]);

        // Handle ?quest= pattern (codetabs)
        const questMatch = proxyUrl.match(/[?&]quest=([^&]+)/);
        if (questMatch) return decodeURIComponent(questMatch[1]);

        // Handle bare query string pattern: ?https://... (corsproxy.io, corsfix)
        const bareMatch = proxyUrl.match(/\?(https?%3A.+)$/i);
        if (bareMatch) return decodeURIComponent(bareMatch[1]);

        // Handle path-based pattern: https://proxy.example.com/https://target.com (cors.sh, cors-anywhere)
        const pathMatch = proxyUrl.match(/^https?:\/\/[^/]+\/(https?:\/\/.+)$/);
        if (pathMatch) return pathMatch[1];
    } catch {
        // ignore
    }
    return null;
}
