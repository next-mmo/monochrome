const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');
const tracksPath = path.join(__dirname, '..', '..', 'public', 'radio-tracks.json');

try {
    const dataRaw = fs.readFileSync(dataPath, 'utf8');
    const dataJson = JSON.parse(dataRaw);
    const items = dataJson.data.page.edges[0].node.data;

    const tracksRaw = fs.readFileSync(tracksPath, 'utf8');
    const tracks = JSON.parse(tracksRaw);

    let addedCount = 0;

    items.forEach((item) => {
        // Only insert if there's a valid audio URL and it's not already in the list
        if (item.audioUrl && !tracks.some((t) => t.audioUrl === item.audioUrl)) {
            tracks.push({
                id: 'radio-imported-' + item.id,
                title: item.title,
                artist: { name: item.author || 'Unknown' },
                artists: [{ name: item.author || 'Unknown' }],
                album: { name: 'Podcasts' },
                audioUrl: item.audioUrl,
                category: 'podcast',
                subcategory: 'khmer',
                type: 'track',
                provider: 'custom',
                isLocal: false,
                duration: 0,
            });
            addedCount++;
        }
    });

    fs.writeFileSync(tracksPath, JSON.stringify(tracks, null, 4));
    console.log(`Successfully inserted ${addedCount} new tracks from data.json!`);
} catch (e) {
    console.error('Error inserting data:', e);
}
