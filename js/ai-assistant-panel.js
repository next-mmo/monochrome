import { sidePanelManager } from './side-panel.js';
import { navigate } from './router.js';
import { escapeHtml } from './utils.js';
import { SVG_CLOSE, SVG_PLAY, SVG_PLUS, SVG_SPARKLES, SVG_SETTINGS } from './icons.js';
import { showNotification } from './downloads.js';
import {
    DEFAULT_CHAT_ENDPOINT,
    DEFAULT_G4F_CHAT_ENDPOINT,
    DEFAULT_G4F_MODEL,
    clearStoredLlmConfig,
    getDefaultLlmConfig,
    isG4fDefaultEndpoint,
    persistStoredLlmConfig,
    readStoredLlmConfig,
    sendMusicAssistantMessages,
    testLlmConnection,
} from './ai-assistant-llm-client.js';

const AI_VIEW_ID = 'ai-assistant';
const MAX_RESULTS = 8;
const STORAGE_ASSISTANT_SOURCE = 'monochrome.ai-assistant.source';

const OLLAMA_EXAMPLE_URL = 'http://localhost:11434/v1/chat/completions';
const LM_STUDIO_EXAMPLE_URL = 'http://localhost:1234/v1/chat/completions';

const MUSIC_SYSTEM = [
    'You are the AI music assistant inside Monochrome, a TIDAL-based music web app.',
    'Help users discover songs, artists, playlists, and listening ideas. Be concise and friendly.',
    'When you suggest concrete tracks, put each on its own line using this exact format: "Title – Artist" (use an en dash – between title and artist).',
    'You may add a short intro or outro in plain text. Do not invent chart rankings or release dates you are unsure about.',
].join('\n');

const chatState = {
    messages: [],
    loading: false,
    /** @type {'local' | 'llm'} */
    assistantSource: 'local',
    /** @type {Array<{ role: 'user' | 'assistant'; content: string }>} */
    llmHistory: [],
};

let panelContext = {
    player: null,
    api: null,
};

/** @type {AbortController | null} */
let activeLlmRequest = null;

/** @type {boolean} */
let aiSearchNavDelegationAttached = false;

/**
 * @param {string} trimmed - one logical line, trimmed
 * @returns {{ title: string; artist: string; searchQuery: string; displayLine: string } | null}
 */
function tryParseTitleArtistLine(trimmed) {
    if (!trimmed) return null;
    const withoutNumber = trimmed.replace(/^\d+[.)]\s*/, '');
    const m = withoutNumber.match(/^(.+?)\s*[–—-]\s*(.+)$/);
    if (!m) return null;
    const title = m[1].replace(/\*+/g, '').trim();
    const artist = m[2].replace(/\*+/g, '').trim();
    if (title.length < 2 || artist.length < 2) return null;
    return {
        title,
        artist,
        searchQuery: `${title} ${artist}`.trim(),
        displayLine: trimmed,
    };
}

/**
 * @param {string} text
 * @returns {string} HTML (escaped text, safe links)
 */
function renderAssistantMessageBody(text) {
    if (!text) return '';
    const lines = text.split('\n');
    const chunks = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) {
            chunks.push('<br />');
            continue;
        }
        const parsed = tryParseTitleArtistLine(trimmed);
        if (parsed) {
            const path = `/search/${encodeURIComponent(parsed.searchQuery)}`;
            chunks.push(
                `<a class="ai-search-nav-link" href="${escapeHtml(path)}">${escapeHtml(parsed.displayLine)}</a>`
            );
        } else {
            chunks.push(`<span class="ai-msg-plain-line">${escapeHtml(line)}</span>`);
        }
    }
    return `<div class="ai-msg-body">${chunks.join('<br />')}</div>`;
}

function ensureAiSearchNavDelegation() {
    if (aiSearchNavDelegationAttached) return;
    aiSearchNavDelegationAttached = true;
    document.body.addEventListener('click', (e) => {
        const a = /** @type {HTMLAnchorElement | null} */ (e.target.closest('a.ai-search-nav-link'));
        if (!a) return;
        const panel = document.getElementById('side-panel-content');
        if (!panel?.contains(a)) return;
        const href = a.getAttribute('href');
        if (!href || !href.startsWith('/search/')) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
    });
}

function nextMessageId() {
    return `ai-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getAssistantSource() {
    try {
        const v = localStorage.getItem(STORAGE_ASSISTANT_SOURCE);
        return v === 'llm' ? 'llm' : 'local';
    } catch {
        return 'local';
    }
}

/**
 * @param {'local' | 'llm'} source
 */
function setAssistantSource(source) {
    try {
        localStorage.setItem(STORAGE_ASSISTANT_SOURCE, source);
    } catch {
        /* ignore */
    }
    chatState.assistantSource = source;
    if (source === 'local') {
        chatState.llmHistory = [];
    }
}

function getTrackArtistLabel(track) {
    if (Array.isArray(track?.artists) && track.artists.length > 0) {
        return track.artists
            .map((artist) => artist?.name)
            .filter(Boolean)
            .join(', ');
    }

    if (track?.artist?.name) {
        return track.artist.name;
    }

    return 'Unknown Artist';
}

function ensureSeedMessage() {
    if (chatState.messages.length > 0) return;

    chatState.messages.push({
        id: nextMessageId(),
        role: 'assistant',
        text: 'Ask for recommendations, search tracks, or top songs by an artist. Switch to LLM for a real model (requires setup).',
    });
}

function createTrackCardsHtml(message) {
    if (!Array.isArray(message.tracks) || message.tracks.length === 0) return '';

    return `
        <div class="ai-track-list">
            ${message.tracks
                .map((track, index) => {
                    const title = escapeHtml(track?.title || 'Unknown Title');
                    const artist = escapeHtml(getTrackArtistLabel(track));
                    const searchQ = `${track?.title || ''} ${getTrackArtistLabel(track)}`.trim();
                    const searchHref = `/search/${encodeURIComponent(searchQ)}`;
                    return `
                        <article class="ai-track-card">
                            <div class="ai-track-meta">
                                <a class="ai-search-nav-link ai-track-title-link" href="${escapeHtml(searchHref)}"><strong>${title}</strong></a>
                                <span>${artist}</span>
                            </div>
                            <div class="ai-track-actions">
                                <button class="ai-track-action" data-action="play" data-msg-id="${message.id}" data-track-index="${index}" title="Play now">
                                    ${SVG_PLAY(16)}
                                </button>
                                <button class="ai-track-action" data-action="queue" data-msg-id="${message.id}" data-track-index="${index}" title="Add to queue">
                                    ${SVG_PLUS(16)}
                                </button>
                            </div>
                        </article>
                    `;
                })
                .join('')}
        </div>
    `;
}

function renderMessagesHtml() {
    return chatState.messages
        .map((message) => {
            const bubbleClass = `ai-bubble ${message.role === 'user' ? 'ai-user' : 'ai-assistant'}`;
            const body =
                message.role === 'assistant'
                    ? renderAssistantMessageBody(message.text || '')
                    : `<p>${escapeHtml(message.text || '')}</p>`;

            return `
                <div class="${bubbleClass}">
                    ${body}
                    ${createTrackCardsHtml(message)}
                </div>
            `;
        })
        .join('');
}

/**
 * @param {string} text
 * @param {import('./api.js').LosslessAPI} api
 */
async function resolveTracksFromLlmText(text, api) {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    /** @type {{ title: string; artist: string }[]} */
    const suggestions = [];
    for (const line of lines) {
        const parsed = tryParseTitleArtistLine(line.trim());
        if (!parsed) continue;
        suggestions.push({ title: parsed.title, artist: parsed.artist });
        if (suggestions.length >= 10) break;
    }

    const tracks = [];
    const seen = new Set();
    for (const s of suggestions) {
        try {
            const res = await api.searchTracks(`${s.title} ${s.artist}`);
            const t = res?.items?.[0];
            if (t && !seen.has(t.id)) {
                seen.add(t.id);
                tracks.push(t);
            }
        } catch {
            /* skip */
        }
    }

    return tracks.slice(0, MAX_RESULTS);
}

function llmStatusHtml() {
    const cfg = readStoredLlmConfig();
    if (cfg) {
        const modeLabel =
            cfg.mode === 'sone-chat' ? 'Local Sone backend' : cfg.mode === 'g4f' ? 'g4f' : 'OpenAI-compatible';
        const modelPart = cfg.model ? ` · ${escapeHtml(cfg.model)}` : '';
        return `
            <div class="ai-llm-status ai-llm-status-connected">
                <span><strong>${escapeHtml(modeLabel)}</strong>${modelPart}</span>
                <button type="button" class="btn-secondary ai-llm-setup-inline" id="ai-open-llm-settings">Edit</button>
            </div>
        `;
    }
    return `
        <div class="ai-llm-status ai-llm-status-disconnected">
            <span>No LLM connected</span>
            <button type="button" class="btn-primary ai-llm-setup-inline" id="ai-open-llm-settings">Setup LLM</button>
        </div>
    `;
}

function renderContent(container) {
    const isLlm = chatState.assistantSource === 'llm';
    const stored = readStoredLlmConfig();
    const composerDisabled = chatState.loading || (isLlm && !stored);

    container.innerHTML = `
        <div class="ai-assistant-panel">
            <div class="ai-source-toolbar" role="group" aria-label="Assistant mode">
                <button type="button" class="ai-source-btn ${!isLlm ? 'active' : ''}" data-source="local">Local</button>
                <button type="button" class="ai-source-btn ${isLlm ? 'active' : ''}" data-source="llm">LLM</button>
            </div>
            ${isLlm ? llmStatusHtml() : ''}

            <div class="ai-thread" id="ai-thread">
                ${renderMessagesHtml()}
                ${chatState.loading ? '<div class="ai-bubble ai-assistant"><p>Thinking...</p></div>' : ''}
            </div>

            <form class="ai-composer" id="ai-composer">
                <input
                    id="ai-assistant-input"
                    type="text"
                    placeholder="${isLlm ? 'Chat with your model about music…' : 'Try: recommend from current song, top songs The Weeknd, search chill'}"
                    autocomplete="off"
                    ${composerDisabled ? 'disabled' : ''}
                />
                <button type="submit" class="btn-primary" ${composerDisabled ? 'disabled' : ''}>
                    ${isLlm ? 'Send' : 'Ask'}
                </button>
            </form>

            <div class="ai-chip-row">
                <button type="button" class="ai-chip" data-prompt="Recommend songs like the current track">Recommend from current track</button>
                <button type="button" class="ai-chip" data-prompt="Top songs by The Weeknd">Top songs by artist</button>
                <button type="button" class="ai-chip" data-prompt="Search chill synthwave">Search songs</button>
            </div>
        </div>
    `;

    const thread = container.querySelector('#ai-thread');
    if (thread) {
        thread.scrollTop = thread.scrollHeight;
    }

    container.querySelectorAll('.ai-source-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const source = /** @type {'local'|'llm'} */ (btn.getAttribute('data-source'));
            if (!source || source === chatState.assistantSource) return;
            setAssistantSource(source);
            rerenderAssistant();
        });
    });

    container.querySelector('#ai-open-llm-settings')?.addEventListener('click', () => {
        openLlmSetupModal({
            onSaved: () => {
                showNotification('LLM settings saved');
                rerenderAssistant();
            },
        });
    });

    const form = container.querySelector('#ai-composer');
    const input = container.querySelector('#ai-assistant-input');
    form?.addEventListener('submit', (event) => {
        event.preventDefault();
        const prompt = input?.value?.trim();
        if (!prompt || chatState.loading) return;
        if (input) input.value = '';
        void submitPrompt(prompt);
    });

    container.querySelectorAll('.ai-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            if (chatState.loading || !input) return;
            input.value = chip.dataset.prompt || '';
            input.focus();
        });
    });

    container.querySelectorAll('.ai-track-action').forEach((button) => {
        button.addEventListener('click', async () => {
            const msgId = button.dataset.msgId;
            const trackIndex = Number(button.dataset.trackIndex);
            const action = button.dataset.action;
            const message = chatState.messages.find((item) => item.id === msgId);
            const track = message?.tracks?.[trackIndex];
            if (!track || !panelContext.player) return;

            if (action === 'play') {
                panelContext.player.setQueue([track], 0);
                panelContext.player.enableAutoplay();
                await panelContext.player.playTrackFromQueue();
                return;
            }

            if (action === 'queue') {
                await panelContext.player.addToQueue(track);
            }
        });
    });
}

function rerenderAssistant() {
    if (!sidePanelManager.isActive(AI_VIEW_ID)) return;
    void sidePanelManager.updateContent(AI_VIEW_ID, async (container) => renderContent(container));
}

function createResponseMessage(text, tracks = []) {
    return {
        id: nextMessageId(),
        role: 'assistant',
        text,
        tracks: tracks.slice(0, MAX_RESULTS),
    };
}

async function handleTopSongsIntent(inputText) {
    const api = panelContext.api;
    if (!api) return createResponseMessage('Music API is not ready yet.');

    const artistQuery = inputText
        .replace(/\b(top|songs?|song|tracks?|by|for|artist)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!artistQuery) {
        return createResponseMessage('Tell me an artist name, for example: "Top songs by Daft Punk".');
    }

    const artistResults = await api.searchArtists(artistQuery);
    const artist = artistResults?.items?.[0];

    if (!artist?.id) {
        return createResponseMessage(`I could not find an artist for "${artistQuery}". Try a different spelling.`);
    }

    const topTracks = await api.getArtistTopTracks(artist.id, { limit: MAX_RESULTS });
    const tracks = topTracks?.tracks || [];
    if (tracks.length === 0) {
        return createResponseMessage(`No top songs found for ${artist.name} right now.`);
    }

    return createResponseMessage(`Top songs by ${artist.name}:`, tracks);
}

async function handleSearchIntent(inputText) {
    const api = panelContext.api;
    if (!api) return createResponseMessage('Music API is not ready yet.');

    const query = inputText
        .replace(/\b(search|find|song|songs|track|tracks|for)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!query) {
        return createResponseMessage('Try: "Search chill synthwave" or "Find song blinding lights".');
    }

    const tracks = (await api.searchTracks(query))?.items?.slice(0, MAX_RESULTS) || [];
    if (tracks.length === 0) {
        return createResponseMessage(`No songs found for "${query}".`);
    }

    return createResponseMessage(`Search results for "${query}":`, tracks);
}

async function handleRecommendationIntent(inputText) {
    const api = panelContext.api;
    const player = panelContext.player;
    if (!api) return createResponseMessage('Music API is not ready yet.');

    const stripped = inputText
        .replace(/\b(recommend|recommendation|songs?|tracks?|like|similar|to|from)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let seedTrack = null;

    if (!stripped && player?.currentTrack) {
        seedTrack = player.currentTrack;
    }

    if (!seedTrack && stripped) {
        const matches = (await api.searchTracks(stripped))?.items || [];
        seedTrack = matches[0] || null;
    }

    if (!seedTrack) {
        return createResponseMessage('Play a song first or ask like "Recommend songs similar to Starboy".');
    }

    const recommendations = (await api.getTrackRecommendations(seedTrack.id)) || [];
    if (recommendations.length === 0) {
        return createResponseMessage(`I could not find recommendations for "${seedTrack.title}" right now.`);
    }

    return createResponseMessage(`Songs similar to "${seedTrack.title}":`, recommendations);
}

async function resolveAssistantReply(inputText) {
    const normalized = inputText.toLowerCase();

    if (/\btop\b/.test(normalized) && /\b(song|songs|track|tracks)\b/.test(normalized)) {
        return handleTopSongsIntent(inputText);
    }

    if (/\brecommend|similar|like\b/.test(normalized)) {
        return handleRecommendationIntent(inputText);
    }

    if (/\bsearch|find\b/.test(normalized)) {
        return handleSearchIntent(inputText);
    }

    return handleSearchIntent(inputText);
}

/**
 * @param {{ mode: string; url: string; model?: string; apiKey?: string }} config
 * @param {string} prompt
 */
async function submitLlmPrompt(config, prompt) {
    activeLlmRequest?.abort();
    activeLlmRequest = new AbortController();
    const signal = activeLlmRequest.signal;

    chatState.llmHistory.push({ role: 'user', content: prompt });
    if (chatState.llmHistory.length > 24) {
        chatState.llmHistory = chatState.llmHistory.slice(-24);
    }

    /** @type {Array<{ role: 'system' | 'user' | 'assistant'; content: string }>} */
    const messages = [{ role: 'system', content: MUSIC_SYSTEM }, ...chatState.llmHistory];

    try {
        const { text } = await sendMusicAssistantMessages(config, messages, signal);

        chatState.llmHistory.push({ role: 'assistant', content: text });
        if (chatState.llmHistory.length > 24) {
            chatState.llmHistory = chatState.llmHistory.slice(-24);
        }

        const tracks = await resolveTracksFromLlmText(text, panelContext.api);
        return createResponseMessage(text, tracks);
    } catch (err) {
        chatState.llmHistory.pop();
        throw err;
    }
}

async function submitPrompt(prompt) {
    chatState.messages.push({
        id: nextMessageId(),
        role: 'user',
        text: prompt,
    });
    chatState.loading = true;
    rerenderAssistant();

    try {
        if (chatState.assistantSource === 'llm') {
            const cfg = readStoredLlmConfig();
            if (!cfg) {
                chatState.messages.push(
                    createResponseMessage(
                        'Connect an LLM first: tap Setup LLM or the gear icon, run the connection test, then save.'
                    )
                );
            } else {
                const reply = await submitLlmPrompt(cfg, prompt);
                chatState.messages.push(reply);
            }
        } else {
            const reply = await resolveAssistantReply(prompt);
            chatState.messages.push(reply);
        }
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            chatState.messages.push(createResponseMessage('Request cancelled.'));
        } else {
            chatState.messages.push(
                createResponseMessage(error instanceof Error ? error.message : 'Something went wrong.')
            );
        }
    } finally {
        chatState.loading = false;
        activeLlmRequest = null;
        rerenderAssistant();
    }
}

/**
 * @param {object} [options]
 * @param {() => void} [options.onSaved]
 */
function openLlmSetupModal(options = {}) {
    const existing = document.getElementById('ai-llm-setup-modal');
    existing?.remove();

    let draftConfig = { ...(readStoredLlmConfig() || getDefaultLlmConfig()) };
    /** @type {{ status: string; message: string }} */
    let connectionState = { status: 'idle', message: '' };

    const modeLabel = (mode) => {
        if (mode === 'sone-chat') return 'Local Sone backend';
        if (mode === 'g4f') return 'g4f';
        return 'OpenAI-compatible';
    };

    const modal = document.createElement('div');
    modal.id = 'ai-llm-setup-modal';
    modal.className = 'modal active';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'ai-llm-setup-title');

    const renderModal = () => {
        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content wide ai-llm-setup-dialog">
                <h2 id="ai-llm-setup-title">Setup LLM</h2>
                <p class="ai-llm-setup-intro">
                    Same connection types as Sone <code>examples/live-agent</code>:
                    <strong>g4f</strong> (default), a <strong>local Sone</strong> backend, or any <strong>OpenAI-compatible</strong> chat endpoint.
                    Settings use the same browser storage key as live-agent. They are saved only after the connection test passes.
                </p>

                <div class="ai-llm-setup-form">
                    <label class="ai-llm-field">
                        <span>Connection type</span>
                        <select id="ai-llm-mode">
                            <option value="g4f" ${draftConfig.mode === 'g4f' ? 'selected' : ''}>g4f (default)</option>
                            <option value="sone-chat" ${draftConfig.mode === 'sone-chat' ? 'selected' : ''}>Local Sone backend</option>
                            <option value="openai-compatible" ${draftConfig.mode === 'openai-compatible' ? 'selected' : ''}>OpenAI-compatible</option>
                        </select>
                    </label>

                    <label class="ai-llm-field">
                        <span>Endpoint URL</span>
                        <input type="text" id="ai-llm-url" value="${escapeHtml(draftConfig.url)}" autocomplete="off" />
                    </label>

                    <div id="ai-llm-openai-fields">
                        <label class="ai-llm-field">
                            <span>Model (optional)</span>
                            <input type="text" id="ai-llm-model" value="${escapeHtml(draftConfig.model || '')}" placeholder="openai/gpt-4o-mini, llama3, …" autocomplete="off" />
                        </label>
                        <label class="ai-llm-field">
                            <span>API key (optional)</span>
                            <input type="password" id="ai-llm-apikey" value="${escapeHtml(draftConfig.apiKey || '')}" autocomplete="off" />
                        </label>
                    </div>
                </div>

                <div id="ai-llm-hint" class="ai-llm-hint"></div>

                <div id="ai-llm-connection-msg" class="ai-llm-connection-msg" style="display: ${connectionState.message ? 'block' : 'none'}">
                    ${connectionState.message ? escapeHtml(connectionState.message) : ''}
                </div>

                <div class="ai-llm-setup-actions">
                    <button type="button" class="btn-secondary" id="ai-llm-clear-saved" style="display: ${readStoredLlmConfig() ? 'inline-flex' : 'none'}">Clear saved LLM</button>
                    <button type="button" class="btn-secondary" id="ai-llm-close">Close</button>
                    <button type="button" class="btn-primary" id="ai-llm-test-save">Test connection &amp; save</button>
                </div>
            </div>
        `;

        const hintEl = modal.querySelector('#ai-llm-hint');
        const openAiFields = modal.querySelector('#ai-llm-openai-fields');
        const syncModeUi = () => {
            const mode = /** @type {'g4f'|'sone-chat'|'openai-compatible'} */ (draftConfig.mode);
            if (openAiFields) {
                openAiFields.style.display = mode === 'sone-chat' ? 'none' : 'block';
            }
            const urlInput = /** @type {HTMLInputElement | null} */ (modal.querySelector('#ai-llm-url'));
            if (urlInput) {
                urlInput.placeholder =
                    mode === 'sone-chat'
                        ? DEFAULT_CHAT_ENDPOINT
                        : mode === 'g4f'
                          ? DEFAULT_G4F_CHAT_ENDPOINT
                          : OLLAMA_EXAMPLE_URL;
            }
            if (hintEl) {
                if (mode === 'sone-chat') {
                    hintEl.innerHTML = `<pre class="ai-llm-curl-hint">${escapeHtml(
                        `curl -X POST '${draftConfig.url || DEFAULT_CHAT_ENDPOINT}' \\\n  -H 'accept: application/json' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"message":"…"}'`
                    )}</pre>`;
                } else if (mode === 'g4f') {
                    hintEl.innerHTML = `<div>Default: <code>${escapeHtml(DEFAULT_G4F_CHAT_ENDPOINT)}</code></div><div>Default model: <code>${escapeHtml(DEFAULT_G4F_MODEL)}</code></div>`;
                } else {
                    hintEl.innerHTML = `<div>Examples: Ollama <code>${escapeHtml(OLLAMA_EXAMPLE_URL)}</code>, LM Studio <code>${escapeHtml(LM_STUDIO_EXAMPLE_URL)}</code>. Use <code>provider/model</code> when required.</div>`;
                }
            }
        };

        const readFormIntoDraft = () => {
            draftConfig.url = /** @type {HTMLInputElement} */ (modal.querySelector('#ai-llm-url')).value.trim();
            draftConfig.mode = /** @type {'g4f'|'sone-chat'|'openai-compatible'} */ (
                /** @type {HTMLSelectElement} */ (modal.querySelector('#ai-llm-mode')).value
            );
            if (draftConfig.mode !== 'sone-chat') {
                draftConfig.model = /** @type {HTMLInputElement} */ (modal.querySelector('#ai-llm-model')).value.trim();
                draftConfig.apiKey = /** @type {HTMLInputElement} */ (
                    modal.querySelector('#ai-llm-apikey')
                ).value.trim();
            } else {
                draftConfig.model = '';
                draftConfig.apiKey = '';
            }
        };

        modal.querySelector('#ai-llm-mode')?.addEventListener('change', (e) => {
            const prevMode = draftConfig.mode;
            const mode = /** @type {HTMLSelectElement} */ (e.target).value;
            draftConfig.mode = mode;
            if (mode === 'sone-chat') {
                draftConfig = {
                    ...draftConfig,
                    mode: 'sone-chat',
                    url: draftConfig.url || DEFAULT_CHAT_ENDPOINT,
                    model: '',
                    apiKey: '',
                };
            } else if (mode === 'g4f') {
                draftConfig = {
                    ...draftConfig,
                    mode: 'g4f',
                    url: draftConfig.url || DEFAULT_G4F_CHAT_ENDPOINT,
                    model: draftConfig.model || DEFAULT_G4F_MODEL,
                    apiKey: '',
                };
            } else {
                const url =
                    prevMode === 'g4f' || isG4fDefaultEndpoint(draftConfig.url) ? OLLAMA_EXAMPLE_URL : draftConfig.url;
                draftConfig = {
                    ...draftConfig,
                    mode: 'openai-compatible',
                    url: url || OLLAMA_EXAMPLE_URL,
                };
            }
            /** @type {HTMLInputElement | null} */ (modal.querySelector('#ai-llm-url')).value = draftConfig.url;
            /** @type {HTMLInputElement | null} */ (modal.querySelector('#ai-llm-model')).value =
                draftConfig.model || '';
            /** @type {HTMLInputElement | null} */ (modal.querySelector('#ai-llm-apikey')).value =
                draftConfig.apiKey || '';
            connectionState = { status: 'idle', message: '' };
            syncModeUi();
            updateConnectionMsg();
        });

        syncModeUi();
        updateConnectionMsg();

        modal.querySelector('.modal-overlay')?.addEventListener('click', closeModal);
        modal.querySelector('#ai-llm-close')?.addEventListener('click', closeModal);

        modal.querySelector('#ai-llm-clear-saved')?.addEventListener('click', () => {
            clearStoredLlmConfig();
            draftConfig = getDefaultLlmConfig();
            connectionState = { status: 'idle', message: '' };
            renderModal();
            options.onSaved?.();
        });

        modal.querySelector('#ai-llm-test-save')?.addEventListener('click', async () => {
            readFormIntoDraft();
            connectionState = { status: 'testing', message: 'Testing LLM connection…' };
            updateConnectionMsg();
            const btn = /** @type {HTMLButtonElement} */ (modal.querySelector('#ai-llm-test-save'));
            btn.disabled = true;
            try {
                const result = await testLlmConnection(draftConfig);
                const saved = persistStoredLlmConfig(draftConfig);
                draftConfig = saved;
                connectionState = {
                    status: 'success',
                    message: `Connection successful. Saved ${modeLabel(result.mode)}.`,
                };
                updateConnectionMsg();
                showNotification('LLM connected');
                options.onSaved?.();
                closeModal();
            } catch (err) {
                connectionState = {
                    status: 'error',
                    message: err instanceof Error ? err.message : String(err),
                };
                updateConnectionMsg();
            } finally {
                btn.disabled = false;
            }
        });
    };

    function updateConnectionMsg() {
        const el = modal.querySelector('#ai-llm-connection-msg');
        if (!el) return;
        if (!connectionState.message) {
            el.style.display = 'none';
            el.textContent = '';
            return;
        }
        el.style.display = 'block';
        el.textContent = connectionState.message;
        el.className = 'ai-llm-connection-msg';
        if (connectionState.status === 'error') el.classList.add('error');
        if (connectionState.status === 'success') el.classList.add('success');
    }

    function closeModal() {
        modal.remove();
    }

    renderModal();
    document.body.appendChild(modal);
}

function renderControls(container) {
    container.innerHTML = `
        <button id="ai-open-llm-settings-header" class="btn-icon" type="button" title="LLM settings">
            ${SVG_SETTINGS(20)}
        </button>
        <button id="close-ai-assistant-btn" class="btn-icon" title="Close">
            ${SVG_CLOSE(20)}
        </button>
    `;

    container.querySelector('#close-ai-assistant-btn')?.addEventListener('click', () => {
        sidePanelManager.close();
    });

    container.querySelector('#ai-open-llm-settings-header')?.addEventListener('click', () => {
        openLlmSetupModal({
            onSaved: () => {
                rerenderAssistant();
            },
        });
    });
}

export function initializeAiAssistantFab(player, api) {
    panelContext = { player, api };
    chatState.assistantSource = getAssistantSource();
    ensureSeedMessage();
    ensureAiSearchNavDelegation();

    const fabButton = document.getElementById('ai-assistant-fab');
    if (!fabButton || fabButton.dataset.initialized === 'true') return;
    fabButton.dataset.initialized = 'true';

    fabButton.innerHTML = `${SVG_SPARKLES(20)}<span>AI</span>`;

    fabButton.addEventListener('click', () => {
        sidePanelManager.open(AI_VIEW_ID, 'AI Music Assistant', renderControls, renderContent);
    });
}
