import fs from 'fs';
import path from 'path';

export default function radioTracksPlugin() {
    return {
        name: 'vite-plugin-radio-tracks',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url === '/api/radio-tracks' && req.method === 'POST') {
                    let body = '';
                    req.on('data', chunk => {
                        body += chunk.toString();
                    });
                    req.on('end', () => {
                        try {
                            const tracks = JSON.parse(body);
                            const filePath = path.resolve(process.cwd(), 'public', 'radio-tracks.json');
                            fs.writeFileSync(filePath, JSON.stringify(tracks, null, 2));
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ success: true }));
                        } catch (err) {
                            res.statusCode = 400;
                            res.end(JSON.stringify({ success: false, error: err.message }));
                        }
                    });
                    return;
                }
                next();
            });
        }
    };
}
