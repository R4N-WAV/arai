# Feature Matrix — Untitled vs Samply vs Arai

Research date: 2026-11-01. The reference sites (untitled.stream, samply.app,
docs.samply.app) are **blocked by this development sandbox's network policy**,
so research used search-engine results: App Store listings, press coverage
(DJ Mag, MusicTech, Music Ally), the Samply docs index (Projects, File
Management, Players/Links, Files API) and third-party comparisons. Rows marked
"unverified" should be re-checked against the live sites once the domains are
allowed (Phase 8 task).

Legend — reference columns: ✅ documented · ◐ partial/paid tier · ? unverified · — not found.
Arai status: `planned` · `in progress` · `done` · `blocked (reason)`.

## Library & organisation

| Feature | Untitled | Samply | Arai phase | Arai status |
|---|---|---|---|---|
| Projects (albums/EPs/collections) | ✅ | ✅ | 2 | planned |
| Folders / nested folders | ✅ file mgmt | ✅ folders in project filesystem | 2 | planned |
| Version "stacks" for a track | ? | ✅ stacks | 2 | planned |
| Drag-and-drop reorder & move | ✅ | ✅ | 2 | planned (+ keyboard/menu alternative) |
| Search / sort / filter / favourites / recents | ◐ | ◐ | 2 | planned |
| Cover artwork | ✅ | ✅ | 2 | planned |
| Tags / genre | ? | ? | 2 | planned |
| Playlists across projects (no duplication) | — (user-requested) | ? | 2 | planned ("collections") |

## Upload & audio

| Feature | Untitled | Samply | Arai phase | Arai status |
|---|---|---|---|---|
| WAV / MP3 / FLAC / AIFF / M4A upload | ✅ | ✅ | 2 | planned |
| Multi-file, progress, cancel, retry | ✅ | ✅ | 2 | planned |
| Waveform | ✅ | ✅ | 2 | planned (client-side peaks) |
| Lossless playback | ✅ | ✅ quality setting | 2 | planned |
| Pitch & speed adjust | ◐ paid | — | 6 | planned (independent) |
| Trimming | ◐ paid | — | 6 | planned (non-destructive) |
| Section looping | ◐ paid | — | 6 | planned |
| Stem splitting (AI) | ◐ paid | — | — | **out of scope V1** (needs server GPU or heavy WASM model; conflicts with zero-access for private content unless run client-side) |
| Tuner in edit suite | ◐ | — | — | out of scope V1 |
| Record-to-track while looping | ◐ | — | — | out of scope V1 |
| Offline listening | ✅ (app) | ✅ (iOS app) | 6 | planned (encrypted cache in browser) |
| Video files | ? | ? | — | out of scope V1 |
| Gapless playback | ? | ? | 6 | planned where browser supports |

## Collaboration & sharing

| Feature | Untitled | Samply | Arai phase | Arai status |
|---|---|---|---|---|
| Share link per project / track | ✅ | ✅ "Links" (players) | 3 | planned |
| Password-protected links | ◐ paid | ✅ | 3 | planned |
| Require account to listen | ◐ paid | ✅ invited-only | 3 | planned |
| Download toggle per link | ? | ✅ | 3 | planned |
| Comment toggle per link | ? | ✅ | 3 | planned |
| Link expiry | ◐ invites can "never expire" | ? | 3 | planned |
| Paywalled links | ? paid projects | ✅ | — | out of scope V1 (payments) |
| Invite collaborators | ✅ | ✅ | 3 | planned (username/email/link) |
| Permission levels | ? | ✅ | 3 | planned: Listener, Editor, Admin, Owner |
| Time-coded comments + replies | ✅ | ✅ | 3 | planned (+resolve, per version) |
| Comments as DAW markers (Pro Tools) | — | ✅ via SoundFlow | — | out of scope V1; export comments as CSV/markers file in Phase 6 |
| Listening sessions / synced playback | — | ✅ (video-call sessions) | — | post-V1 |
| Embed player | ✅ (Musosoup embed) | ✅ | 8 | planned for public content |

## Social, messaging, analytics, platform

| Feature | Untitled | Samply | Arai phase | Arai status |
|---|---|---|---|---|
| Public profile | ◐ | — | 4 | done (picture, header, bio, links, public projects); listening from profile planned |
| Friends / following | — | — | 4 | planned |
| Discovery | — | — | 4 | planned (public only) |
| Direct messages / groups | — | — | 5 | planned (E2EE) |
| Listener analytics | ✅ | ◐ paid "insights" | 6 | planned, privacy-preserving |
| End-to-end / zero-access encryption | — (claims "Dropbox-level" encryption, i.e. server-side) | — | 3/5 | planned — **Arai differentiator** |
| Public API | ? | ✅ | — | post-V1 |
| Import library from other services | — | — | 2 | done — from downloaded folders/ZIPs (no public export API on either service) |
| Native apps | ✅ iOS/desktop | ✅ iOS | — | out of scope (web only, installable PWA) |

## Notes

- Storage limits of references (Samply Basic ≈4 GB free, Untitled paid
  "unlimited") are commercial decisions; Arai's limits are set by its free
  infrastructure (see `ARCHITECTURE.md §6`).
- Arai implements equivalent functionality with original code and design; no
  reference branding, copy or UI is reused.
