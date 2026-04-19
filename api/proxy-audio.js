// Vercel Serverless Function — CORS audio proxy for production
// Route: /api/proxy-audio?url=<encoded-url>

export default async function handler(req, res) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    }

    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const fetchOptions = {
            method: req.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        };

        // Forward range header for seeking
        if (req.headers.range) {
            fetchOptions.headers['Range'] = req.headers.range;
        }

        const response = await fetch(targetUrl, fetchOptions);

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

        // Forward response headers
        const contentType = response.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);

        const contentLength = response.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        const contentRange = response.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);

        const acceptRanges = response.headers.get('accept-ranges');
        if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

        res.status(response.status);

        if (req.method === 'HEAD') {
            return res.end();
        }

        // Stream the body
        const buffer = Buffer.from(await response.arrayBuffer());
        return res.send(buffer);
    } catch (err) {
        console.error('Proxy error:', err.message);
        return res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
}
