const STORAGE_KEY = 'monochrome-radio-tracks';

export const RADIO_CATEGORIES = [
    {
        id: 'podcast',
        label: 'Podcast',
        subs: [
            { id: 'all', label: 'All' },
            { id: 'khmer', label: 'Khmer' },
            { id: 'english', label: 'English' },
        ],
    },
    {
        id: 'music',
        label: 'Music',
        subs: [
            { id: 'all', label: 'All' },
            { id: 'khmer', label: 'Khmer' },
            { id: 'english', label: 'English' },
            { id: 'kpop', label: 'K-Pop' },
        ],
    },
    {
        id: 'offline',
        label: 'Offline',
        subs: [
            { id: 'all', label: 'All' },
            { id: 'khmer', label: 'Khmer' },
            { id: 'english', label: 'English' },
            { id: 'kpop', label: 'K-Pop' },
        ],
    },
];

const defaultTracks = [
    {
        id: 'radio-khmer-podcast',
        title: 'How to Live on 24 hours a day',
        artist: { name: 'Khmer Podcast' },
        artists: [{ name: 'Khmer Podcast' }],
        album: { name: 'Radio Stream' },
        audioUrl: 'https://weread-oss.weread.asia/Audio/How to Live on 24 hours a day_mixdown.mp3',
        category: 'podcast',
        subcategory: 'khmer',
        type: 'track',
        provider: 'custom',
        isLocal: false,
        duration: 0,
    },
    {
        id: 'movie-samkok',
        title: 'សាមកុក-Samkok',
        artist: { name: 'Movie' },
        artists: [{ name: 'Movie' }],
        album: { name: 'Movies' },
        audioUrl: 'https://geo.dailymotion.com/player.html?playlist=xc2odc',
        category: 'movie',
        subcategory: 'khmer',
        type: 'track',
        provider: 'custom',
        isLocal: false,
        duration: 0,
    },
];

async function loadTracks() {
    try {
        const res = await fetch(`/radio-tracks.json?t=${Date.now()}`);
        if (res.ok) {
            const parsed = await res.json();
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {
        console.warn('Failed to load radio tracks from API, falling back', e);
    }
    return [...defaultTracks];
}

async function loadPodcastTracks() {
    try {
        const url =
            'https://api-ap-northeast-1.graphcms.com/v2/cl37clyyk82h601xq9zcjf9h4/master?query=query%20content_view_b006b6b5e6b04f10b710592b33f658a8(%20%24where%3A%20ListWhereInput%2C%20%24orderBy%3A%20ListOrderByInput)%20%7B%0A%20%20page%3A%20listsConnection(%0A%20%20%20%20first%3A%201000%0A%20%20%20%20stage%3A%20DRAFT%0A%20%20%20%20where%3A%20%24where%0A%20%20%20%20orderBy%3A%20%24orderBy%0A%20%20)%20%7B%0A%20%20%20%20edges%20%7B%0A%20%20%20%20%20%20node%20%7B%0A%20%20%20%20%20%20%20%20id%0A%20%20%20%20%20%20%20%20stage%0A%20%20%20%20%20%20%20%20data%0A%20%20%20%20%20%20%20%20id%0A%20%20%20%20%0A%20%20%20%20%20%20%7D%0A%20%20%20%20%7D%0A%20%20%20%20aggregate%20%7B%0A%20%20%20%20%20%20count%0A%20%20%20%20%7D%0A%20%20%7D%0A%7D%0A&operationName=content_view_b006b6b5e6b04f10b710592b33f658a8';
        const res = await fetch(url, {
            headers: {
                accept: '*/*',
                origin: 'https://kamsan-daily.netlify.app',
                referer: 'https://kamsan-daily.netlify.app/',
            },
        });
        const json = await res.json();

        let items = [];
        if (json?.data?.page?.edges?.[0]?.node?.data) {
            items = json.data.page.edges[0].node.data;
        }

        const tracks = [];
        items.forEach((item) => {
            if (item.audioUrl) {
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
            }
        });
        return tracks;
    } catch (e) {
        console.error('Failed to load podcasts from API:', e);
        return [];
    }
}

async function loadTracksByFilter(category, subcategory) {
    if (category === 'offline') {
        try {
            const { getAllOfflineTracks, buildPlayableTrack } = await import('./offline.js');
            const entries = await getAllOfflineTracks();
            let offlineTracks = entries.map((entry) => {
                const t = buildPlayableTrack(entry);
                t.category = 'offline';
                return t;
            });
            if (subcategory && subcategory !== 'all') {
                offlineTracks = offlineTracks.filter(
                    (t) =>
                        t.subcategory === subcategory ||
                        (t.genre && t.genre.toLowerCase() === subcategory.toLowerCase())
                );
            }
            return offlineTracks;
        } catch (e) {
            console.warn('Failed to load offline tracks for radio', e);
            return [];
        }
    }

    let tracks = await loadTracks();

    // Merge dynamic podcast tracks
    const podcastTracks = await loadPodcastTracks();
    tracks = [...tracks, ...podcastTracks];

    if (category && category !== 'all') {
        tracks = tracks.filter((t) => t.category === category);
    }
    if (subcategory && subcategory !== 'all') {
        tracks = tracks.filter((t) => t.subcategory === subcategory);
    }
    return tracks;
}

async function saveTracks(tracks) {
    try {
        await fetch('/api/radio-tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tracks),
        });
    } catch (e) {
        console.error('Failed to save radio tracks via API', e);
    }
}

async function addTrack(track) {
    const tracks = await loadTracks();
    tracks.push({
        id: track.id || `radio-${Date.now()}`,
        title: track.title || 'Untitled',
        artist: { name: track.artistName || 'Unknown' },
        artists: [{ name: track.artistName || 'Unknown' }],
        album: { name: track.albumName || 'Radio Stream' },
        audioUrl: track.audioUrl,
        category: track.category || 'music',
        subcategory: track.subcategory || 'khmer',
        type: 'track',
        provider: 'custom',
        isLocal: false,
        duration: 0,
    });
    await saveTracks(tracks);
    return tracks;
}

async function removeTrack(trackId) {
    const tracks = await loadTracks();
    const filtered = tracks.filter((t) => t.id !== trackId);
    await saveTracks(filtered);
    return filtered;
}

async function clearTracks() {
    await saveTracks([]);
    return [];
}

async function resetToDefaults() {
    await saveTracks([...defaultTracks]);
    return [...defaultTracks];
}

// Initial tracks might not be loaded synchronously anymore, so we remove the synchronous export
// and clients should use `await radioTrackManager.loadTracks()` instead.
// export const radioTracks = loadTracks();
export const radioTrackManager = {
    loadTracks,
    loadTracksByFilter,
    saveTracks,
    addTrack,
    removeTrack,
    clearTracks,
    resetToDefaults,
};
