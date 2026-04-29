# PRD-0001: 24/7 Radio Stream

> Status: draft
> Owner: Antigravity
> Created: 2026-04-29

## Problem

Users need a simple 24/7 radio stream playing random audio tracks (songs, podcasts, etc.) managed by admins, without playback controls like seek, prev, or next. It should act as a continuous stream.

## Users

(TBD)

## User Stories

- As a **user**, I want to **listen to a continuous audio stream on a dedicated radio page**, so that **I can enjoy a curated selection of songs and podcasts without managing playback**.

## Acceptance Criteria

- [ ] Create a new route and page specifically for the 24/7 radio.
- [ ] The radio plays audio tracks continuously based on simple logic (e.g., random selection from an admin-managed list).
- [ ] The radio player interface does NOT include playback controls like seek, previous, or next. Only play/pause/mute or simple volume control should be available.
- [ ] The default track is a Khmer Podcast using the URL: `https://weread-oss.weread.asia/Audio/How to Live on 24 hours a day_mixdown.mp3`.

## Out of Scope

- User-controlled track selection or queue management.
- Seeking within the current track.
- Skipping to previous or next tracks.

## Open Questions

- (none)

## References

- Linked tasks: `docs/tasks/todo-0001-implement-24-7-radio.md`
- Related ADRs: (none yet)

---

**Tasks generated from this PRD:**

- [ ] `docs/tasks/todo-0001-implement-24-7-radio.md`
