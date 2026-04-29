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
];

function loadTracks() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {
        console.warn('Failed to load radio tracks from storage', e);
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

    let tracks = loadTracks();
    if (category && category !== 'all') {
        tracks = tracks.filter((t) => t.category === category);
    }
    if (subcategory && subcategory !== 'all') {
        tracks = tracks.filter((t) => t.subcategory === subcategory);
    }
    return tracks;
}

function saveTracks(tracks) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
}

function addTrack(track) {
    const tracks = loadTracks();
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
    saveTracks(tracks);
    return tracks;
}

function removeTrack(trackId) {
    const tracks = loadTracks().filter((t) => t.id !== trackId);
    saveTracks(tracks);
    return tracks;
}

function clearTracks() {
    saveTracks([]);
    return [];
}

function resetToDefaults() {
    saveTracks([...defaultTracks]);
    return [...defaultTracks];
}

export const radioTracks = loadTracks();
export const radioTrackManager = {
    loadTracks,
    loadTracksByFilter,
    saveTracks,
    addTrack,
    removeTrack,
    clearTracks,
    resetToDefaults,
};
