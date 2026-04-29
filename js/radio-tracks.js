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
        id: 'movie',
        label: 'Movie',
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
