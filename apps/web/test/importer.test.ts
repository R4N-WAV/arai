import { describe, expect, it } from 'vitest';
import { buildPlan, parseName, type SourceFile } from '../src/lib/importer';

const f = (path: string, size = 10, lastModified = 0): SourceFile => ({ path: path.split('/'), file: new File([new Uint8Array(size)], path.split('/').at(-1)!, { lastModified }) });

describe('parseName', () => {
  it('recognises common version markers', () => {
    expect(parseName('Glass Hours v2.wav')).toEqual({ title: 'Glass Hours', version: 2 });
    expect(parseName('Glass Hours_V3.wav')).toEqual({ title: 'Glass Hours', version: 3 });
    expect(parseName('Glass Hours (4).mp3')).toEqual({ title: 'Glass Hours', version: 4 });
    expect(parseName('Glass Hours - version 5.flac')).toEqual({ title: 'Glass Hours', version: 5 });
    expect(parseName('Glass Hours mix 2 final.wav').title).toBe('Glass Hours');
    expect(parseName('Glass Hours FINAL.wav').version).toBe(10_000);
    expect(parseName('Glass Hours copy.wav').title).toBe('Glass Hours');
  });

  it('keeps plain numbers that are part of a title', () => {
    expect(parseName('Track 2.wav').title).toBe('Track 2');
    expect(parseName('01 Opening.wav').title).toBe('01 Opening');
    expect(parseName('v2.wav').title).toBe('v2');
  });
});

describe('buildPlan', () => {
  it('turns folders into projects and groups versions into tracks', () => {
    const plan = buildPlan([
      f('Library export/Night Sessions/Glass Hours v1.wav', 10, 1),
      f('Library export/Night Sessions/Glass Hours v2.wav', 10, 2),
      f('Library export/Night Sessions/Glass Hours final.wav', 10, 3),
      f('Library export/Night Sessions/Undertow.mp3'),
      f('Library export/Night Sessions/cover.jpg'),
      f('Library export/Tidal EP/Low Tide.flac'),
      f('Library export/Tidal EP/notes.txt'),
      f('Library export/__MACOSX/._junk.wav'),
      f('Library export/.DS_Store'),
    ]);
    expect(plan.projects.map((p) => p.name)).toEqual(['Night Sessions', 'Tidal EP']);
    const night = plan.projects[0]!;
    expect(night.cover?.name).toBe('cover.jpg');
    expect(night.tracks.map((t) => t.title)).toEqual(['Glass Hours', 'Undertow']);
    expect(night.tracks[0]!.versions.map((v) => v.name)).toEqual(['Glass Hours v1.wav', 'Glass Hours v2.wav', 'Glass Hours final.wav']);
    expect(plan.skipped).toEqual(['Library export/Tidal EP/notes.txt']);
  });

  it('treats a single chosen folder of loose files as one project', () => {
    const plan = buildPlan([f('My Album/A.wav'), f('My Album/B.wav')]);
    expect(plan.projects).toHaveLength(1);
    expect(plan.projects[0]!.name).toBe('My Album');
    expect(plan.projects[0]!.tracks).toHaveLength(2);
  });

  it('handles a ZIP-style root with nested project folders and ignores image-only folders', () => {
    const plan = buildPlan([f('platform-export/Late Bloom/Soft Machine.m4a'), f('platform-export/Artwork/cover.png')]);
    expect(plan.projects.map((p) => p.name)).toEqual(['Late Bloom']);
    expect(plan.skipped).toContain('platform-export/Artwork/cover.png');
  });
});
