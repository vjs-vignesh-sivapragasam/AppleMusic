import TrackPlayer, { Event } from 'react-native-track-player';
import { usePlayerStore } from '../store';
import { audioService } from './audioService';

export const PlaybackService = async function() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  
  TrackPlayer.addEventListener(Event.RemoteNext, () => {
    const { playNext } = usePlayerStore.getState();
    playNext();
    const next = usePlayerStore.getState().currentSong;
    if (next) audioService.loadAndPlay(next);
  });

  TrackPlayer.addEventListener(Event.RemotePrevious, () => {
    const { playPrevious } = usePlayerStore.getState();
    playPrevious();
    const prev = usePlayerStore.getState().currentSong;
    if (prev) audioService.loadAndPlay(prev);
  });

  TrackPlayer.addEventListener(Event.RemoteSeek, (event) => {
    TrackPlayer.seekTo(event.position);
  });
  
  TrackPlayer.addEventListener(Event.RemoteStop, () => {
    TrackPlayer.reset();
  });
};
