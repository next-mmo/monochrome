/**
 * LLM connectivity for the Monochrome AI music assistant.
 * Storage keys and behavior align with sone/examples/live-agent/src/client.ts
 * so the same saved config can be reused across tools.
 */

export const DEFAULT_CHAT_ENDPOINT = 'http://localhost:8080/api/agent/chat';
export const DEFAULT_G4F_API_BASE = 'https://g4f.space/backend-api/v2';
export const DEFAULT_G4F_CHAT_ENDPOINT = `${DEFAULT_G4F_API_BASE}/conversation`;
export const DEFAULT_G4F_MODEL = 'default';
export const TEST_CONNECTION_MESSAGE = 'What tools do you have?';
export const DEFAULT_OPENAI_TEST_MESSAGE = 'Reply with OK.';

/** Same key as live-agent for shared settings. */
export const STORAGE_LLM_CONFIG = 'sone.live-agent.llm-config';

const DEFAULT_G4F_PROVIDER = 'AnyProvider';
const G4F_STATIC_FALLBACK_PROVIDERS = ['DeepInfra', 'Qwen', 'Groq', 'Nvidia', 'OpenRouterFree', 'PollinationsAI'];

const DEFAULT_G4F_IGNORED = [
    'AIBadgr',
    'Anthropic',
    'Azure',
    'BlackboxPro',
    'CachedSearch',
    'Cerebras',
    'Chatai',
    'Claude',
    'Cohere',
    'Custom',
    'DeepSeek',
    'FenayAI',
    'GigaChat',
    'GithubCopilotAPI',
    'GlhfChat',
    'GoogleSearch',
    'GradientNetwork',
    'Grok',
    'HailuoAI',
    'ItalyGPT',
    'MarkItDown',
    'MetaAI',
    'MicrosoftDesigner',
    'BingCreateImages',
    'MiniMax',
    'OpenaiAPI',
    'OpenAIFM',
    'OpenRouter',
    'PerplexityApi',
    'Pi',
    'Replicate',
    'TeachAnything',
    'ThebApi',
    'Together',
    'WeWordle',
    'WhiteRabbitNeo',
    'xAI',
    'YouTube',
    'Yqcloud',
];

const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedFallbackProviders = null;
let cachedFallbackTimestamp = 0;

const ignoredSet = new Set(DEFAULT_G4F_IGNORED);

/** @typedef {'sone-chat'|'g4f'|'openai-compatible'} LlmBackendMode */

/**
 * @typedef {object} StoredLlmConfig
 * @property {LlmBackendMode} mode
 * @property {string} url
 * @property {string} [model]
 * @property {string} [apiKey]
 */

function getBrowserStorage() {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage;
        }
    } catch {
        /* ignore */
    }
    return null;
}

export function getDefaultLlmConfig() {
    return {
        mode: 'g4f',
        url: DEFAULT_G4F_CHAT_ENDPOINT,
        model: DEFAULT_G4F_MODEL,
        apiKey: '',
    };
}

/**
 * @param {StoredLlmConfig} config
 * @returns {StoredLlmConfig}
 */
export function normalizeConfig(config) {
    const normalizedUrl = config.url.trim();
    const canonicalG4fUrl =
        config.mode === 'g4f' && isG4fDefaultEndpoint(normalizedUrl) ? DEFAULT_G4F_CHAT_ENDPOINT : normalizedUrl;

    return {
        mode: config.mode,
        url: canonicalG4fUrl,
        model: (config.model || '').trim(),
        apiKey: (config.apiKey || '').trim(),
    };
}

/**
 * @param {unknown} value
 * @returns {value is StoredLlmConfig}
 */
function isStoredLlmConfig(value) {
    const mode = value != null && typeof value === 'object' ? /** @type {{ mode?: unknown }} */ (value).mode : undefined;
    return (
        value != null &&
        typeof value === 'object' &&
        (mode === 'sone-chat' || mode === 'g4f' || mode === 'openai-compatible') &&
        typeof /** @type {{ url?: unknown }} */ (value).url === 'string'
    );
}

/**
 * @param {Storage | null} [storage]
 * @returns {StoredLlmConfig | null}
 */
export function readStoredLlmConfig(storage = getBrowserStorage()) {
    const raw = storage?.getItem(STORAGE_LLM_CONFIG);
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (!isStoredLlmConfig(parsed)) {
            return null;
        }

        let normalized = normalizeConfig(parsed);
        if (normalized.mode === 'openai-compatible' && isG4fDefaultEndpoint(normalized.url)) {
            normalized = {
                ...normalized,
                mode: 'g4f',
                url: DEFAULT_G4F_CHAT_ENDPOINT,
            };
        }
        return normalized.url ? normalized : null;
    } catch {
        return null;
    }
}

/**
 * @param {StoredLlmConfig} config
 * @param {Storage | null} [storage]
 * @returns {StoredLlmConfig}
 */
export function persistStoredLlmConfig(config, storage = getBrowserStorage()) {
    if (!storage) {
        throw new Error('Local storage is not available in this runtime.');
    }

    const normalized = normalizeConfig(config);
    if (!normalized.url) {
        throw new Error('Endpoint URL is required before saving LLM settings.');
    }

    storage.setItem(STORAGE_LLM_CONFIG, JSON.stringify(normalized));
    return normalized;
}

/** @param {Storage | null} [storage] */
export function clearStoredLlmConfig(storage = getBrowserStorage()) {
    storage?.removeItem(STORAGE_LLM_CONFIG);
}

/** @param {string} url */
export function isG4fDefaultEndpoint(url) {
    const normalized = url.trim().replace(/\/+$/, '');
    return (
        normalized === DEFAULT_G4F_CHAT_ENDPOINT.replace(/\/+$/, '') ||
        normalized === 'https://g4f.space/backend-api/v2' ||
        normalized === 'https://g4f.space/api/pollinations/chat/completions' ||
        normalized === 'https://g4f.space/ai'
    );
}

/**
 * @param {StoredLlmConfig} config
 * @returns {Record<string, string>}
 */
function buildHeaders(config) {
    const headers = {
        accept: 'application/json',
        'Content-Type': 'application/json',
    };

    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    return headers;
}

/** @param {Response} response */
async function readJsonError(response) {
    try {
        const data = await response.json();
        if (typeof data.message === 'string' && data.message) {
            return data.message;
        }
        if (typeof data.error === 'string' && data.error) {
            return data.error;
        }
        if (typeof data.error === 'object' && typeof data.error?.message === 'string') {
            return data.error.message;
        }
    } catch {
        try {
            const text = await response.text();
            if (text.trim().length > 0) {
                return text.trim();
            }
        } catch {
            /* ignore */
        }
    }

    return `Request failed with status ${response.status}`;
}

/** @param {typeof fetch | undefined} fetchImpl */
function ensureFetch(fetchImpl) {
    if (!fetchImpl) {
        throw new Error('Fetch API is not available in this runtime.');
    }
    return fetchImpl;
}

/**
 * @param {string} publicKey
 * @param {string} data
 */
async function encryptG4fSecret(publicKey, data) {
    const mod = await import('jsencrypt');
    const EncryptCtor = /** @type {new () => { setPublicKey(k: string): void; encrypt(d: string): string | false }} */ (
        mod.default || mod.JSEncrypt || mod
    );
    const encryptor = new EncryptCtor();
    encryptor.setPublicKey(publicKey);
    const encrypted = encryptor.encrypt(data);
    if (!encrypted) {
        throw new Error('g4f public key encryption failed.');
    }
    return encrypted;
}

/** @param {string} url */
function resolveG4fApiBase(url) {
    const parsed = new URL(url.trim());
    return `${parsed.origin}/backend-api/v2`;
}

/**
 * @param {StoredLlmConfig} config
 */
function buildG4fApiKeyPayload(config) {
    if (config.apiKey) {
        return config.apiKey;
    }

    return {
        PollinationsAI: null,
        HuggingFace: null,
        Together: null,
        GeminiPro: null,
        OpenRouter: null,
        OpenRouterFree: null,
        Groq: null,
        DeepInfra: null,
        Replicate: null,
        PuterJS: null,
        Azure: null,
        Nvidia: null,
        Ollama: null,
    };
}

/**
 * @param {StoredLlmConfig} config
 * @param {{ fetch: typeof fetch; signal?: AbortSignal }} runtime
 */
async function getG4fConversationHeaders(config, runtime) {
    const fetchImpl = ensureFetch(runtime.fetch);
    const publicKeyUrl = `${resolveG4fApiBase(config.url)}/public-key`;
    let response = await fetchImpl(publicKeyUrl, {
        method: 'POST',
        headers: {
            accept: '*/*',
        },
        signal: runtime.signal,
    });

    if (!response.ok) {
        response = await fetchImpl(publicKeyUrl, {
            headers: {
                accept: '*/*',
            },
            signal: runtime.signal,
        });
    }

    if (!response.ok) {
        throw new Error(await readJsonError(response));
    }

    const data = await response.json();
    if (!data.public_key || !data.data) {
        throw new Error('g4f public-key endpoint returned an incomplete payload.');
    }

    return {
        accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-secret': await encryptG4fSecret(data.public_key, data.data),
    };
}

/** @param {string} streamText */
function parseG4fEventData(streamText) {
    const normalized = streamText.replace(/\r\n/g, '\n');
    const rawEvents = normalized
        .split('\n\n')
        .map((event) => event.trim())
        .filter(Boolean);

    const events = [];
    for (const rawEvent of rawEvents) {
        const dataLines = rawEvent
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6));

        if (dataLines.length === 0) {
            continue;
        }

        try {
            events.push(JSON.parse(dataLines.join('\n')));
        } catch {
            /* ignore */
        }
    }

    return events;
}

/** @param {unknown} event */
function extractAssistantTextFromG4fEvent(event) {
    if (!event) return '';
    if (/** @type {{ type?: string; content?: string }} */ (event).type === 'content' && typeof event.content === 'string') {
        return event.content;
    }
    return '';
}

/** @param {unknown} event */
function extractAssistantTextFromG4fResponse(event) {
    const e = /** @type {{ response?: { choices?: Array<{ delta?: { content?: string }; message?: { content?: string | Array<{ text?: string }> } }> } } } */ (
        event
    );
    if (!e?.response) {
        return '';
    }

    const choiceTexts =
        e.response.choices?.map((choice) => {
            const deltaContent = choice.delta?.content;
            if (typeof deltaContent === 'string') {
                return deltaContent;
            }

            const messageContent = choice.message?.content;
            if (typeof messageContent === 'string') {
                return messageContent;
            }

            if (Array.isArray(messageContent)) {
                return messageContent.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
            }

            return '';
        }) || [];

    return choiceTexts.join('');
}

/** @param {unknown} event */
function readG4fError(event) {
    if (!event) return '';
    if (typeof event.message === 'string' && event.message.trim()) {
        return event.message.trim();
    }
    if (typeof event.error === 'string' && event.error.trim()) {
        return event.error.trim();
    }
    if (typeof event.error === 'object' && typeof event.error?.message === 'string') {
        return event.error.message.trim();
    }
    if (typeof event.response?.error?.message === 'string') {
        return event.response.error.message.trim();
    }
    return '';
}

/** @param {string} message */
function isProviderRetryableError(message) {
    const lower = message.toLowerCase();
    return (
        lower.includes('token limit') ||
        lower.includes('rate limit') ||
        lower.includes('quota exceeded') ||
        lower.includes('limit exceeded') ||
        lower.includes('too many requests') ||
        lower.includes('429')
    );
}

/** @param {unknown[]} providers */
function filterFallbackProviders(providers) {
    return providers
        .filter(
            (p) =>
                p &&
                typeof p === 'object' &&
                p.active_by_default === true &&
                p.auth === false &&
                p.nodriver === false &&
                typeof p.live === 'number' &&
                p.live > 0 &&
                p.name !== DEFAULT_G4F_PROVIDER &&
                !ignoredSet.has(p.name)
        )
        .sort((a, b) => (b.live ?? 0) - (a.live ?? 0))
        .map((p) => p.name);
}

/**
 * @param {StoredLlmConfig} config
 * @param {{ fetch: typeof fetch; signal?: AbortSignal }} runtime
 */
async function fetchFallbackProviders(config, runtime) {
    const now = Date.now();
    if (cachedFallbackProviders && now - cachedFallbackTimestamp < PROVIDER_CACHE_TTL_MS) {
        return cachedFallbackProviders;
    }

    try {
        const response = await ensureFetch(runtime.fetch)(`${resolveG4fApiBase(config.url)}/providers`, {
            headers: { accept: 'application/json' },
            signal: runtime.signal,
        });

        if (!response.ok) {
            return cachedFallbackProviders ?? G4F_STATIC_FALLBACK_PROVIDERS;
        }

        const data = await response.json();
        const providers = filterFallbackProviders(Array.isArray(data) ? data : []);
        if (providers.length > 0) {
            cachedFallbackProviders = providers;
            cachedFallbackTimestamp = now;
            return providers;
        }
    } catch {
        /* fall through */
    }

    return cachedFallbackProviders ?? G4F_STATIC_FALLBACK_PROVIDERS;
}

/** @param {string} streamText */
function parseG4fConversationText(streamText) {
    const events = parseG4fEventData(streamText);
    const contentText = events.map(extractAssistantTextFromG4fEvent).join('');
    const responseText = events.map(extractAssistantTextFromG4fResponse).join('');
    const assistantText = contentText || responseText;
    if (assistantText.trim()) {
        return assistantText;
    }

    const errors = events.map(readG4fError).filter(Boolean);
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    throw new Error('g4f conversation endpoint returned no assistant content.');
}

/**
 * @param {Response} response
 * @param {AbortSignal} [signal]
 */
async function readG4fConversationStream(response, signal) {
    if (!response.body) {
        throw new Error('g4f conversation endpoint returned no response body.');
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    /** @type {string[]} */
    let currentDataLines = [];
    let assistantText = '';
    const terminalErrors = [];
    const deferredErrors = [];
    let sawContentEvent = false;

    const flushEvent = () => {
        if (currentDataLines.length === 0) {
            return null;
        }

        const payload = currentDataLines.join('\n');
        currentDataLines = [];

        try {
            return JSON.parse(payload);
        } catch {
            return null;
        }
    };

    /** @param {unknown} event */
    const handleEvent = (event) => {
        if (!event) {
            return null;
        }

        const contentText = extractAssistantTextFromG4fEvent(event);
        if (contentText) {
            sawContentEvent = true;
            assistantText += contentText;
        } else if (!sawContentEvent) {
            const responseText = extractAssistantTextFromG4fResponse(event);
            if (responseText) {
                assistantText += responseText;
            }
        }

        const respErr =
            event &&
            typeof event === 'object' &&
            'response' in event &&
            event.response &&
            typeof event.response === 'object' &&
            'error' in event.response &&
            event.response.error &&
            typeof event.response.error === 'object' &&
            'message' in event.response.error &&
            typeof event.response.error.message === 'string'
                ? event.response.error.message.trim()
                : '';
        if (respErr) {
            deferredErrors.push(respErr);
        }

        if (/** @type {{ type?: string }} */ (event).type === 'error' || /** @type {{ type?: string }} */ (event).type === 'auth') {
            const terminalError = readG4fError(event);
            if (terminalError) {
                terminalErrors.push(terminalError);
            }
            return 'done';
        }

        if (/** @type {{ type?: string }} */ (event).type === 'finish' || /** @type {{ type?: string }} */ (event).type === 'usage') {
            return 'done';
        }

        return null;
    };

    while (true) {
        if (signal?.aborted) {
            throw new Error('The operation was aborted.');
        }

        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (line.startsWith('data: ')) {
                currentDataLines.push(line.slice(6));
                continue;
            }

            if (line === '') {
                const event = flushEvent();
                if (handleEvent(event) === 'done') {
                    await reader.cancel();
                    if (assistantText.trim()) {
                        return assistantText;
                    }
                    if (terminalErrors.length > 0) {
                        throw new Error(terminalErrors.join('\n'));
                    }
                    if (deferredErrors.length > 0) {
                        throw new Error(deferredErrors.join('\n'));
                    }
                    throw new Error('g4f conversation endpoint returned no assistant content.');
                }
            }
        }
    }

    const finalEvent = flushEvent();
    handleEvent(finalEvent);

    if (assistantText.trim()) {
        return assistantText;
    }
    if (terminalErrors.length > 0) {
        throw new Error(terminalErrors.join('\n'));
    }
    if (deferredErrors.length > 0) {
        throw new Error(deferredErrors.join('\n'));
    }

    return parseG4fConversationText(buffer);
}

function createConversationId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `g4f-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @param {Array<{ role: 'system' | 'user' | 'assistant'; content: string }>} messages
 * @param {StoredLlmConfig} config
 * @param {{ fetch: typeof fetch; signal?: AbortSignal }} runtime
 * @param {string[] | undefined} images
 */
async function requestG4fConversationText(messages, config, runtime, images) {
    let lastError = null;
    /** @type {string[] | null} */
    let fallbackProviders = null;

    const getProvider = (attempt) => {
        if (attempt === 0) return DEFAULT_G4F_PROVIDER;
        return (fallbackProviders ?? G4F_STATIC_FALLBACK_PROVIDERS)[
            (attempt - 1) % (fallbackProviders ?? G4F_STATIC_FALLBACK_PROVIDERS).length
        ];
    };
    const maxAttempts = () => 1 + (fallbackProviders ?? G4F_STATIC_FALLBACK_PROVIDERS).length;

    for (let attempt = 0; attempt < maxAttempts(); attempt++) {
        const provider = getProvider(attempt);
        try {
            /** @type {Record<string, unknown>} */
            const body = {
                id: String(Date.now()),
                conversation_id: createConversationId(),
                model: config.model || DEFAULT_G4F_MODEL,
                web_search: false,
                provider,
                messages,
                action: 'next',
                download_media: true,
                debug_mode: false,
                api_key: buildG4fApiKeyPayload(config),
                ignored: [...DEFAULT_G4F_IGNORED],
                aspect_ratio: '16:9',
            };
            if (images && images.length > 0) {
                body.images = images;
            }
            const response = await ensureFetch(runtime.fetch)(config.url, {
                method: 'POST',
                headers: await getG4fConversationHeaders(config, runtime),
                body: JSON.stringify(body),
                signal: runtime.signal,
            });

            if (!response.ok) {
                const errorMessage = await readJsonError(response);
                if (isProviderRetryableError(errorMessage) && attempt < maxAttempts() - 1) {
                    if (!fallbackProviders) fallbackProviders = await fetchFallbackProviders(config, runtime);
                    lastError = new Error(errorMessage);
                    continue;
                }
                throw new Error(errorMessage);
            }

            return await readG4fConversationStream(response, runtime.signal);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isProviderRetryableError(message) && attempt < maxAttempts() - 1) {
                if (!fallbackProviders) fallbackProviders = await fetchFallbackProviders(config, runtime);
                lastError = error instanceof Error ? error : new Error(message);
                continue;
            }
            throw error;
        }
    }

    throw lastError ?? new Error('g4f: all provider attempts exhausted.');
}

/**
 * @param {StoredLlmConfig} config
 * @param {{ fetch: typeof fetch; signal?: AbortSignal }} runtime
 */
async function fetchG4fModels(config, runtime) {
    const apiKeyPayload = buildG4fApiKeyPayload(config);
    const xApiKeyHeader = typeof apiKeyPayload === 'string' ? apiKeyPayload : '';
    const response = await ensureFetch(runtime.fetch)(`${resolveG4fApiBase(config.url)}/models/${DEFAULT_G4F_PROVIDER}`, {
        headers: {
            accept: '*/*',
            'Content-Type': 'application/json',
            'x-api-key': xApiKeyHeader,
            'x-ignored': DEFAULT_G4F_IGNORED.join(' '),
        },
        signal: runtime.signal,
    });

    if (!response.ok) {
        throw new Error(await readJsonError(response));
    }

    return response.json();
}

/** @param {unknown} data */
function extractAssistantTextOpenAi(data) {
    const content = /** @type {{ choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }} */ (
        data
    ).choices?.[0]?.message?.content;

    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    }

    return '';
}

/**
 * @param {StoredLlmConfig} config
 * @param {Array<{ role: string; content: string }>} messages
 * @param {AbortSignal} [signal]
 */
async function requestOpenAiCompatChatText(config, messages, signal) {
    /** @type {Record<string, unknown>} */
    const body = {
        messages,
        stream: false,
        temperature: 0.6,
    };
    if (config.model) {
        body.model = config.model;
    }

    const response = await fetch(config.url, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        throw new Error(await readJsonError(response));
    }

    const data = await response.json();
    const text = extractAssistantTextOpenAi(data);
    if (!text.trim()) {
        throw new Error('OpenAI-compatible endpoint returned an empty assistant message.');
    }
    return text;
}

/** @param {unknown} data */
function extractSoneChatResponseText(data) {
    if (!data || typeof data !== 'object') return '';
    const obj = /** @type {Record<string, unknown>} */ (data);

    const inner = obj.data && typeof obj.data === 'object' ? /** @type {Record<string, unknown>} */ (obj.data) : obj;

    for (const key of ['response', 'message', 'content', 'text', 'output']) {
        const val = inner[key];
        if (typeof val === 'string' && val.trim()) return val;
    }

    return '';
}

/**
 * @param {StoredLlmConfig} config
 * @param {string} message
 * @param {AbortSignal} [signal]
 */
async function requestSoneChatPlainText(config, message, signal) {
    const response = await fetch(config.url, {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify({ message }),
        signal,
    });

    if (!response.ok) {
        throw new Error(await readJsonError(response));
    }

    const raw = await response.text();
    let data = null;
    try {
        data = JSON.parse(raw);
    } catch {
        data = null;
    }

    const fromJson = extractSoneChatResponseText(data);
    if (fromJson) return fromJson;
    return raw.trim();
}

/**
 * @param {StoredLlmConfig} config
 * @param {{ fetch?: typeof fetch; signal?: AbortSignal }} [options]
 */
export async function testLlmConnection(config, options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
    const normalized = normalizeConfig(config);

    if (!normalized.url) {
        throw new Error('Endpoint URL is required before testing the connection.');
    }

    const runtime = { fetch: fetchImpl, signal: options.signal };

    if (normalized.mode === 'sone-chat') {
        const response = await fetchImpl(normalized.url, {
            method: 'POST',
            headers: buildHeaders(normalized),
            body: JSON.stringify({ message: TEST_CONNECTION_MESSAGE }),
        });

        if (!response.ok) {
            throw new Error(await readJsonError(response));
        }

        return {
            mode: normalized.mode,
            endpoint: normalized.url,
        };
    }

    if (normalized.mode === 'g4f') {
        await requestG4fConversationText([{ role: 'user', content: DEFAULT_OPENAI_TEST_MESSAGE }], normalized, runtime);
        await fetchG4fModels(normalized, runtime);

        return {
            mode: normalized.mode,
            endpoint: normalized.url,
            model: normalized.model || DEFAULT_G4F_MODEL,
        };
    }

    /** @type {Record<string, unknown>} */
    const body = {
        messages: [{ role: 'user', content: DEFAULT_OPENAI_TEST_MESSAGE }],
        stream: false,
        max_tokens: 8,
        temperature: 0,
    };

    if (normalized.model) {
        body.model = normalized.model;
    }

    const response = await fetchImpl(normalized.url, {
        method: 'POST',
        headers: buildHeaders(normalized),
        body: JSON.stringify(body),
        signal: options.signal,
    });

    if (!response.ok) {
        throw new Error(await readJsonError(response));
    }

    return {
        mode: normalized.mode,
        endpoint: normalized.url,
        model: normalized.model,
    };
}

/**
 * Send a multi-turn chat to the configured backend and return assistant plain text.
 * @param {StoredLlmConfig} config
 * @param {Array<{ role: 'system' | 'user' | 'assistant'; content: string }>} messages
 * @param {AbortSignal} [signal]
 */
export async function sendMusicAssistantMessages(config, messages, signal) {
    const normalized = normalizeConfig(config);
    const runtime = { fetch: globalThis.fetch.bind(globalThis), signal };

    if (normalized.mode === 'g4f') {
        const text = await requestG4fConversationText(messages, normalized, runtime);
        return { text };
    }

    if (normalized.mode === 'sone-chat') {
        const combined = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        const text = await requestSoneChatPlainText(normalized, combined, signal);
        return { text };
    }

    const text = await requestOpenAiCompatChatText(normalized, messages, signal);
    return { text };
}
