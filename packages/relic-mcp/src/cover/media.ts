import { isAudioMedia } from '@relic/viewer';
import { probeFfmpeg, runFfmpegTemp } from '../resolve-anchor.ts';

export const FFMPEG_TIMEOUT_MS = 30_000;

export const FFMPEG_VIDEO_THUMBNAIL_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-map',
  '0:v:0',
  '-vf',
  'thumbnail=n=90',
  '-frames:v',
  '1',
  '-f',
  'image2',
  '-c:v',
  'png',
  'pipe:1',
] as const;

export const FFMPEG_AUDIO_ARTWORK_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-map',
  '0:v:0?',
  '-frames:v',
  '1',
  '-c:v',
  'png',
  '-f',
  'image2',
  'pipe:1',
] as const;

export const FFMPEG_AUDIO_WAVEFORM_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-filter_complex',
  '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=2000x600:colors=white[w]',
  '-map',
  '[w]',
  '-frames:v',
  '1',
  '-f',
  'image2',
  '-c:v',
  'png',
  'pipe:1',
] as const;

export type MediaCoverResult =
  | { readonly kind: 'video'; readonly bytes: Uint8Array }
  | { readonly kind: 'audio-artwork'; readonly bytes: Uint8Array }
  | { readonly kind: 'audio-waveform'; readonly bytes: Uint8Array }
  | {
      readonly status: 'skipped';
      readonly reason: 'ffmpeg_not_found';
      readonly detail: string;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'render_failed';
      readonly detail: string;
    };

export async function extractMediaCover(
  bytes: Uint8Array,
  filename: string,
  mimetype: string,
  ffmpegPath?: string | null | undefined
): Promise<MediaCoverResult> {
  const binary = await probeFfmpeg({ ffmpegPath });
  if (!binary) {
    return {
      status: 'skipped',
      reason: 'ffmpeg_not_found',
      detail:
        'ffmpeg is needed to depict audio and video and was not found; set RELIC_FFMPEG_PATH',
    };
  }

  const isAudio = isAudioMedia(mimetype, filename);

  // If not audio, try video thumbnail first
  if (!isAudio) {
    try {
      const thumbnail = await runFfmpegTemp(
        binary,
        FFMPEG_VIDEO_THUMBNAIL_ARGS,
        bytes,
        FFMPEG_TIMEOUT_MS
      );
      if (thumbnail.length > 0) {
        return { kind: 'video', bytes: thumbnail };
      }
    } catch {
      // A file with no video stream falls through to the audio rule
    }
  }

  // Audio rule: try artwork extraction first
  try {
    const artwork = await runFfmpegTemp(
      binary,
      FFMPEG_AUDIO_ARTWORK_ARGS,
      bytes,
      FFMPEG_TIMEOUT_MS
    );
    if (artwork.length > 0) {
      return { kind: 'audio-artwork', bytes: artwork };
    }
  } catch {
    // Non-zero exit or empty output means no artwork
  }

  // Waveform fallback
  try {
    const waveform = await runFfmpegTemp(
      binary,
      FFMPEG_AUDIO_WAVEFORM_ARGS,
      bytes,
      FFMPEG_TIMEOUT_MS
    );
    if (waveform.length > 0) {
      return { kind: 'audio-waveform', bytes: waveform };
    }
    return {
      status: 'skipped',
      reason: 'render_failed',
      detail: 'ffmpeg generated empty waveform output',
    };
  } catch (err) {
    return {
      status: 'skipped',
      reason: 'render_failed',
      detail: `ffmpeg waveform generation failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
