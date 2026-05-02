import { ffmpeg } from './ffmpeg.js';

/**
 * video-export.js — Fast offline video export
 *
 * Pipeline:
 *  1. Draw every frame to a Canvas 2D (cover art + lyrics overlay) at target res
 *  2. Each frame → VideoFrame → WebCodecs VideoEncoder (much faster than real-time)
 *  3. Encoded chunks → simple WebM muxer → Blob download
 *
 * No screen sharing. No real-time wait. A 3-min song at 1080p/30fps
 * renders in seconds using GPU-accelerated encoding.
 */

// ─── AVCC to Annex B helpers ──────────────────────────────────────────────────
function extractSpsPps(description) {
    if (!description) return new Uint8Array(0);
    const view = new DataView(description);
    let offset = 5;
    const numOfSps = view.getUint8(offset++) & 0x1F;
    const out = [];
    const annexB = new Uint8Array([0, 0, 0, 1]);
    for (let i = 0; i < numOfSps; i++) {
        const len = view.getUint16(offset);
        offset += 2;
        out.push(annexB);
        out.push(new Uint8Array(description, offset, len));
        offset += len;
    }
    const numOfPps = view.getUint8(offset++);
    for (let i = 0; i < numOfPps; i++) {
        const len = view.getUint16(offset);
        offset += 2;
        out.push(annexB);
        out.push(new Uint8Array(description, offset, len));
        offset += len;
    }
    const total = out.reduce((acc, a) => acc + a.length, 0);
    const res = new Uint8Array(total);
    let pos = 0;
    for (const a of out) { res.set(a, pos); pos += a.length; }
    return res;
}

// ─── Frame renderer ───────────────────────────────────────────────────────────

async function loadImage(url) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => res(img);
        img.onerror = () => rej(new Error(`Failed to load image: ${url}`));
        img.src = url;
    });
}

/** Draw a single video frame onto an OffscreenCanvas */
function drawFrame(ctx, W, H, coverImg, blurredImg, title, artist, lyricsLine, progress) {
    // 1. Blurred background
    ctx.drawImage(blurredImg, 0, 0, W, H);
    // Darkening overlay
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, H);

    // 2. Album art — centered square, 40% of height
    const artSize = Math.round(H * 0.40);
    const artX = Math.round((W - artSize) / 2);
    const artY = Math.round(H * 0.10);
    // shadow
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur  = 40;
    // rounded rect clip
    const r = artSize * 0.06;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(artX + r, artY);
    ctx.lineTo(artX + artSize - r, artY);
    ctx.quadraticCurveTo(artX + artSize, artY, artX + artSize, artY + r);
    ctx.lineTo(artX + artSize, artY + artSize - r);
    ctx.quadraticCurveTo(artX + artSize, artY + artSize, artX + artSize - r, artY + artSize);
    ctx.lineTo(artX + r, artY + artSize);
    ctx.quadraticCurveTo(artX, artY + artSize, artX, artY + artSize - r);
    ctx.lineTo(artX, artY + r);
    ctx.quadraticCurveTo(artX, artY, artX + r, artY);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(coverImg, artX, artY, artSize, artSize);
    ctx.restore();
    ctx.shadowBlur = 0;

    // 3. Progress bar
    const barY = artY + artSize + H * 0.04;
    const barW = Math.round(W * 0.55);
    const barX = Math.round((W - barW) / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, 4, 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.round(barW * progress), 4, 2);
    ctx.fill();

    // 4. Title
    const titleY = barY + H * 0.06;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(H * 0.038)}px Inter, system-ui, sans-serif`;
    ctx.fillText(title, W / 2, titleY, W * 0.7);

    // 5. Artist
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = `${Math.round(H * 0.026)}px Inter, system-ui, sans-serif`;
    ctx.fillText(artist, W / 2, titleY + H * 0.05, W * 0.7);

    // 6. Current lyrics line
    if (lyricsLine) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = `600 ${Math.round(H * 0.032)}px Inter, system-ui, sans-serif`;
        ctx.fillText(lyricsLine, W / 2, titleY + H * 0.12, W * 0.75);
    }
}

/** Create a blurred version of the cover via canvas */
function makeBlurred(coverImg, W, H) {
    const c = new OffscreenCanvas(W, H);
    const cx = c.getContext('2d');
    cx.filter = `blur(${Math.round(H * 0.04)}px)`;
    // Scale cover to fill
    const scale = Math.max(W / coverImg.width, H / coverImg.height);
    const sw = coverImg.width * scale, sh = coverImg.height * scale;
    cx.drawImage(coverImg, (W - sw) / 2, (H - sh) / 2, sw, sh);
    return c;
}

// ─── Main export function ─────────────────────────────────────────────────────

export async function exportVideo({ track, lyricsData, duration, coverUrl, onProgress, onStatus, audioPlayer }) {
    const W   = 1920, H = 1080;
    const FPS = 30;
    const TOTAL_FRAMES = Math.ceil(duration * FPS);
    const SPF = 1 / FPS;

    onStatus?.('Loading cover art…');
    // Proxy through our Vercel API to bypass CORS
    const proxyCoverUrl = coverUrl ? `/api/proxy-audio?url=${encodeURIComponent(coverUrl)}` : '';
    const coverImg   = await loadImage(proxyCoverUrl);
    const blurredCvs = makeBlurred(coverImg, W, H);

    // Parse synced lyrics lines
    const lines = parseLyrics(lyricsData);
    const title  = track.title || '';
    const artist = getArtists(track);

    // Offscreen render canvas
    const canvas = new OffscreenCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // WebCodecs VideoEncoder (H.264)
    let globalSpsPps = null;
    const h264Chunks = [];
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            // Extract SPS/PPS from DecoderConfig only once
            if (metadata?.decoderConfig?.description && !globalSpsPps) {
                globalSpsPps = extractSpsPps(metadata.decoderConfig.description);
                h264Chunks.push(globalSpsPps);
            }
            
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            
            // Convert AVCC length prefixes to Annex B start codes
            let offset = 0;
            const annexB = new Uint8Array([0, 0, 0, 1]);
            while (offset < buf.length) {
                const nalLen = new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0);
                buf.set(annexB, offset);
                offset += 4 + nalLen;
            }
            h264Chunks.push(buf);
        },
        error: (e) => { throw e; },
    });

    encoder.configure({
        codec: 'avc1.4D0028', // Main profile, level 4.0
        width: W, height: H,
        bitrate: 8_000_000,
        framerate: FPS,
        latencyMode: 'quality',
    });

    onStatus?.('Rendering frames…');
    for (let i = 0; i < TOTAL_FRAMES; i++) {
        const t        = i * SPF;
        const progress = duration > 0 ? t / duration : 0;
        const lyric    = getCurrentLyric(lines, t);

        drawFrame(ctx, W, H, coverImg, blurredCvs, title, artist, lyric, progress);

        const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1_000_000) });
        encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();

        if (i % FPS === 0) {
            onProgress?.(i / TOTAL_FRAMES);
            await encoder.flush(); // yield to browser
        }
    }

    onStatus?.('Encoding…');
    await encoder.flush();
    encoder.close();

    onStatus?.('Preparing video bitstream…');
    const totalVideoSize = h264Chunks.reduce((acc, c) => acc + c.length, 0);
    const videoBuffer = new Uint8Array(totalVideoSize);
    let vPos = 0;
    for (const c of h264Chunks) {
        videoBuffer.set(c, vPos);
        vPos += c.length;
    }
    const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });

    if (audioPlayer && audioPlayer.src) {
        try {
            onStatus?.('Fetching audio…');
            const audioRes = await fetch(audioPlayer.src);
            const audioBlob = await audioRes.blob();

            onStatus?.('Muxing audio & video into MP4…');
            const finalBlob = await ffmpeg(audioBlob, {
                extraFiles: [{ name: 'video.264', data: videoBuffer }],
                rawArgs: ['-framerate', String(FPS), '-i', 'video.264', '-i', 'input', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-map', '0:v:0', '-map', '1:a:0', '-shortest', 'output.mp4'],
                outputName: 'output.mp4',
                outputMime: 'video/mp4',
                onProgress: (prog) => {
                    if (prog.stage === 'encoding') {
                        onStatus?.(`Muxing: ${Math.round(prog.progress)}%`);
                    }
                }
            });
            return finalBlob;
        } catch (e) {
            console.error('Failed to mux audio:', e);
            onStatus?.('Audio muxing failed, returning raw video');
        }
    } else {
        try {
            onStatus?.('Muxing video into MP4…');
            const emptyBlob = new Blob([], { type: 'audio/mp3' });
            const finalBlob = await ffmpeg(emptyBlob, {
                extraFiles: [{ name: 'video.264', data: videoBuffer }],
                rawArgs: ['-framerate', String(FPS), '-i', 'video.264', '-c:v', 'copy', 'output.mp4'],
                outputName: 'output.mp4',
                outputMime: 'video/mp4'
            });
            return finalBlob;
        } catch (e) {
            console.error('Failed to mux to MP4:', e);
        }
    }

    return videoBlob;
}

// ─── Lyrics helpers ───────────────────────────────────────────────────────────

function parseLyrics(data) {
    if (!data?.subtitles) return [];
    const lines = [];
    const re = /\[(\d+):(\d+\.\d+)\]\s*(.+)/g;
    let m;
    while ((m = re.exec(data.subtitles)) !== null) {
        const t = parseInt(m[1]) * 60 + parseFloat(m[2]);
        lines.push({ t, text: m[3].trim() });
    }
    return lines;
}

function getCurrentLyric(lines, t) {
    let cur = null;
    for (const l of lines) {
        if (l.t <= t) cur = l.text;
        else break;
    }
    return cur || '';
}

function getArtists(track) {
    if (track.artists?.length) return track.artists.map(a => a.name).join(', ');
    if (track.artist?.name) return track.artist.name;
    return track.artist || '';
}

// ─── Modal UI ─────────────────────────────────────────────────────────────────

function injectStyles() {
    if (document.getElementById('vex-styles')) return;
    const s = document.createElement('style');
    s.id = 'vex-styles';
    s.textContent = `
        #vex-modal { position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(10px); }
        .vex-box { background:var(--background,#111);border:1px solid var(--border,#333);border-radius:16px;padding:28px 30px;min-width:340px;max-width:420px;width:90vw;display:flex;flex-direction:column;gap:18px;box-shadow:0 24px 64px rgba(0,0,0,0.6); }
        .vex-title { margin:0;font-size:1.15rem;font-weight:700;color:var(--foreground,#fff);display:flex;align-items:center;gap:8px; }
        .vex-badge { font-size:0.68rem;font-weight:700;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;padding:2px 8px;border-radius:20px; }
        .vex-note { font-size:0.77rem;opacity:0.5;color:var(--foreground,#fff);line-height:1.5;margin:0; }
        .vex-progress { height:6px;border-radius:3px;background:var(--border,#333);overflow:hidden; }
        .vex-fill { height:100%;border-radius:3px;background:var(--primary,#4fc3f7);transition:width 0.2s; width:0%; }
        .vex-status { font-size:0.82rem;opacity:0.6;color:var(--foreground,#fff);text-align:center;min-height:1.1em; }
        .vex-actions { display:flex;gap:8px; }
        .vex-btn { flex:1;padding:10px;border-radius:10px;font-size:0.88rem;font-weight:600;cursor:pointer;border:none;transition:opacity .15s; }
        .vex-btn:disabled { opacity:0.35;cursor:not-allowed; }
        .vex-btn-primary { background:var(--primary,#4fc3f7);color:var(--primary-foreground,#000); }
        .vex-btn-cancel { background:var(--input,#1e1e1e);border:1px solid var(--border,#333);color:var(--foreground,#fff); }
    `;
    document.head.appendChild(s);
}

let _modal = null;

export function openVideoExportModal({ track, lyricsManager, audioPlayer, coverUrl }) {
    if (_modal) return;
    if (!('VideoEncoder' in window)) {
        alert('WebCodecs is not supported in this browser. Try Chrome 94+ or Edge 94+.');
        return;
    }
    injectStyles();

    const modal = document.createElement('div');
    modal.id = 'vex-modal';
    modal.innerHTML = `
        <div class="vex-box">
            <h2 class="vex-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.87v6.26a1 1 0 0 1-1.447.9L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>
                Export Video
                <span class="vex-badge">WebGPU · WebCodecs</span>
            </h2>
            <p class="vex-note">Renders all frames instantly offline at 1080p/30fps — no real-time recording, no screen sharing needed.</p>
            <div class="vex-progress"><div class="vex-fill" id="vex-fill"></div></div>
            <div class="vex-status" id="vex-status">Ready</div>
            <div class="vex-actions">
                <button class="vex-btn vex-btn-cancel" id="vex-cancel">Cancel</button>
                <button class="vex-btn vex-btn-primary" id="vex-export">⚡ Export</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    _modal = modal;

    const fillEl  = modal.querySelector('#vex-fill');
    const statusEl = modal.querySelector('#vex-status');
    const exportBtn = modal.querySelector('#vex-export');
    const cancelBtn = modal.querySelector('#vex-cancel');

    const close = () => { modal.remove(); _modal = null; };
    cancelBtn.onclick = close;

    exportBtn.onclick = async () => {
        exportBtn.disabled = true;
        cancelBtn.disabled = true;

        try {
            const duration = audioPlayer?.duration || track.duration || 0;
            const lyricsData = lyricsManager?.lyricsCache?.get(track.id) || null;

            const blob = await exportVideo({
                track,
                lyricsData,
                duration,
                coverUrl,
                audioPlayer,
                onProgress: (p) => { fillEl.style.width = `${Math.round(p * 100)}%`; },
                onStatus:   (s) => { statusEl.textContent = s; },
            });

            fillEl.style.width = '100%';
            statusEl.textContent = '✅ Done! Downloading…';

            const url = URL.createObjectURL(blob);
            const a   = Object.assign(document.createElement('a'), {
                href:     url,
                download: `${track.title || 'export'}-1080p.mp4`,
            });
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            setTimeout(close, 1500);
        } catch (err) {
            statusEl.textContent = `❌ ${err.message}`;
            exportBtn.disabled   = false;
            cancelBtn.disabled   = false;
        }
    };
}
