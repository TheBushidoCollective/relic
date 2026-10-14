import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMediaCover } from '../src/cover/media.ts';
import { probeFfmpeg, runFfmpeg } from '../src/resolve-anchor.ts';

describe('cover-media', () => {
  test('skips with ffmpeg_not_found when ffmpeg is disabled or null', async () => {
    const dummyBytes = new Uint8Array([1, 2, 3, 4]);
    const res = await extractMediaCover(
      dummyBytes,
      'video.mp4',
      'video/mp4',
      null
    );

    if ('status' in res) {
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('ffmpeg_not_found');
      expect(res.detail).toBe(
        'ffmpeg is needed to depict audio and video and was not found; set RELIC_FFMPEG_PATH'
      );
    } else {
      expect(true).toBe(false);
    }
  });

  test('runs real ffmpeg to extract video thumbnail when present', async () => {
    const ffmpegPath = await probeFfmpeg();
    if (!ffmpegPath) {
      console.warn('ffmpeg not found, skipping real ffmpeg test');
      return;
    }

    const syntheticMp4 = await runFfmpeg(
      ffmpegPath,
      [
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x240:d=1',
        '-threads',
        '1',
        '-c:v',
        'mpeg4',
        '-f',
        'mp4',
        '-movflags',
        '+frag_keyframe+empty_moov',
        'pipe:1',
      ],
      new Uint8Array(0),
      10000
    );

    const res = await extractMediaCover(
      syntheticMp4,
      'clip.mp4',
      'video/mp4',
      ffmpegPath
    );

    expect('kind' in res).toBe(true);
    if ('kind' in res) {
      expect(res.kind).toBe('video');
      expect(res.bytes.length).toBeGreaterThan(0);
      // Valid PNG signature
      expect(res.bytes[0]).toBe(0x89);
      expect(res.bytes[1]).toBe(0x50);
      expect(res.bytes[2]).toBe(0x4e);
      expect(res.bytes[3]).toBe(0x47);
    }
  }, 35000);
  test('runs real ffmpeg to extract audio artwork when present', async () => {
    const ffmpegPath = await probeFfmpeg();
    if (!ffmpegPath) {
      console.warn('ffmpeg not found, skipping real ffmpeg test');
      return;
    }

    const m4aWithPoster = await runFfmpeg(
      ffmpegPath,
      [
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=mono',
        '-f',
        'lavfi',
        '-i',
        'color=c=green:s=150x150:d=1',
        '-c:a',
        'aac',
        '-c:v',
        'png',
        '-t',
        '1',
        '-f',
        'mp4',
        '-movflags',
        '+frag_keyframe+empty_moov',
        'pipe:1',
      ],
      new Uint8Array(0)
    );

    const res = await extractMediaCover(
      m4aWithPoster,
      'song.m4a',
      'audio/mp4',
      ffmpegPath
    );
    expect('kind' in res).toBe(true);
    if ('kind' in res) {
      expect(res.kind).toBe('audio-artwork');
      expect(res.bytes.length).toBeGreaterThan(0);
      expect(res.bytes[0]).toBe(0x89);
      expect(res.bytes[1]).toBe(0x50);
      expect(res.bytes[2]).toBe(0x4e);
      expect(res.bytes[3]).toBe(0x47);
    }
  }, 35000);
  test('runs real ffmpeg to extract audio waveform when no artwork is present', async () => {
    const ffmpegPath = await probeFfmpeg();
    if (!ffmpegPath) {
      console.warn('ffmpeg not found, skipping real ffmpeg test');
      return;
    }

    const syntheticWav = await runFfmpeg(
      ffmpegPath,
      [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-f',
        'wav',
        'pipe:1',
      ],
      new Uint8Array(0)
    );

    const res = await extractMediaCover(
      syntheticWav,
      'track.wav',
      'audio/wav',
      ffmpegPath
    );
    expect('kind' in res).toBe(true);
    if ('kind' in res) {
      expect(res.kind).toBe('audio-waveform');
      expect(res.bytes.length).toBeGreaterThan(0);
      expect(res.bytes[0]).toBe(0x89);
      expect(res.bytes[1]).toBe(0x50);
      expect(res.bytes[2]).toBe(0x4e);
      expect(res.bytes[3]).toBe(0x47);
    }
  }, 35000);
  test('falls through to audio waveform when video file has no video stream', async () => {
    const ffmpegPath = await probeFfmpeg();
    if (!ffmpegPath) {
      console.warn('ffmpeg not found, skipping real ffmpeg test');
      return;
    }

    // Audio-only file named .mp4
    const audioOnlyMp4 = await runFfmpeg(
      ffmpegPath,
      [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=800:duration=1',
        '-c:a',
        'aac',
        '-vn',
        '-f',
        'mp4',
        '-movflags',
        '+frag_keyframe+empty_moov',
        'pipe:1',
      ],
      new Uint8Array(0)
    );

    const res = await extractMediaCover(
      audioOnlyMp4,
      'novideo.mp4',
      'video/mp4',
      ffmpegPath
    );
    expect('kind' in res).toBe(true);
    if ('kind' in res) {
      expect(res.kind).toBe('audio-waveform');
      expect(res.bytes.length).toBeGreaterThan(0);
    }
  }, 35000);
  test('runFfmpeg timeoutMs aborts and kills child process', async () => {
    const ffmpegPath = await probeFfmpeg();
    if (!ffmpegPath) return;

    let caught: unknown;
    try {
      // 1ms timeout on command
      await runFfmpeg(
        ffmpegPath,
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=60:size=1920x1080:rate=30',
          '-f',
          'null',
          '-',
        ],
        new Uint8Array(0),
        1
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain('ffmpeg timed out');
  });

  test('extracts cover from late-moov MP4 and late-moov M4A', async () => {
    const ffmpegPath = await probeFfmpeg();
    if (!ffmpegPath) {
      console.warn('ffmpeg not found, skipping late-moov test');
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), 'relic-late-moov-test-'));
    try {
      const faststartM4a = join(dir, 'faststart.m4a');
      const lateMoovM4a = join(dir, 'late-moov.m4a');

      // 1. Generate late-moov M4A
      const p1 = spawn(
        ffmpegPath,
        [
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=10',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          '-y',
          faststartM4a,
        ],
        { stdio: 'ignore' }
      );
      await new Promise<void>((resolve, reject) => {
        p1.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`faststart m4a failed with code ${code}`))
        );
        p1.on('error', reject);
      });

      const p2 = spawn(
        ffmpegPath,
        ['-i', faststartM4a, '-c', 'copy', '-y', lateMoovM4a],
        { stdio: 'ignore' }
      );
      await new Promise<void>((resolve, reject) => {
        p2.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`late-moov m4a failed with code ${code}`))
        );
        p2.on('error', reject);
      });

      const m4aBytes = await readFile(lateMoovM4a);
      const m4aCover = await extractMediaCover(
        new Uint8Array(m4aBytes),
        'memo.m4a',
        'audio/mp4',
        ffmpegPath
      );
      expect('kind' in m4aCover).toBe(true);
      if ('kind' in m4aCover) {
        expect(m4aCover.kind).toBe('audio-waveform');
        expect(m4aCover.bytes.length).toBeGreaterThan(0);
      }

      // 2. Generate late-moov MP4
      const faststartMp4 = join(dir, 'faststart.mp4');
      const lateMoovMp4 = join(dir, 'late-moov.mp4');

      const p3 = spawn(
        ffmpegPath,
        [
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=320x240:d=1',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-y',
          faststartMp4,
        ],
        { stdio: 'ignore' }
      );
      await new Promise<void>((resolve, reject) => {
        p3.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`faststart mp4 failed with code ${code}`))
        );
        p3.on('error', reject);
      });

      const p4 = spawn(
        ffmpegPath,
        ['-i', faststartMp4, '-c', 'copy', '-y', lateMoovMp4],
        { stdio: 'ignore' }
      );
      await new Promise<void>((resolve, reject) => {
        p4.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`late-moov mp4 failed with code ${code}`))
        );
        p4.on('error', reject);
      });

      const mp4Bytes = await readFile(lateMoovMp4);
      const mp4Cover = await extractMediaCover(
        new Uint8Array(mp4Bytes),
        'video.mp4',
        'video/mp4',
        ffmpegPath
      );
      expect('kind' in mp4Cover).toBe(true);
      if ('kind' in mp4Cover) {
        expect(mp4Cover.kind).toBe('video');
        expect(mp4Cover.bytes.length).toBeGreaterThan(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
