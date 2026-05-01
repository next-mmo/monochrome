//js/lyrics.js
import { getTrackTitle, getTrackArtists, buildTrackFilename } from './utils.js';
import {
    SVG_CLOSE,
    SVG_GENIUS_ACTIVE,
    SVG_GENIUS_INACTIVE,
    SVG_MINUS,
    SVG_PLUS,
    SVG_RESET,
    SVG_GLOBE,
} from './icons.js';
import { sidePanelManager } from './side-panel.js';
import { getProxyUrl, fetchWithProxyRetry } from './proxy-utils.js';

const loadAmLyrics = () => {
    const images = Array.from(document.images).filter((img) => !img.complete);
    if (images.length === 0) {
        import('@uimaxbai/am-lyrics/am-lyrics.js').catch(console.error);
    } else {
        Promise.all(
            images.map(
                (img) =>
                    new Promise((res) => {
                        img.onload = img.onerror = res;
                    })
            )
        ).then(() => import('@uimaxbai/am-lyrics/am-lyrics.js').catch(console.error));
    }
};

if (document.readyState === 'complete') {
    loadAmLyrics();
} else {
    window.addEventListener('load', loadAmLyrics);
}

// Check if text contains Japanese, Chinese, or Korean characters
function containsAsianText(text) {
    if (!text) return false;
    // Japanese: Hiragana (3040-309F), Katakana (30A0-30FF), Kanji (4E00-9FFF, 3400-4DBF)
    // Chinese: CJK Unified Ideographs (4E00-9FFF, 3400-4DBF)
    // Korean: Hangul (AC00-D7AF, 1100-11FF, 3130-318F)
    const asianRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
    return asianRegex.test(text);
}

// Check if track has Asian text in title or artist names
function trackHasAsianText(track) {
    if (!track) return false;
    const title = track.title || '';
    const artist = getTrackArtists(track) || '';
    return containsAsianText(title) || containsAsianText(artist);
}

function cleanTrackerSearch(text) {
    if (!text) return '';
    // chud emojis will NOT be tolerated in my precious genius lyrics worker
    let cleaned = text.replace(
        /[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Symbol}]/gu,
        ''
    );

    cleaned = cleaned.replace(/[\u2600-\u27BF\u2B50\u2B06\u2194\u21AA\u2934\u203C\u2049\u3030\u303D\u3297\u3299]/g, '');

    cleaned = cleaned.replace(/\[v\s*\d+\s*\]/gi, '');

    cleaned = cleaned.replace(/\s+/g, ' ');

    return cleaned.trim();
}

class GeniusManager {
    constructor() {
        this.cache = new Map();
        this.loading = false;
    }

    // idgaf anymore im js hardcoding this lmaooo
    getToken() {
        const hostname = window.location.hostname;
        if (hostname.endsWith('monochrome.tf') || hostname === 'monochrome.tf') {
            return 'OpITG-h86oehKYuJJ5QVY5F-HxUWXb31EwGKarx2Tle3W9rBUVnMaUL9qo_Oh9Q7';
        }
        return 'QmS9OvsS-7ifRBKx_ochIPQU7oejIS9Eo_z5iWHmCPyhwLVQID3pYTHJmJTa6z8z';
    }

    async searchTrack(title, artist) {
        const cleanTitle = title.split('(')[0].split('-')[0].trim();
        const query = encodeURIComponent(`${cleanTitle} ${artist}`);
        const token = this.getToken();

        const url = `https://api.genius.com/search?q=${query}&access_token=${token}`;
        const response = await fetch(url);

        if (!response.ok) throw new Error('Failed to search Genius');

        const data = await response.json();
        if (data.response.hits.length === 0) return null;

        const normalize = (str) => str.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const targetArtist = normalize(artist);

        const hit = data.response.hits.find((h) => {
            const hitArtist = normalize(h.result.primary_artist.name);
            return hitArtist.includes(targetArtist) || targetArtist.includes(hitArtist);
        });

        return hit ? hit.result : data.response.hits[0].result;
    }

    async getReferents(songId) {
        const token = this.getToken();
        const url = `https://api.genius.com/referents?song_id=${songId}&text_format=plain&per_page=50&access_token=${token}`;
        const response = await fetch(url);

        if (!response.ok) throw new Error('Failed to fetch annotations');

        const data = await response.json();
        return data.response.referents;
    }

    async getDataForTrack(track) {
        if (this.cache.has(track.id)) return this.cache.get(track.id);

        try {
            this.loading = true;
            const artist = Array.isArray(track.artists) ? track.artists[0].name : track.artist.name;
            const song = await this.searchTrack(track.title, artist);

            if (!song) {
                this.loading = false;
                return null;
            }

            const referents = await this.getReferents(song.id);
            const result = { song, referents };

            this.cache.set(track.id, result);
            this.loading = false;
            return result;
        } catch (error) {
            console.error('Genius Error:', error);
            this.loading = false;
            throw error;
        }
    }

    findAnnotations(lineText, referents) {
        if (!referents || !lineText) return [];

        const normalize = (str) =>
            str
                .toLowerCase()
                .replace(/[^\p{L}\p{N}\s]/gu, '')
                .replace(/\s+/g, ' ')
                .trim();
        const normLine = normalize(lineText);

        const getWordSet = (str) => new Set(str.split(' ').filter((w) => w.length > 0));
        const lineWords = getWordSet(normLine);

        return referents.filter((ref) => {
            const normFragment = normalize(ref.fragment);

            if (normLine.includes(normFragment) || normFragment.includes(normLine)) return true;

            const fragmentWords = getWordSet(normFragment);
            if (fragmentWords.size === 0 || lineWords.size === 0) return false;

            let matchCount = 0;
            fragmentWords.forEach((w) => {
                if (lineWords.has(w)) matchCount++;
            });

            return matchCount / Math.min(fragmentWords.size, lineWords.size) > 0.6;
        });
    }
}

export class LyricsManager {
    static #instance = null;

    static get instance() {
        if (!LyricsManager.#instance) {
            throw new Error('LyricsManager is not initialized. Call LyricsManager.initialize() first.');
        }
        return LyricsManager.#instance;
    }

    /** @private */
    constructor(api) {
        this.api = api;
        this.currentLyrics = null;
        this.syncedLyrics = [];
        this.lyricsCache = new Map();
        this.componentLoaded = false;
        this.amLyricsElement = null;
        this.animationFrameId = null;
        this.currentTrackId = null;
        this.mutationObserver = null;
        this.romajiObserver = null;
        this.isRomajiMode = false;
        this.originalLyricsData = null;
        this.kuroshiroLoaded = false;
        this.kuroshiroLoading = false;
        this.romajiTextCache = new Map(); // Cache: originalText -> convertedRomaji
        this.convertedTracksCache = new Set(); // Track IDs that have been fully converted
        this.geniusManager = new GeniusManager();
        this.isGeniusMode = false;
        this.currentGeniusData = null;
        this.timingOffset = 0; // Offset in milliseconds (positive = delay lyrics, negative = advance lyrics)
    }

    static async initialize(api) {
        if (LyricsManager.#instance) {
            throw new Error('LyricsManager is already initialized');
        }
        return (LyricsManager.#instance = new LyricsManager(api));
    }

    // Get timing offset for current track
    getTimingOffset(trackId) {
        try {
            const key = `lyrics-offset-${trackId}`;
            const stored = localStorage.getItem(key);
            return stored ? parseInt(stored, 10) : 0;
        } catch {
            return 0;
        }
    }

    // Set timing offset for current track
    setTimingOffset(trackId, offsetMs) {
        try {
            const key = `lyrics-offset-${trackId}`;
            localStorage.setItem(key, offsetMs.toString());
        } catch (e) {
            console.warn('Failed to save lyrics timing offset:', e);
        }
    }

    // Reset timing offset for current track
    resetTimingOffset(trackId) {
        this.setTimingOffset(trackId, 0);
    }

    // Get formatted offset display string
    getOffsetDisplayString(offsetMs) {
        const sign = offsetMs >= 0 ? '+' : '';
        const seconds = Math.abs(offsetMs) / 1000;
        return `${sign}${seconds.toFixed(1)}s`;
    }

    // Load Kuroshiro from CDN (npm package uses Node.js path which doesn't work in browser)
    async loadKuroshiro() {
        if (this.kuroshiroLoaded) return true;
        if (this.kuroshiroLoading) {
            // Wait for existing load to complete
            return new Promise((resolve) => {
                const checkLoad = setInterval(() => {
                    if (!this.kuroshiroLoading) {
                        clearInterval(checkLoad);
                        resolve(this.kuroshiroLoaded);
                    }
                }, 100);
            });
        }

        this.kuroshiroLoading = true;
        try {
            // Bug on kuromoji@0.1.2 where it mangles absolute URLs
            // Using self-hosted dict files is failed, so we use CDN with monkey-patch
            // Monkey-patch XMLHttpRequest to redirect dictionary requests to CDN
            // Kuromoji uses XHR, not fetch, for loading dictionary files
            if (!window._originalXHROpen) {
                // eslint-disable-next-line @typescript-eslint/unbound-method
                window._originalXHROpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                    const urlStr = url.toString();
                    if (urlStr.includes('/dict/') && urlStr.includes('.dat.gz')) {
                        // Extract just the filename
                        const filename = urlStr.split('/').pop();
                        // Redirect to CDN
                        const cdnUrl = `https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/${filename}`;
                        return window._originalXHROpen.call(this, method, cdnUrl, ...rest);
                    }
                    return window._originalXHROpen.call(this, method, url, ...rest);
                };
            }

            // Also patch fetch just in case
            if (!window._originalFetch) {
                window._originalFetch = window.fetch;
                window.fetch = async (url, options) => {
                    const urlStr = url instanceof URL ? url.toString() : url.url;
                    if (urlStr.includes('/dict/') && urlStr.includes('.dat.gz')) {
                        const filename = urlStr.split('/').pop();
                        const cdnUrl = `https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/${filename}`;
                        console.log(`Redirecting dict fetch: ${filename} -> CDN`);
                        return window._originalFetch(cdnUrl, options);
                    }
                    return window._originalFetch(url, options);
                };
            }

            // Load Kuroshiro from CDN
            if (!window.Kuroshiro) {
                await this.loadScript('https://cdn.jsdelivr.net/npm/kuroshiro@1.2.0/dist/kuroshiro.min.js');
            }

            // Load Kuromoji analyzer from CDN
            if (!window.KuromojiAnalyzer) {
                await this.loadScript(
                    'https://cdn.jsdelivr.net/npm/kuroshiro-analyzer-kuromoji@1.1.0/dist/kuroshiro-analyzer-kuromoji.min.js'
                );
            }

            // Initialize Kuroshiro (CDN version exports as .default)
            const Kuroshiro = window.Kuroshiro.default || window.Kuroshiro;
            const KuromojiAnalyzer = window.KuromojiAnalyzer.default || window.KuromojiAnalyzer;

            this.kuroshiro = new Kuroshiro();

            // Initialize with a dummy path - our fetch interceptor will redirect to CDN
            await this.kuroshiro.init(
                new KuromojiAnalyzer({
                    dictPath: '/dict/', // This gets mangled but our interceptor fixes it
                })
            );

            this.kuroshiroLoaded = true;
            this.kuroshiroLoading = false;
            console.log('✓ Kuroshiro loaded and initialized successfully');
            return true;
        } catch (error) {
            console.error('✗ Failed to load Kuroshiro:', error);
            this.kuroshiroLoaded = false;
            this.kuroshiroLoading = false;
            return false;
        }
    }

    // Helper to load external scripts
    loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if script already exists
            if (document.querySelector(`script[src="${src}"]`)) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
        });
    }

    // Check if text contains Japanese characters
    containsJapanese(text) {
        if (!text) return false;
        // Match any Japanese character (Hiragana, Katakana, Kanji)
        return /[\u3040-\u30FF\u31F0-\u9FFF]/.test(text);
    }

    // Convert Japanese text to Romaji (including Kanji) with caching
    async convertToRomaji(text) {
        if (!text) return text;

        // Check cache first
        if (this.romajiTextCache.has(text)) {
            return this.romajiTextCache.get(text);
        }

        // Only process if text contains Asian characters
        if (!containsAsianText(text)) {
            return text;
        }

        // Make sure Kuroshiro is loaded
        if (!this.kuroshiroLoaded) {
            const success = await this.loadKuroshiro();
            if (!success) {
                console.warn('Kuroshiro not available, skipping conversion');
                return text;
            }
        }

        if (!this.kuroshiro) {
            console.warn('Kuroshiro not available, skipping conversion');
            return text;
        }

        try {
            // Convert to Romaji using Kuroshiro (handles Kanji, Hiragana, Katakana)
            const result = await this.kuroshiro.convert(text, {
                to: 'romaji',
                mode: 'spaced',
                romajiSystem: 'hepburn',
            });
            // Cache the result
            this.romajiTextCache.set(text, result);
            return result;
        } catch (error) {
            console.warn('Romaji conversion failed for text:', text.substring(0, 30), error);
            return text;
        }
    }

    // Set Romaji mode and save preference
    setRomajiMode(enabled) {
        this.isRomajiMode = enabled;
        try {
            localStorage.setItem('lyricsRomajiMode', enabled ? 'true' : 'false');
        } catch (e) {
            console.warn('Failed to save Romaji mode preference:', e);
        }
    }

    // Get saved Romaji mode preference
    getRomajiMode() {
        try {
            return localStorage.getItem('lyricsRomajiMode') === 'true';
        } catch {
            return false;
        }
    }

    async ensureComponentLoaded() {
        if (this.componentLoaded) return;

        if (typeof customElements !== 'undefined') {
            await customElements.whenDefined('am-lyrics');
            this.componentLoaded = true;
        }
    }

    async fetchLyrics(trackId, track = null) {
        if (track) {
            if (this.lyricsCache.has(trackId)) {
                return this.lyricsCache.get(trackId);
            }

            try {
                const artist = Array.isArray(track.artists)
                    ? track.artists.map((a) => a.name || a).join(', ')
                    : track.artist?.name || '';
                const title = track.title || '';
                const album = track.album?.title || '';
                const duration = track.duration ? Math.round(track.duration) : null;

                if (!title || !artist) {
                    console.warn('Missing required fields for LRCLIB');
                    return null;
                }

                const params = new URLSearchParams({
                    track_name: title,
                    artist_name: artist,
                });

                if (album) params.append('album_name', album);
                if (duration) params.append('duration', duration.toString());

                const response = await fetch(`https://lrclib.net/api/get?${params.toString()}`);

                if (response.ok) {
                    const data = await response.json();

                    if (data.syncedLyrics) {
                        const lyricsData = {
                            subtitles: data.syncedLyrics,
                            lyricsProvider: 'LRCLIB',
                        };

                        this.lyricsCache.set(trackId, lyricsData);
                        return lyricsData;
                    }
                }
            } catch (error) {
                console.warn('LRCLIB fetch failed:', error);
            }
        }

        return null;
    }

    parseSyncedLyrics(subtitles) {
        if (!subtitles) return [];
        const lines = subtitles.split('\n').filter((line) => line.trim());
        return lines
            .map((line) => {
                const match = line.match(/\[(\d+):(\d+)\.(\d+)\]\s*(.+)/);
                if (match) {
                    const [, minutes, seconds, centiseconds, text] = match;
                    const timeInSeconds = parseInt(minutes) * 60 + parseInt(seconds) + parseInt(centiseconds) / 100;
                    return { time: timeInSeconds, text: text.trim() };
                }
                return null;
            })
            .filter(Boolean);
    }

    generateLRCContent(lyricsData, track) {
        if (!lyricsData || !lyricsData.subtitles) return null;

        const trackTitle = getTrackTitle(track);
        const trackArtist = getTrackArtists(track);

        let lrc = `[ti:${trackTitle}]\n`;
        lrc += `[ar:${trackArtist}]\n`;
        lrc += `[al:${track.album?.title || 'Unknown Album'}]\n`;
        lrc += `[by:${lyricsData.lyricsProvider || 'Unknown'}]\n`;
        lrc += '\n';
        lrc += lyricsData.subtitles;

        return lrc;
    }

    getLRC(lyricsData, track) {
        const lrcContent = this.generateLRCContent(lyricsData, track);
        if (!lrcContent) {
            alert('No synced lyrics available for this track');
            return;
        }

        return new File([lrcContent], buildTrackFilename(track, 'LOSSLESS').replace(/\.flac$/, '.lrc'), {
            type: 'application/octet-stream',
        });
    }

    downloadLRC(lyricsData, track) {
        const blob = this.getLRC(lyricsData, track);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = blob.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    getCurrentLine(currentTime) {
        if (!this.syncedLyrics || this.syncedLyrics.length === 0) return -1;
        let currentIndex = -1;
        for (let i = 0; i < this.syncedLyrics.length; i++) {
            if (currentTime >= this.syncedLyrics[i].time) {
                currentIndex = i;
            } else {
                break;
            }
        }
        return currentIndex;
    }

    // Setup MutationObserver to convert lyrics in am-lyrics component
    async setupLyricsObserver(amLyricsElement) {
        this.stopLyricsObserver();

        if (!amLyricsElement) return;

        // Check for shadow DOM
        const observeRoot = amLyricsElement.shadowRoot || amLyricsElement;

        this.romajiObserver = new MutationObserver((mutations) => {
            // Check if any relevant mutation occurred
            const hasRelevantChange = mutations.some((mutation) => {
                if (mutation.type === 'childList') {
                    let relevant = false;
                    if (mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('genius-indicator'))
                                continue;
                            relevant = true;
                            break;
                        }
                    }
                    if (!relevant && mutation.removedNodes.length > 0) {
                        for (const node of mutation.removedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('genius-indicator'))
                                continue;
                            relevant = true;
                            break;
                        }
                    }
                    return relevant;
                }
                if (mutation.type === 'characterData') return true;
                return false;
            });

            if (!hasRelevantChange) {
                return;
            }

            // Debounce mutations
            if (this.observerTimeout) {
                clearTimeout(this.observerTimeout);
            }
            this.observerTimeout = setTimeout(async () => {
                if (this.isRomajiMode) {
                    await this.convertLyricsContent(amLyricsElement);
                }
                if (this.isGeniusMode && this.currentGeniusData) {
                    await this.applyGeniusAnnotations(amLyricsElement, this.currentGeniusData.referents);
                }
            }, 100);
        });

        // Observe all child nodes for changes (in shadow DOM if it exists)
        // Watch for new nodes AND text content changes to catch when lyrics refresh
        this.romajiObserver.observe(observeRoot, {
            childList: true,
            subtree: true,
            characterData: true, // Watch text changes to catch lyric refreshes
            attributes: false, // Don't watch attribute changes (highlight, etc)
        });

        // Initial conversion if Romaji mode is enabled - single attempt, no periodic polling
        if (this.isRomajiMode) {
            await this.convertLyricsContent(amLyricsElement);
        }
        if (this.isGeniusMode && this.currentGeniusData) {
            await this.applyGeniusAnnotations(amLyricsElement, this.currentGeniusData.referents);
        }
    }

    // Convert lyrics content to Romaji
    async convertLyricsContent(amLyricsElement) {
        if (!amLyricsElement || !this.isRomajiMode) {
            return;
        }

        // Find the root to traverse - check for shadow DOM first
        const rootToTraverse = amLyricsElement.shadowRoot || amLyricsElement;

        // Make sure Kuroshiro is ready
        if (!this.kuroshiroLoaded) {
            const success = await this.loadKuroshiro();
            if (!success) {
                console.warn('Cannot convert lyrics - Kuroshiro load failed');
                return;
            }
        }

        // Find all text nodes in the component
        const textNodes = [];
        const walker = document.createTreeWalker(rootToTraverse, NodeFilter.SHOW_TEXT, null, false);

        let node;
        while ((node = walker.nextNode())) {
            textNodes.push(node);
        }

        // Convert Japanese text to Romaji (using async/await for Kuroshiro)
        for (const textNode of textNodes) {
            if (!textNode.parentElement) {
                continue;
            }

            const parentTag = textNode.parentElement.tagName?.toLowerCase();
            const parentClass = String(textNode.parentElement.className || '');

            // Skip elements that shouldn't be converted
            const skipTags = ['script', 'style', 'code', 'input', 'textarea', 'time'];
            if (skipTags.includes(parentTag)) {
                continue;
            }

            const originalText = textNode.textContent;

            // Skip progress indicators and timestamps (but NOT progress-text which is the actual lyrics!)
            if (
                (parentClass.includes('progress') && !parentClass.includes('progress-text')) ||
                (parentClass.includes('time') && !parentClass.includes('progress-text')) ||
                parentClass.includes('timestamp')
            ) {
                continue;
            }

            if (!originalText || originalText.trim().length === 0) {
                continue;
            }

            // Check if contains Japanese - convert if we find Japanese
            if (this.containsJapanese(originalText)) {
                const romajiText = await this.convertToRomaji(originalText);

                // Only update if conversion produced different text
                if (romajiText && romajiText !== originalText) {
                    textNode.textContent = romajiText;
                }
            }
        }

        // Mark this track as converted
        if (this.currentTrackId) {
            this.convertedTracksCache.add(this.currentTrackId);
        }
    }

    // Stop the observer
    stopLyricsObserver() {
        if (this.romajiObserver) {
            this.romajiObserver.disconnect();
            this.romajiObserver = null;
        }
        if (this.observerTimeout) {
            clearTimeout(this.observerTimeout);
            this.observerTimeout = null;
        }
    }

    // Toggle Romaji mode
    async toggleRomajiMode(amLyricsElement) {
        this.isRomajiMode = !this.isRomajiMode;
        this.setRomajiMode(this.isRomajiMode);

        if (amLyricsElement) {
            if (this.isRomajiMode) {
                // Turning ON: Setup observer and convert immediately
                await this.setupLyricsObserver(amLyricsElement);
                await this.convertLyricsContent(amLyricsElement);
            } else {
                // Turning OFF: Stop observer
                // Note: To restore original Japanese, we'd need to reload the component
                this.stopLyricsObserver();
            }
        }

        return this.isRomajiMode;
    }

    async applyGeniusAnnotations(amLyricsElement, referents) {
        if (!amLyricsElement || !referents) return;

        const root = amLyricsElement.shadowRoot || amLyricsElement;

        const lineElements = Array.from(root.querySelectorAll('p, .line, .lyric-line, .lrc-line'));

        if (lineElements.length === 0) return;

        lineElements.forEach((el) => {
            el.classList.remove('genius-annotated', 'genius-multi-start', 'genius-multi-end', 'genius-multi-mid');
            delete el.__geniusAnnotations;
        });

        const normalize = (str) =>
            str
                .toLowerCase()
                .replace(/[^\p{L}\p{N}\s]/gu, '')
                .replace(/\s+/g, ' ')
                .trim();

        referents.forEach((ref) => {
            const fragment = normalize(ref.fragment);
            if (!fragment) return;

            for (let i = 0; i < lineElements.length; i++) {
                let combinedText = '';
                let currentLines = [];

                for (let j = i; j < lineElements.length; j++) {
                    const line = lineElements[j];

                    const lineClone = line.cloneNode(true);
                    lineClone
                        .querySelectorAll('.time, .timestamp, [class*="time"], .genius-indicator')
                        .forEach((n) => n.remove());
                    const text = normalize(lineClone.textContent || '');

                    if (!text) continue;

                    if (currentLines.length > 0) combinedText += ' ';
                    combinedText += text;
                    currentLines.push(line);

                    if (combinedText.includes(fragment)) {
                        currentLines.forEach((el, idx) => {
                            el.classList.add('genius-annotated');
                            if (!el.__geniusAnnotations) el.__geniusAnnotations = [];

                            if (!el.__geniusAnnotations.some((a) => a.id === ref.id)) {
                                el.__geniusAnnotations.push(ref);
                            }

                            if (currentLines.length > 1) {
                                if (idx === 0) el.classList.add('genius-multi-start');
                                else if (idx === currentLines.length - 1) el.classList.add('genius-multi-end');
                                else el.classList.add('genius-multi-mid');
                            }

                            if (!el.querySelector('.genius-indicator')) {
                                const smiley = document.createElement('span');
                                smiley.className = 'genius-indicator';
                                smiley.textContent = ' ☺';
                                smiley.style.color = '#ffff64';
                                smiley.style.marginLeft = '0.5em';
                                el.appendChild(smiley);
                            }
                        });
                        break;
                    }

                    if (combinedText.length > fragment.length + 50) break;
                }
            }
        });
    }
}

export function openLyricsPanel(track, audioPlayer, lyricsManager, forceOpen = false) {
    const manager = lyricsManager || new LyricsManager();

    // Load Kuroshiro in background only if track has Asian text and Romaji mode is enabled
    const isRomajiMode = manager.getRomajiMode();
    if (isRomajiMode && trackHasAsianText(track) && !manager.kuroshiroLoaded && !manager.kuroshiroLoading) {
        manager.loadKuroshiro().catch((err) => {
            console.warn('Failed to load Kuroshiro for Romaji conversion:', err);
        });
    }

    // Load saved timing offset for this track
    manager.timingOffset = manager.getTimingOffset(track.id);

    const renderControls = (container) => {
        const isRomajiMode = manager.getRomajiMode();
        manager.isRomajiMode = isRomajiMode;
        const isGeniusMode = manager.isGeniusMode;
        const offsetDisplay = manager.getOffsetDisplayString(manager.timingOffset);

        container.innerHTML = `
            <div class="lyrics-timing-controls">
                <button id="lyrics-timing-minus-btn" class="btn-icon" title="Decrease delay (lyrics earlier) -0.5s">
                    ${SVG_MINUS(18)}
                </button>
                <span id="lyrics-timing-display" class="lyrics-timing-display" title="Current timing offset">${offsetDisplay}</span>
                <button id="lyrics-timing-plus-btn" class="btn-icon" title="Increase delay (lyrics later) +0.5s">
                    ${SVG_PLUS(18)}
                </button>
                <button id="lyrics-timing-reset-btn" class="btn-icon" title="Reset timing offset">
                    ${SVG_RESET(16)}
                </button>
            </div>
            <button id="romaji-toggle-btn" class="btn-icon" title="Toggle Romaji (Japanese to Latin)" data-enabled="${isRomajiMode}" style="color: ${isRomajiMode ? 'var(--primary)' : ''}">
                ${SVG_GLOBE(20)}
            </button>
            <button id="genius-toggle-btn" class="btn-icon ${isGeniusMode ? 'active-genius' : ''}" title="Genius Mode" style="${isGeniusMode ? 'color: #ffff64;' : ''}">
                ${isGeniusMode ? SVG_GENIUS_ACTIVE(20) : SVG_GENIUS_INACTIVE(20)}
            </button>
            <button id="close-side-panel-btn" class="btn-icon" title="Close">
                ${SVG_CLOSE(20)}
            </button>
        `;

        container.querySelector('#close-side-panel-btn').addEventListener('click', () => {
            sidePanelManager.close();
            clearLyricsPanelSync(audioPlayer, sidePanelManager.panel);
        });

        // Timing adjustment controls
        const updateTimingDisplay = () => {
            const display = container.querySelector('#lyrics-timing-display');
            if (display) {
                display.textContent = manager.getOffsetDisplayString(manager.timingOffset);
            }
        };

        container.querySelector('#lyrics-timing-minus-btn')?.addEventListener('click', () => {
            manager.timingOffset -= 500; // Decrease by 0.5 seconds
            manager.setTimingOffset(track.id, manager.timingOffset);
            updateTimingDisplay();
        });

        container.querySelector('#lyrics-timing-plus-btn')?.addEventListener('click', () => {
            manager.timingOffset += 500; // Increase by 0.5 seconds
            manager.setTimingOffset(track.id, manager.timingOffset);
            updateTimingDisplay();
        });

        container.querySelector('#lyrics-timing-reset-btn')?.addEventListener('click', () => {
            manager.timingOffset = 0;
            manager.resetTimingOffset(track.id);
            updateTimingDisplay();
        });

        // Romaji toggle button handler
        const romajiBtn = container.querySelector('#romaji-toggle-btn');
        if (romajiBtn) {
            const updateRomajiBtn = () => {
                const enabled = manager.isRomajiMode;
                romajiBtn.setAttribute('data-enabled', enabled);
                romajiBtn.style.color = enabled ? 'var(--primary)' : '';
            };
            updateRomajiBtn();

            romajiBtn.addEventListener('click', async () => {
                const amLyrics = sidePanelManager.panel.querySelector('am-lyrics');
                if (amLyrics) {
                    await manager.toggleRomajiMode(amLyrics);
                    updateRomajiBtn();
                }
            });
        }

        // Genius toggle
        const geniusBtn = container.querySelector('#genius-toggle-btn');
        if (geniusBtn) {
            geniusBtn.addEventListener('click', async () => {
                manager.isGeniusMode = !manager.isGeniusMode;
                const enabled = manager.isGeniusMode;

                geniusBtn.classList.toggle('active-genius', enabled);
                geniusBtn.style.color = enabled ? '#ffff64' : '';
                geniusBtn.innerHTML = enabled ? SVG_GENIUS_ACTIVE(20) : SVG_GENIUS_INACTIVE(20);

                if (enabled) {
                    try {
                        geniusBtn.style.opacity = '0.5';
                        await manager.geniusManager.getDataForTrack(track);
                        manager.currentGeniusData = manager.geniusManager.cache.get(track.id);
                        const amLyrics = sidePanelManager.panel.querySelector('am-lyrics');
                        if (amLyrics)
                            manager.applyGeniusAnnotations(
                                amLyrics,
                                manager.geniusManager.cache.get(track.id)?.referents
                            );
                    } catch (e) {
                        alert(e.message);
                        manager.isGeniusMode = false;
                        geniusBtn.classList.remove('active-genius');
                        geniusBtn.style.color = '';
                    } finally {
                        geniusBtn.style.opacity = '1';
                    }
                } else {
                    const amLyrics = sidePanelManager.panel.querySelector('am-lyrics');
                    if (amLyrics) {
                        const root = amLyrics.shadowRoot || amLyrics;
                        const lineElements = Array.from(root.querySelectorAll('.genius-annotated'));
                        lineElements.forEach((el) => {
                            el.classList.remove(
                                'genius-annotated',
                                'genius-multi-start',
                                'genius-multi-end',
                                'genius-multi-mid'
                            );
                            delete el.__geniusAnnotations;
                        });
                    }
                    const modal = document.querySelector('.genius-annotation-modal');
                    if (modal) modal.remove();
                }
            });
        }
    };

    const renderContent = async (container) => {
        clearLyricsPanelSync(audioPlayer, sidePanelManager.panel);
        await renderLyricsComponent(container, track, audioPlayer, manager);
        if (container.lyricsCleanup) {
            sidePanelManager.panel.lyricsCleanup = container.lyricsCleanup;
            sidePanelManager.panel.lyricsManager = container.lyricsManager;
        }
    };

    sidePanelManager.open('lyrics', 'Lyrics', renderControls, renderContent, forceOpen);
}

function getLyricsHighlightColor() {
    // Karaoke blue — bright on dark, deeper blue on light for legibility.
    // The am-lyrics component drives all syllable colors (active wipe, finished,
    // unsung secondary) from this single value, so setting it to blue gives
    // a real-time word-by-word karaoke effect for free.
    const isLight = getComputedStyle(document.documentElement).colorScheme === 'light';
    return isLight ? '#0277bd' : '#4fc3f7';
}

function updateLyricsTheme() {
    const highlightColor = getLyricsHighlightColor();
    document.querySelectorAll('am-lyrics').forEach((el) => {
        el.setAttribute('highlight-color', highlightColor);
    });
}

// watch for theme changes
const themeObserver = new MutationObserver(() => {
    updateLyricsTheme();
});

themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style'],
});

function applyLyricsShadowTweaks(amLyrics, container) {
    if (!amLyrics) return;

    const injectStyle = () => {
        const root = amLyrics.shadowRoot;
        if (!root) return false;

        let styleEl = root.getElementById('monochrome-fullscreen-lyrics-tweaks');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'monochrome-fullscreen-lyrics-tweaks';
            root.appendChild(styleEl);
        }

        styleEl.textContent = `
            .lyrics-container {
                scrollbar-width: none !important;
                -ms-overflow-style: none !important;
            }

            .lyrics-container::-webkit-scrollbar {
                width: 0 !important;
                height: 0 !important;
                display: none !important;
                background: transparent !important;
            }

            .lyrics-line {
                transform-origin: left center;
                transition:
                    opacity 0.42s ease,
                    transform 0.55s cubic-bezier(0.22, 1, 0.36, 1) var(--lyrics-line-delay, 0ms),
                    filter 0.48s cubic-bezier(0.22, 1, 0.36, 1) !important;
            }

            .lyrics-line:not(.active):not(.pre-active) {
                opacity: 0.44;
            }

            .lyrics-line.active + .lyrics-line:not(.active):not(.pre-active) {
                opacity: 0.85;
                filter: blur(0px) !important;
            }
            .lyrics-line-container {
                transition:
                    transform 0.72s cubic-bezier(0.22, 1, 0.36, 1),
                    background-color 0.3s ease,
                    color 0.3s ease !important;
            }

            .lyrics-line.active .lyrics-line-container,
            .lyrics-line.pre-active .lyrics-line-container {
                transition:
                    transform 0.56s cubic-bezier(0.22, 1, 0.36, 1),
                    background-color 0.22s ease,
                    color 0.22s ease !important;
            }

            .lyrics-line.active .lyrics-line-container {
                transform: scale(1.015);
            }

            /* Karaoke: unsung syllables stay white, the active wipe (driven
               by --lyplus-text-primary = highlight color = blue) paints them
               blue word-by-word as each is sung. */
            :host {
                --lyplus-text-secondary: rgba(255, 255, 255, 0.92) !important;
            }

            /* Already-sung syllables get a soft glow so progression is clear */
            .lyrics-line.active .lyrics-syllable.finished,
            .lyrics-line.active .lyrics-syllable.finished span.char {
                text-shadow: 0 0 8px color-mix(in srgb, var(--lyplus-text-primary), transparent 55%);
            }

            /* Currently-singing syllable: extra glow on the wipe edge */
            .lyrics-line.active .lyrics-syllable.highlight,
            .lyrics-line.active .lyrics-syllable.highlight span.char {
                text-shadow: 0 0 12px color-mix(in srgb, var(--lyplus-text-primary), transparent 35%);
            }
        `;

        return true;
    };

    if (injectStyle()) return;

    let attempts = 0;
    const maxAttempts = 24;
    const tryInject = () => {
        if (injectStyle()) return;
        attempts += 1;
        if (attempts < maxAttempts) {
            requestAnimationFrame(tryInject);
        }
    };

    requestAnimationFrame(tryInject);
}

async function renderLyricsComponent(container, track, audioPlayer, lyricsManager) {
    container.innerHTML = '<div class="lyrics-loading">Loading lyrics...</div>';

    try {
        await lyricsManager.ensureComponentLoaded();

        // Set initial Romaji mode
        lyricsManager.isRomajiMode = lyricsManager.getRomajiMode();
        lyricsManager.currentTrackId = track.id;

        const title = getTrackTitle(track);
        const artist = getTrackArtists(track);
        const album = track.album?.title;
        const durationMs = track.duration ? Math.round(track.duration * 1000) : undefined;
        const isrc = (track.isrc || track.mediaMetadata?.isrc || track.audioQuality?.isrc || '').trim();

        const isTracker = track.isTracker || (track.id && String(track.id).startsWith('tracker-'));
        let queryTitle = title;
        let queryArtist = artist;

        if (isTracker) {
            queryTitle = cleanTrackerSearch(title);
            queryArtist = cleanTrackerSearch(artist);
        }

        container.innerHTML = '';
        const amLyrics = document.createElement('am-lyrics');
        amLyrics.setAttribute('song-title', queryTitle);
        amLyrics.setAttribute('song-artist', queryArtist);
        if (album) amLyrics.setAttribute('song-album', album);
        if (durationMs) amLyrics.setAttribute('song-duration', durationMs);
        amLyrics.setAttribute('query', `${queryTitle} ${queryArtist}`.trim());
        if (isrc) amLyrics.setAttribute('isrc', isrc);

        amLyrics.setAttribute('highlight-color', getLyricsHighlightColor());
        amLyrics.setAttribute('hover-background-color', 'color-mix(in srgb, var(--primary) 16%, transparent)');
        amLyrics.setAttribute('autoscroll', '');
        amLyrics.setAttribute('interpolate', '');
        amLyrics.style.height = '100%';
        amLyrics.style.width = '100%';

        container.appendChild(amLyrics);
        applyLyricsShadowTweaks(amLyrics, container);

        lyricsManager.setupLyricsObserver(amLyrics);

        // If Romaji mode is enabled and track has Asian text, ensure Kuroshiro is ready
        if (lyricsManager.isRomajiMode && trackHasAsianText(track) && !lyricsManager.kuroshiroLoaded) {
            await lyricsManager.loadKuroshiro();
        }

        lyricsManager
            .fetchLyrics(track.id, track)
            .then(async () => {
                if (lyricsManager.isGeniusMode) {
                    try {
                        const data = await lyricsManager.geniusManager.getDataForTrack(track);
                        if (data) {
                            lyricsManager.currentGeniusData = data;
                            lyricsManager.applyGeniusAnnotations(amLyrics, data.referents);
                        }
                    } catch (e) {
                        console.warn('Genius auto-load failed', e);
                    }
                }
            })
            .catch((e) => console.warn('Background lyrics fetch failed', e));

        // Wait for lyrics to appear, then do an immediate conversion
        const waitForLyrics = () => {
            return new Promise((resolve) => {
                // Check if lyrics are already loaded
                const checkForLyrics = () => {
                    const hasLyrics =
                        amLyrics.querySelector(".lyric-line, [class*='lyric']") ||
                        (amLyrics.shadowRoot && amLyrics.shadowRoot.querySelector("[class*='lyric']")) ||
                        (amLyrics.textContent && amLyrics.textContent.length > 50);
                    return hasLyrics;
                };

                if (checkForLyrics()) {
                    resolve();
                    return;
                }

                // Check more frequently (200ms) for faster response
                let attempts = 0;
                const maxAttempts = 25; // 5 seconds max
                const interval = setInterval(() => {
                    attempts++;
                    if (checkForLyrics() || attempts >= maxAttempts) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 200);
            });
        };

        await waitForLyrics();

        // Convert immediately after lyrics detected
        if (lyricsManager.isRomajiMode) {
            await lyricsManager.convertLyricsContent(amLyrics);
            // One retry after 500ms in case more lyrics load
            setTimeout(() => lyricsManager.convertLyricsContent(amLyrics), 500);
        }

        if (lyricsManager.isGeniusMode && lyricsManager.currentGeniusData) {
            lyricsManager.applyGeniusAnnotations(amLyrics, lyricsManager.currentGeniusData.referents);
        }

        const cleanup = setupSync(track, audioPlayer, amLyrics, lyricsManager);

        // Attach cleanup to container for easy access
        container.lyricsCleanup = cleanup;
        container.lyricsManager = lyricsManager;

        return amLyrics;
    } catch (error) {
        console.error('Failed to load lyrics:', error);
        container.innerHTML = '<div class="lyrics-error">Failed to load lyrics</div>';
        return null;
    }
}

// Word-by-word karaoke for tracks where the lyrics provider only delivers
// line-level timing (LRCLIB, etc.). The am-lyrics component still wraps each
// word in a `.lyrics-syllable` span, but for line-synced lyrics every syllable
// shares the same start time, so the component cannot animate them
// individually. We re-distribute that line's duration across its existing
// syllable spans (by character weight) and toggle our own kw-* classes,
// producing a real word-by-word white→blue wipe.
//
// When a syllable already has individual timing (Apple Music / musixmatch-word
// — different data-start-time per syllable) we leave the line alone and let
// the component's native wipe gradient run.
function setupKaraokeFallback(amLyrics, lyricsManager) {
    const root = amLyrics.shadowRoot;
    if (!root) return null;

    let activeLineEl = null;
    let activeWords = []; // each: { el, start, end } as fraction of line
    let parsedLines = null;
    let createdSpans = []; // spans we added (for cleanup) when no syllables existed

    if (!root.getElementById('karaoke-fallback-styles')) {
        const style = document.createElement('style');
        style.id = 'karaoke-fallback-styles';
        // Specificity matters: the component's "fade-in-line" rule is
        //   .lyrics-line.active .lyrics-syllable.line-synced  (0,3,0) !important
        // and slams every syllable to the highlight color the moment a line
        // activates. We add .lyrics-container ancestor to reach (0,4,0) so we
        // outrank it. We also kill its `animation: fade-in-line` so the line
        // doesn't "snap to all-blue" the moment it activates.
        style.textContent = `
            .lyrics-container .lyrics-line.active .lyrics-syllable.kw-pending,
            .lyrics-container .lyrics-line.active .lyrics-syllable.kw-pending span.char {
                animation: none !important;
                color: rgba(255, 255, 255, 0.92) !important;
                background-color: transparent !important;
                background-image: none !important;
                -webkit-text-fill-color: rgba(255, 255, 255, 0.92) !important;
                text-shadow: none !important;
                opacity: 1 !important;
                transition: color 0.12s ease, -webkit-text-fill-color 0.12s ease, text-shadow 0.18s ease !important;
            }
            .lyrics-container .lyrics-line.active .lyrics-syllable.kw-sung,
            .lyrics-container .lyrics-line.active .lyrics-syllable.kw-sung span.char {
                animation: none !important;
                color: var(--lyplus-text-primary) !important;
                background-color: transparent !important;
                background-image: none !important;
                -webkit-text-fill-color: var(--lyplus-text-primary) !important;
                text-shadow: 0 0 8px color-mix(in srgb, var(--lyplus-text-primary), transparent 55%) !important;
                opacity: 1 !important;
            }
            .lyrics-container .lyrics-line.active .lyrics-syllable.kw-singing,
            .lyrics-container .lyrics-line.active .lyrics-syllable.kw-singing span.char {
                animation: none !important;
                color: var(--lyplus-text-primary) !important;
                background-color: transparent !important;
                background-image: none !important;
                -webkit-text-fill-color: var(--lyplus-text-primary) !important;
                text-shadow: 0 0 14px color-mix(in srgb, var(--lyplus-text-primary), transparent 25%) !important;
                opacity: 1 !important;
            }

            /* Un-style the am-lyrics wrapper so our child fallbacks render correctly */
            .lyrics-container .lyrics-line.active .lyrics-syllable:has(.kw-fallback) {
                animation: none !important;
                background: none !important;
                -webkit-background-clip: unset !important;
                background-clip: unset !important;
                color: inherit !important;
                -webkit-text-fill-color: inherit !important;
            }

            /* Plain-text fallback (no .lyrics-syllable elements at all) */
            .lyrics-container .lyrics-line.active .kw-fallback,
            .lyrics-container .lyrics-line.active .kw-fallback.kw-pending {
                color: rgba(255, 255, 255, 0.92) !important;
                -webkit-text-fill-color: rgba(255, 255, 255, 0.92) !important;
                transition: color 0.12s ease, text-shadow 0.18s ease !important;
                text-shadow: none !important;
            }
            .lyrics-container .lyrics-line.active .kw-fallback.kw-sung {
                color: var(--lyplus-text-primary) !important;
                -webkit-text-fill-color: var(--lyplus-text-primary) !important;
                text-shadow: 0 0 8px color-mix(in srgb, var(--lyplus-text-primary), transparent 55%) !important;
            }
            .lyrics-container .lyrics-line.active .kw-fallback.kw-singing {
                color: var(--lyplus-text-primary) !important;
                -webkit-text-fill-color: var(--lyplus-text-primary) !important;
                text-shadow: 0 0 14px color-mix(in srgb, var(--lyplus-text-primary), transparent 25%) !important;
            }

            /* Keep inactive lines alone — let the component dim them naturally */
            .lyrics-line:not(.active) .kw-fallback,
            .lyrics-line:not(.active) .lyrics-syllable.kw-pending,
            .lyrics-line:not(.active) .lyrics-syllable.kw-sung,
            .lyrics-line:not(.active) .lyrics-syllable.kw-singing {
                color: inherit !important;
                background-color: inherit !important;
                -webkit-text-fill-color: inherit !important;
                text-shadow: none !important;
            }
        `;
        root.appendChild(style);
    }



    // Returns true if syllables in the line already carry individual word
    // timing (different start times). If so, the component will animate them
    // natively and we should stay out of the way.
    const hasIndividualTiming = (syllables) => {
        if (syllables.length < 2) return false;
        const firstStart = syllables[0].dataset?.startTime;
        for (let i = 1; i < syllables.length; i++) {
            if (syllables[i].dataset?.startTime !== firstStart) return true;
        }
        return false;
    };

    // Returns:
    //  { words } – we adopted the line's syllables (line-synced timing, we drive)
    //  { skip: true } – syllables exist with individual timing; component handles it
    //  null – no syllables; caller may wrap plain text instead
    const adoptSyllables = (lineEl) => {
        const syllables = Array.from(
            lineEl.querySelectorAll('.lyrics-syllable:not(.transliteration)')
        ).filter((s) => (s.textContent || '').trim().length > 0);
        if (!syllables.length) return null;
        if (hasIndividualTiming(syllables)) return { skip: true };

        // If am-lyrics outputs LRCLIB without individual timing, it wraps the whole line in 1 or 2 syllables.
        // In that case, we should fallback to wrapPlainText so we can split it into real words!
        return null;
    };

    const wrapPlainText = (lineEl) => {
        const container = lineEl.querySelector('.lyrics-line-container') || lineEl;
        const words = [];
        const lengths = [];
        let total = 0;

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) {
            // Ignore text inside transliteration or already processed fallback spans
            if (node.parentElement && !node.parentElement.closest('.transliteration') && !node.parentElement.closest('.kw-fallback')) {
                if (node.textContent.trim()) textNodes.push(node);
            }
        }
        if (!textNodes.length) return null;

        const segmenter = window.Intl && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

        for (const tn of textNodes) {
            const frag = document.createDocumentFragment();
            const text = tn.textContent;
            
            let parts = [];
            if (segmenter) {
                const segments = Array.from(segmenter.segment(text));
                for (const seg of segments) {
                    parts.push({ text: seg.segment, isWord: seg.isWordLike });
                }
            } else {
                const splits = text.split(/(\s+)/);
                for (const split of splits) {
                    if (split) parts.push({ text: split, isWord: !/^\s+$/.test(split) });
                }
            }

            for (const part of parts) {
                if (!part.isWord && /^\s+$/.test(part.text)) {
                    frag.appendChild(document.createTextNode(part.text));
                } else {
                    const span = document.createElement('span');
                    span.className = 'kw-fallback kw-pending';
                    span.textContent = part.text;
                    const len = part.text.trim().length || 1;
                    lengths.push(len);
                    total += len;
                    frag.appendChild(span);
                    words.push(span);
                    createdSpans.push(span);
                }
            }
            tn.parentNode.replaceChild(frag, tn);
        }

        let acc = 0;
        return words.map((el, i) => {
            const start = total > 0 ? acc / total : 0;
            acc += lengths[i];
            const end = total > 0 ? acc / total : 1;
            return { el, start, end };
        });
    };

    const cleanupLine = (lineEl) => {
        if (!lineEl) return;
        // Remove our classes from any syllables we touched
        lineEl.querySelectorAll('.lyrics-syllable').forEach((s) => {
            s.classList.remove('kw-pending', 'kw-sung', 'kw-singing');
        });
        // Unwrap any plain spans we injected
        if (createdSpans.length) {
            createdSpans.forEach((span) => {
                if (span.isConnected) {
                    span.replaceWith(document.createTextNode(span.textContent));
                }
            });
            createdSpans = [];
            try { lineEl.normalize(); } catch (e) { /* ignore */ }
        }
    };

    const debug = (() => {
        try { return localStorage.getItem('debug:karaoke') === '1'; } catch { return false; }
    })();
    const dlog = (...a) => debug && console.log('[karaoke]', ...a);

    let activeSyllableSnapshot = 0; // tracks when we should re-evaluate
    let scheduled = false;
    const evaluate = () => {
        scheduled = false;
        const next = root.querySelector('.lyrics-line.active:not(.lyrics-gap)');
        const sylCount = next ? next.querySelectorAll('.lyrics-syllable').length : 0;

        if (next === activeLineEl && sylCount === activeSyllableSnapshot) return;
        if (next !== activeLineEl) {
            if (activeLineEl) cleanupLine(activeLineEl);
            activeLineEl = next;
            activeWords = [];
        }
        activeSyllableSnapshot = sylCount;
        if (!activeLineEl) return;

        const adopted = adoptSyllables(activeLineEl);
        dlog('active line changed', { sylCount, adopted: adopted ? Object.keys(adopted)[0] : null });
        if (adopted?.skip) return;
        if (adopted?.words) {
            activeWords = adopted.words;
            dlog('adopted', activeWords.length, 'syllables (line-synced)');
            return;
        }
        const wrapped = wrapPlainText(activeLineEl);
        if (wrapped) {
            activeWords = wrapped;
            dlog('wrapped', activeWords.length, 'words (no syllables in DOM)');
        } else {
            dlog('no words could be extracted from active line', activeLineEl?.outerHTML?.slice(0, 200));
        }
    };

    const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        // RAF defers until the component has finished its current render pass,
        // so we don't miss syllables that arrive a tick after the .active class.
        requestAnimationFrame(evaluate);
    });

    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
    // Initial evaluation in case the active line is already rendered.
    requestAnimationFrame(evaluate);

    const update = (currentTimeSec) => {
        if (!activeWords.length) return;

        const first = activeWords[0]?.el;
        const last = activeWords[activeWords.length - 1]?.el;
        const firstParent = first?.closest('.lyrics-syllable') || activeLineEl?.querySelector('.lyrics-syllable');
        const lastParent = last?.closest('.lyrics-syllable') || activeLineEl?.querySelectorAll('.lyrics-syllable')[activeLineEl.querySelectorAll('.lyrics-syllable').length - 1];

        const startMs = parseFloat(first?.dataset?.startTime ?? firstParent?.dataset?.startTime ?? '');
        const endMs = parseFloat(last?.dataset?.endTime ?? lastParent?.dataset?.endTime ?? first?.dataset?.endTime ?? firstParent?.dataset?.endTime ?? '');

        let lineStart = NaN;
        let lineEnd = NaN;

        if (Number.isFinite(startMs)) {
            lineStart = startMs / 1000;
            const fallbackEndMs = Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + 5000;
            const maxDuration = (fallbackEndMs - startMs) / 1000;

            // Estimate actual singing duration based on character count so we don't
            // drag the wipe across long instrumental gaps between lines.
            // ~12-15 chars per second is typical for sung lyrics.
            let charCount = 0;
            if (activeWords && activeWords.length) {
                charCount = activeWords.reduce((acc, w) => acc + (w.el.textContent || '').trim().length, 0);
            }
            const estimatedDuration = Math.max(1.0, charCount * 0.12);
            
            lineEnd = lineStart + Math.min(estimatedDuration, maxDuration);
        }

        if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return;

        const duration = Math.max(0.5, lineEnd - lineStart);
        const progress = (currentTimeSec - lineStart) / duration;

        const sungClass = 'kw-sung';
        const singingClass = 'kw-singing';
        const baseClass = 'kw-pending';

        for (let i = 0; i < activeWords.length; i++) {
            const { el, start, end } = activeWords[i];
            if (progress >= end) {
                if (!el.classList.contains(sungClass)) {
                    el.classList.remove(singingClass);
                    if (baseClass) el.classList.remove(baseClass);
                    el.classList.add(sungClass);
                }
            } else if (progress >= start) {
                if (!el.classList.contains(singingClass)) {
                    el.classList.remove(sungClass);
                    if (baseClass) el.classList.remove(baseClass);
                    el.classList.add(singingClass);
                }
            } else {
                if (el.classList.contains(sungClass) || el.classList.contains(singingClass)) {
                    el.classList.remove(sungClass, singingClass);
                    if (baseClass) el.classList.add(baseClass);
                }
            }
        }
    };

    return {
        update,
        destroy() {
            observer.disconnect();
            if (activeLineEl) cleanupLine(activeLineEl);
        },
    };
}

function setupSync(track, audioPlayer, amLyrics, lyricsManager) {
    let baseTimeMs = 0;
    let lastTimestamp = performance.now();
    let animationFrameId = null;
    let karaokeFallback = null;

    const getTimingOffset = () => lyricsManager?.timingOffset || 0;

    const getKaraokeFallback = () => {
        if (!karaokeFallback && amLyrics.shadowRoot) {
            karaokeFallback = setupKaraokeFallback(amLyrics, lyricsManager);
            try {
                if (localStorage.getItem('debug:karaoke') === '1') {
                    console.log('[karaoke] fallback initialised', { trackId: lyricsManager?.currentTrackId });
                }
            } catch { /* ignore */ }
        }
        return karaokeFallback;
    };

    const updateTime = () => {
        const currentMs = audioPlayer.currentTime * 1000;
        baseTimeMs = currentMs;
        lastTimestamp = performance.now();
        const adjusted = currentMs - getTimingOffset();
        amLyrics.currentTime = adjusted;
        getKaraokeFallback()?.update(adjusted / 1000);
    };

    const tick = () => {
        if (!audioPlayer.paused) {
            const now = performance.now();
            const elapsed = now - lastTimestamp;
            const nextMs = baseTimeMs + elapsed;
            const adjusted = nextMs - getTimingOffset();
            amLyrics.currentTime = adjusted;
            getKaraokeFallback()?.update(adjusted / 1000);
            animationFrameId = requestAnimationFrame(tick);
        }
    };

    const onPlay = () => {
        baseTimeMs = audioPlayer.currentTime * 1000;
        lastTimestamp = performance.now();
        tick();
    };

    const onPause = () => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
    };

    const onLineClick = (e) => {
        if (e.detail && e.detail.timestamp !== undefined) {
            const manager = lyricsManager || sidePanelManager.panel.lyricsManager;
            if (manager && manager.isGeniusMode) {
                const timestampSeconds = e.detail.timestamp / 1000;

                const lyricsData = manager.lyricsCache.get(track.id);
                if (lyricsData && lyricsData.subtitles) {
                    const parsed = manager.parseSyncedLyrics(lyricsData.subtitles);

                    const line = parsed.find((l) => Math.abs(l.time - timestampSeconds) < 1.0);

                    if (line && line.text && manager.currentGeniusData) {
                        const annotations = manager.geniusManager.findAnnotations(
                            line.text,
                            manager.currentGeniusData.referents
                        );
                        showGeniusAnnotations(annotations, line.text);
                    }
                }
                return;
            }

            audioPlayer.currentTime = e.detail.timestamp / 1000;
            audioPlayer.play();
        }
    };

    audioPlayer.addEventListener('timeupdate', updateTime);
    audioPlayer.addEventListener('play', onPlay);
    audioPlayer.addEventListener('pause', onPause);
    audioPlayer.addEventListener('seeked', updateTime);
    amLyrics.addEventListener('line-click', onLineClick);

    if (!audioPlayer.paused) {
        tick();
    }

    return () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        karaokeFallback?.destroy();
        audioPlayer.removeEventListener('timeupdate', updateTime);
        audioPlayer.removeEventListener('play', onPlay);
        audioPlayer.removeEventListener('pause', onPause);
        audioPlayer.removeEventListener('seeked', updateTime);
        amLyrics.removeEventListener('line-click', onLineClick);
    };
}

function showGeniusAnnotations(annotations, lineText) {
    const existing = document.querySelector('.genius-annotation-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'genius-annotation-modal';

    let contentHtml = `
        <div class="genius-modal-content">
            <div class="genius-header">
                <span class="genius-line">"${lineText}"</span>
                <button class="close-genius">×</button>
            </div>
            <div class="genius-body">
    `;

    if (annotations.length === 0) {
        contentHtml += `
            <div class="annotation-item">
                <div class="annotation-text" style="color: var(--muted-foreground); font-style: italic;">No Genius annotation found for this line.</div>
            </div>
        `;
    } else {
        annotations.forEach((ann) => {
            const body = ann.annotations[0].body.plain;
            contentHtml += `
                <div class="annotation-item">
                    <div class="annotation-text">${body.replace(/\n/g, '<br>')}</div>
                </div>
            `;
        });
    }

    contentHtml += `</div></div>`;
    modal.innerHTML = contentHtml;

    document.body.appendChild(modal);

    modal.querySelector('.close-genius').addEventListener('click', () => modal.remove());

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

export async function renderLyricsInFullscreen(track, audioPlayer, lyricsManager, container) {
    return renderLyricsComponent(container, track, audioPlayer, lyricsManager);
}

export function clearFullscreenLyricsSync(container) {
    if (container && container.lyricsCleanup) {
        container.lyricsCleanup();
        container.lyricsCleanup = null;
    }
    if (container && container.lyricsManager) {
        container.lyricsManager.stopLyricsObserver();
    }
}

export function clearLyricsPanelSync(_audioPlayer, panel) {
    if (panel && panel.lyricsCleanup) {
        panel.lyricsCleanup();
        panel.lyricsCleanup = null;
    }
    if (panel && panel.lyricsManager) {
        panel.lyricsManager.stopLyricsObserver();
    }
}
