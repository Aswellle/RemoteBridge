'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, PictureInPicture2, Loader2, AlertTriangle } from 'lucide-react';

interface VideoViewerProps {
  url: string;
  fileName: string;
}

const SPEED_OPTIONS = [0.5, 1, 1.5, 2] as const;

const AUTO_HIDE_DELAY = 3000; // ms of inactivity before controls auto-hide
const SEEK_STEP = 5; // seconds for left/right arrow
const VOLUME_STEP = 0.1; // increment for up/down arrow

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VideoViewer({ url, fileName }: VideoViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const clickTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isDraggingVolume, setIsDraggingVolume] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  // Ref mirror of isPlaying so the auto-hide timer callback reads a fresh value
  const isPlayingRef = useRef(false);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // ===== Core video actions =====

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      video.play();
    } else {
      video.pause();
    }
  }, []);

  const handleVolumeChange = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = Math.max(0, Math.min(1, value));
    video.volume = clamped;
    video.muted = clamped === 0;
    setVolume(clamped);
    setIsMuted(clamped === 0);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.muted) {
      video.muted = false;
      setIsMuted(false);
      if (video.volume === 0) {
        video.volume = 0.5;
        setVolume(0.5);
      }
    } else {
      video.muted = true;
      setIsMuted(true);
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await container.requestFullscreen();
      }
    } catch {
      /* fullscreen unsupported or denied — ignore */
    }
  }, []);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      /* PiP unsupported or denied — ignore */
    }
  }, []);

  // ===== Auto-hide controls =====

  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (isPlayingRef.current) setShowControls(false);
    }, AUTO_HIDE_DELAY);
  }, []);

  const handleActivity = useCallback(() => {
    setShowControls(true);
    setShowSpeedMenu(false);
    clearTimeout(hideTimerRef.current);
    if (isPlayingRef.current) scheduleHide();
  }, [scheduleHide]);

  // ===== Seeking =====

  const seekToFraction = useCallback((fraction: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const t = Math.max(0, Math.min(1, fraction)) * duration;
    video.currentTime = t;
    setCurrentTime(t);
  }, [duration]);

  const handleProgressPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsSeeking(true);
    const bar = progressBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    seekToFraction((e.clientX - rect.left) / rect.width);
  };

  // Global pointer move/up while seeking
  useEffect(() => {
    if (!isSeeking) return;
    const handleMove = (e: PointerEvent) => {
      const bar = progressBarRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      seekToFraction((e.clientX - rect.left) / rect.width);
    };
    const handleUp = () => setIsSeeking(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [isSeeking, seekToFraction]);

  // ===== Volume drag =====

  const handleVolumePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDraggingVolume(true);
    const bar = volumeBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    handleVolumeChange((e.clientX - rect.left) / rect.width);
  };

  useEffect(() => {
    if (!isDraggingVolume) return;
    const handleMove = (e: PointerEvent) => {
      const bar = volumeBarRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      handleVolumeChange((e.clientX - rect.left) / rect.width);
    };
    const handleUp = () => setIsDraggingVolume(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [isDraggingVolume, handleVolumeChange]);

  // ===== Video event listeners =====

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onLoadedMetadata = () => {
      setDuration(video.duration);
      setVolume(video.volume);
      setIsMuted(video.muted);
    };
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onWaiting = () => setIsLoading(true);
    const onCanPlay = () => setIsLoading(false);
    const onPlaying = () => {
      setIsLoading(false);
      setIsPlaying(true);
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onError = () => {
      setError(true);
      setIsLoading(false);
    };
    const onVolume = () => {
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('progress', onProgress);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('volumechange', onVolume);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('volumechange', onVolume);
    };
  }, [url]);

  // Sync playback speed to the element
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // ===== Keyboard shortcuts =====

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          handleActivity();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - SEEK_STEP);
          handleActivity();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (videoRef.current) {
            videoRef.current.currentTime = Math.min(duration, videoRef.current.currentTime + SEEK_STEP);
          }
          handleActivity();
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (videoRef.current) handleVolumeChange(videoRef.current.muted ? VOLUME_STEP : videoRef.current.volume + VOLUME_STEP);
          handleActivity();
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (videoRef.current) handleVolumeChange(videoRef.current.volume - VOLUME_STEP);
          handleActivity();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          handleActivity();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [duration, togglePlay, toggleMute, toggleFullscreen, handleVolumeChange, handleActivity]);

  // ===== Click / double-click on video (distinguish via timer) =====

  const handleVideoClick = () => {
    handleActivity();
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = undefined;
      return; // double-click will handle this gesture
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = undefined;
      togglePlay();
    }, 250);
  };

  const handleVideoDoubleClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = undefined;
    }
    toggleFullscreen();
  };

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      clearTimeout(hideTimerRef.current);
      clearTimeout(clickTimerRef.current);
    };
  }, []);

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration ? (buffered / duration) * 100 : 0;
  const effectiveVolume = isMuted ? 0 : volume;

  return (
    <div
      ref={containerRef}
      className={`relative h-screen w-full bg-black overflow-hidden select-none ${showControls ? 'cursor-default' : 'cursor-none'}`}
      onMouseMove={handleActivity}
    >
      {/* Video element */}
      <video
        ref={videoRef}
        src={url}
        className="absolute inset-0 h-full w-full object-contain bg-black"
        playsInline
        preload="auto"
        onClick={handleVideoClick}
        onDoubleClick={handleVideoDoubleClick}
      />

      {/* Click/double-click interaction layer sits below overlays */}
      {/* (video element itself handles click gestures) */}

      {/* Loading state */}
      {isLoading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-30 pointer-events-none">
          <div className="text-center">
            <Loader2 className="animate-spin h-10 w-10 text-primary mx-auto mb-3" />
            <p className="text-sm text-foreground/80">正在加载视频…</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background z-30">
          <div className="text-center max-w-sm px-4">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-3" />
            <p className="text-base font-medium text-foreground mb-1">视频加载失败</p>
            <p className="text-sm text-muted-foreground">该视频无法解码或资源不可用。</p>
          </div>
        </div>
      )}

      {/* Centered play indicator when paused */}
      {!isPlaying && !isLoading && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="rounded-full bg-black/50 p-5 backdrop-blur-sm">
            <Play className="h-12 w-12 text-white" fill="white" />
          </div>
        </div>
      )}

      {/* Top-left file name overlay */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 p-4 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'}`}
        onMouseMove={(e) => e.stopPropagation()}
      >
        <span className="text-sm text-foreground font-medium drop-shadow-md">{fileName}</span>
      </div>

      {/* Bottom controls bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/80 via-black/60 to-transparent pt-10 px-4 pb-3 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onMouseMove={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* Progress bar */}
        <div
          ref={progressBarRef}
          className="group relative h-2 mb-3 cursor-pointer rounded-full bg-white/25 hover:h-3 transition-all"
          onPointerDown={handleProgressPointerDown}
        >
          {/* Buffered */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/30"
            style={{ width: `${bufferedPercent}%` }}
          />
          {/* Played */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${progressPercent}%` }}
          />
          {/* Thumb */}
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-primary opacity-0 group-hover:opacity-100 transition-opacity shadow"
            style={{ left: `${progressPercent}%` }}
          />
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3">
          {/* Left cluster */}
          <div className="flex items-center gap-2">
            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              className="rounded-full p-1.5 text-foreground hover:bg-white/15 transition-colors"
              aria-label={isPlaying ? '暂停' : '播放'}
              title={isPlaying ? '暂停 (Space)' : '播放 (Space)'}
            >
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={toggleMute}
                className="rounded-full p-1.5 text-foreground hover:bg-white/15 transition-colors"
                aria-label={isMuted ? '取消静音' : '静音'}
                title={isMuted ? '取消静音 (M)' : '静音 (M)'}
              >
                {effectiveVolume === 0 ? (
                  <VolumeX className="h-5 w-5" />
                ) : (
                  <Volume2 className="h-5 w-5" />
                )}
              </button>
              <div
                ref={volumeBarRef}
                className="group relative w-20 h-1.5 cursor-pointer rounded-full bg-white/25 hover:h-2.5 transition-all"
                onPointerDown={handleVolumePointerDown}
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-foreground"
                  style={{ width: `${effectiveVolume * 100}%` }}
                />
                <div
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full bg-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ left: `${effectiveVolume * 100}%` }}
                />
              </div>
            </div>

            {/* Time display */}
            <span className="text-xs text-foreground/90 tabular-nums ml-1">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Right cluster */}
          <div className="flex items-center gap-1 relative">
            {/* Playback speed */}
            <div className="relative">
              <button
                onClick={() => setShowSpeedMenu((v) => !v)}
                className="rounded px-2 py-1 text-xs font-medium text-foreground hover:bg-white/15 transition-colors min-w-[40px]"
                aria-label="播放速度"
                title="播放速度"
              >
                {playbackRate}x
              </button>
              {showSpeedMenu && (
                <div className="absolute bottom-full right-0 mb-2 rounded-md bg-card border border-border shadow-lg overflow-hidden">
                  {SPEED_OPTIONS.map((speed) => (
                    <button
                      key={speed}
                      onClick={() => {
                        setPlaybackRate(speed);
                        setShowSpeedMenu(false);
                      }}
                      className={`block w-full px-4 py-1.5 text-xs text-left hover:bg-white/10 transition-colors ${playbackRate === speed ? 'text-primary font-semibold' : 'text-foreground'}`}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Picture-in-Picture */}
            <button
              onClick={togglePip}
              className="rounded-full p-1.5 text-foreground hover:bg-white/15 transition-colors"
              aria-label="画中画"
              title="画中画"
            >
              <PictureInPicture2 className="h-5 w-5" />
            </button>

            {/* Fullscreen */}
            <button
              onClick={toggleFullscreen}
              className="rounded-full p-1.5 text-foreground hover:bg-white/15 transition-colors"
              aria-label={document.fullscreenElement ? '退出全屏' : '全屏'}
              title={document.fullscreenElement ? '退出全屏 (F)' : '全屏 (F)'}
            >
              {document.fullscreenElement ? (
                <Minimize className="h-5 w-5" />
              ) : (
                <Maximize className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
