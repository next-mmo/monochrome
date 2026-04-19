export const getProxyUrl = (url) => {
    if (window.__tidalOriginExtension) return url;
    // blob: URLs are local browser objects — a remote proxy can't fetch them
    if (url.startsWith('blob:')) return url;
    // Dev: local Vite middleware, Prod: Vercel Serverless Function
    const proxyBase = import.meta.env?.DEV
        ? '/proxy-audio'
        : '/api/proxy-audio';
    return `${proxyBase}?url=${encodeURIComponent(url)}`;
};

/**
 * Fetch with automatic retry on proxy failures (403, 429, 5xx).
 * Uses exponential backoff: 1s, 2s, 4s between attempts.
 *
 * @param {string} url - The URL to fetch (should already be proxy-wrapped if needed)
 * @param {RequestInit} [fetchOptions={}] - Standard fetch options
 * @param {object} [retryOptions={}] - Retry configuration
 * @param {number} [retryOptions.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [retryOptions.baseDelay=1000] - Base delay in ms (doubles each retry)
 * @returns {Promise<Response>} The successful response
 */
export const fetchWithProxyRetry = async (url, fetchOptions = {}, retryOptions = {}) => {
    const { maxRetries = 3, baseDelay = 1000 } = retryOptions;
    const retryableStatuses = new Set([403, 429, 500, 502, 503, 504]);

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (fetchOptions.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        try {
            const response = await fetch(url, fetchOptions);

            if (response.ok) {
                return response;
            }

            if (retryableStatuses.has(response.status) && attempt < maxRetries) {
                const delayMs = baseDelay * Math.pow(2, attempt);
                console.warn(
                    `Proxy request failed (${response.status}), retrying in ${delayMs}ms... ` +
                    `(attempt ${attempt + 1}/${maxRetries})`
                );
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }

            // Non-retryable status or exhausted retries
            lastError = new Error(`Fetch failed: ${response.status}`);
            lastError.status = response.status;
            lastError.response = response;

        } catch (err) {
            if (err.name === 'AbortError') throw err;

            if (attempt < maxRetries) {
                const delayMs = baseDelay * Math.pow(2, attempt);
                console.warn(
                    `Proxy request error: ${err.message}, retrying in ${delayMs}ms... ` +
                    `(attempt ${attempt + 1}/${maxRetries})`
                );
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
            }

            lastError = err;
        }
    }

    throw lastError;
};
