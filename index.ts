import 'expo-dev-client';
import 'react-native-gesture-handler';
import { Buffer } from 'buffer';

// Polyfills for music-metadata and other node-based libs
global.Buffer = Buffer;

// ONLY polyfill nextTick if missing, do not touch process object itself
if (global.process && !global.process.nextTick) {
  global.process.nextTick = (fn, ...args) => setImmediate(() => fn(...args));
}

import { registerRootComponent } from 'expo';
import App from './App';
import TrackPlayer from 'react-native-track-player';
import { PlaybackService } from './src/services/playbackService';

registerRootComponent(App);
TrackPlayer.registerPlaybackService(() => PlaybackService);
