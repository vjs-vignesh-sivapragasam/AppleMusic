import TrackPlayer, { 
  Capability, 
  State, 
  Event, 
  AppKilledPlaybackBehavior,
  Capability as RemoteControlCapability
} from 'react-native-track-player';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Song } from '../types';
import { googleDriveService } from './googleDriveService';
import { youtubeService } from './youtubeService';
import { usePlayerStore, useSettingsStore } from '../store';

const CACHE_DIR = `${FileSystem.cacheDirectory}music-cache/`;

class AudioService {
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private appSub: any = null;

  // Simple debounce: ignore status-driven isPlaying writes for 500ms after
  // a manual play/pause so the icon doesn't flicker back.
  private _lockUntil = 0;
  private _lock() { this._lockUntil = Date.now() + 500; }
  private _locked() { return Date.now() < this._lockUntil; }

  // ─── Init ──────────────────────────────────────────────────────────────────
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        console.log('[Audio] Starting TrackPlayer setup...');
        try {
          await TrackPlayer.setupPlayer({
            waitForBuffer: true,
          });
        } catch (e: any) {
          // If already initialized, we can just proceed
          if (e.message?.includes('already initialized')) {
            console.log('[Audio] TrackPlayer already initialized');
          } else {
            throw e;
          }
        }

        await TrackPlayer.updateOptions({
          android: {
            appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
          },
          capabilities: [
            Capability.Play,
            Capability.Pause,
            Capability.SkipToNext,
            Capability.SkipToPrevious,
            Capability.SeekTo,
            Capability.Stop,
          ],
          compactCapabilities: [
            Capability.Play,
            Capability.Pause,
            Capability.SkipToNext,
          ],
          notificationCapabilities: [
            Capability.Play,
            Capability.Pause,
            Capability.SkipToNext,
            Capability.SkipToPrevious,
            Capability.Stop,
            Capability.SeekTo,
          ],
        });

        // Subscribe to track changes
        TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, (event) => {
          if (event.track) {
            usePlayerStore.setState({ duration: (event.track.duration || 0) * 1000 });
          }
        });

        this.appSub = AppState.addEventListener('change', () => {});
        const info = await FileSystem.getInfoAsync(CACHE_DIR);
        if (!info.exists) await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });

        // Subscribe to playback state changes to sync with Zustand
        TrackPlayer.addEventListener(Event.PlaybackState, (event) => {
          if (this._locked()) return;
          const isPlaying = event.state === State.Playing;
          usePlayerStore.setState({ isPlaying });
        });

        // Periodically sync progress
        setInterval(async () => {
          try {
            if (await TrackPlayer.getState() === State.Playing) {
              const position = await TrackPlayer.getPosition();
              const duration = await TrackPlayer.getDuration();
              usePlayerStore.setState({ 
                currentTime: position * 1000,
                duration: duration * 1000
              });
            }
          } catch {}
        }, 1000);

        this.isInitialized = true;
        console.log('[Audio] ✓ TrackPlayer initialization complete');
      } catch (e) {
        console.error('[Audio] ✗ Initialize error:', e);
        this.initPromise = null; // allow retry
        throw e;
      }
    })();

    return this.initPromise;
  }

  // ─── Load & Play ───────────────────────────────────────────────────────────
  async loadAndPlay(song: Song): Promise<void> {
    try {
      console.log(`[Audio] Loading song: ${song.title}`);
      if (!this.isInitialized) {
        await this.initialize();
      }

      // 1. Update store immediately
      usePlayerStore.setState({ currentSong: song, isPlaying: true, currentTime: 0 });
      this._lock();

      // 2. Resolve source
      const source = await this._resolveSource(song);
      console.log(`[Audio] Source resolved: ${source.uri.substring(0, 50)}...`);

      // 3. Reset and Add to TrackPlayer
      await TrackPlayer.reset();
      await TrackPlayer.add({
        id: song.id,
        url: source.uri,
        title: song.title,
        artist: song.artist,
        album: song.album || 'Unknown Album',
        artwork: song.artwork && song.artwork.startsWith('http') ? song.artwork : undefined,
        duration: song.duration ? song.duration / 1000 : undefined,
        headers: source.headers,
      });

      // 4. Play
      await TrackPlayer.play();
      console.log('[Audio] Play command sent');
    } catch (err) {
      console.error('[Audio] loadAndPlay error:', err);
      usePlayerStore.setState({ isPlaying: false });
    }
  }

  private async _resolveSource(song: Song): Promise<any> {
    let url = song.url;

    if (song.source === 'youtube') {
      if (!url) {
        const resolved = await youtubeService.getAudioUrl(song.id);
        if (!resolved) throw new Error('Could not resolve YouTube URL');
        url = resolved;
        // Update queue entry
        const { queue, queueIndex } = usePlayerStore.getState();
        if (queue[queueIndex]?.id === song.id) {
          const q = [...queue];
          q[queueIndex] = { ...q[queueIndex], url };
          usePlayerStore.setState({ queue: q });
        }
      }
      return {
        uri: url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      };
    }

    if (song.source === 'google-drive') {
      if (song.localUri) {
        try {
          const info = await FileSystem.getInfoAsync(song.localUri);
          if (info.exists) return { uri: song.localUri };
        } catch {}
      }
      const cached = await this._getCached(song.id);
      if (cached) return { uri: cached };

      if (!url) throw new Error(`[Audio] No URL for song: ${song.title}`);
      const token = await googleDriveService.getAccessToken();
      if (!token) throw new Error('No Google Drive token — please reconnect');
      const authedUri = url.includes('?')
        ? `${url}&access_token=${encodeURIComponent(token)}`
        : `${url}?access_token=${encodeURIComponent(token)}`;
      this._cacheInBg(song, token);
      return { uri: authedUri };
    }

    if (!url) throw new Error(`[Audio] No URL for song: ${song.title}`);
    return { uri: url };
  }

  // ─── Controls ─────────────────────────────────────────────────────────────
  async play(): Promise<void> {
    this._lock();
    await TrackPlayer.play();
    usePlayerStore.setState({ isPlaying: true });
  }

  async pause(): Promise<void> {
    this._lock();
    await TrackPlayer.pause();
    usePlayerStore.setState({ isPlaying: false });
  }

  async seekTo(ms: number): Promise<void> {
    await TrackPlayer.seekTo(ms / 1000);
  }

  async setVolume(v: number): Promise<void> {
    await TrackPlayer.setVolume(v);
  }

  async unload(): Promise<void> {
    await TrackPlayer.reset();
    if (this.appSub) { this.appSub.remove(); this.appSub = null; }
  }

  async clearCache(): Promise<void> {
    try {
      const info = await FileSystem.getInfoAsync(CACHE_DIR);
      if (info.exists) {
        await FileSystem.deleteAsync(CACHE_DIR);
        await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
      }
    } catch {}
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────
  private async _getCached(id: string): Promise<string | null> {
    const uri = `${CACHE_DIR}${id}.mp3`;
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? uri : null;
  }

  private async _cacheInBg(song: Song, token: string): Promise<void> {
    if (!useSettingsStore.getState().cacheStreaming) return;
    try {
      const dest = `${CACHE_DIR}${song.id}.mp3`;
      if ((await FileSystem.getInfoAsync(dest)).exists) return;
      await FileSystem.downloadAsync(song.url, dest, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }
}

export const audioService = new AudioService();