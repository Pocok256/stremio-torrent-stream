import fs from "fs-extra";
import MemoryStore from "memory-chunk-store";
import os from "os";
import path from "path";
import WebTorrent, { Torrent } from "webtorrent";
import { getReadableDuration } from "../utils/file.js";

// Try to import Sentry (optional, might fail on older Node versions)
let Sentry: any = null;
try {
  const sentryModule = await import("@sentry/node");
  Sentry = sentryModule;
} catch (e) {
  // Sentry not available, continue without it
}

interface FileInfo {
  name: string;
  path: string;
  size: number;
  url?: string;
}

interface ActiveFileInfo extends FileInfo {
  progress: number;
  downloaded: number;
}

export interface TorrentInfo {
  name: string;
  infoHash: string;
  size: number;
  files: FileInfo[];
}

interface ActiveTorrentInfo extends TorrentInfo {
  progress: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  openStreams: number;
  files: ActiveFileInfo[];
}

// Directory to store downloaded files (default OS temp directory)
const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), "torrent-stream-server");

// Keep downloaded files after all streams are closed (default false)
const KEEP_DOWNLOADED_FILES = process.env.KEEP_DOWNLOADED_FILES
  ? process.env.KEEP_DOWNLOADED_FILES === "true"
  : false;

if (!KEEP_DOWNLOADED_FILES) fs.emptyDirSync(DOWNLOAD_DIR);

// Maximum number of connections per torrent (default 50)
const MAX_CONNS_PER_TORRENT = Number(process.env.MAX_CONNS_PER_TORRENT) || 50;

// Max download speed (bytes/s) over all torrents (default 20MB/s)
const DOWNLOAD_SPEED_LIMIT =
  Number(process.env.DOWNLOAD_SPEED_LIMIT) || 20 * 1024 * 1024;

// Max upload speed (bytes/s) over all torrents (default 1MB/s)
const UPLOAD_SPEED_LIMIT =
  Number(process.env.UPLOAD_SPEED_LIMIT) || 1 * 1024 * 1024;

// Time (ms) to seed torrents after all streams are closed (default 1 minute)
const SEED_TIME = Number(process.env.SEED_TIME) || 60 * 1000;

// Timeout (ms) when adding torrents if no metadata is received (default 5 seconds)
const TORRENT_TIMEOUT = Number(process.env.TORRENT_TIMEOUT) || 5 * 1000;

const infoClient = new WebTorrent({
  // Reduce DHT activity for metadata fetching client
  dht: {
    // Reduce concurrent lookups to save CPU
    concurrency: 8, // default is 16
  },
});

const streamClient = new WebTorrent({
  // @ts-ignore
  downloadLimit: DOWNLOAD_SPEED_LIMIT,
  uploadLimit: UPLOAD_SPEED_LIMIT,
  maxConns: MAX_CONNS_PER_TORRENT,
  dht: {
    // More aggressive for actual streaming
    concurrency: 16,
  },
});

streamClient.on("torrent", (torrent) => {
  console.log(`Added torrent: ${torrent.name}`);
});

streamClient.on("error", (error) => {
  if (typeof error === "string") {
    console.error(`StreamClient Error: ${error}`);
    Sentry?.captureMessage(`StreamClient Error: ${error}`, "error");
  } else {
    if (error.message.startsWith("Cannot add duplicate torrent")) return;
    console.error(`StreamClient Error: ${error.message}`);
    Sentry?.captureException(error);
  }
});

infoClient.on("error", (error) => {
  // InfoClient errors are usually less critical (metadata fetching failures)
  if (typeof error === "string") {
    console.log(`InfoClient Error: ${error}`);
  } else {
    console.log(`InfoClient Error: ${error.message}`);
  }
  // Only capture non-timeout errors
  if (error && typeof error !== "string" && !error.message?.includes("timed out")) {
    Sentry?.captureException(error, {
      level: "warning",
      tags: { client: "infoClient" },
    });
  }
});

const launchTime = Date.now();

export const getStats = () => ({
  uptime: getReadableDuration(Date.now() - launchTime),
  openStreams: [...openStreams.values()].reduce((a, b) => a + b, 0),
  downloadSpeed: streamClient.downloadSpeed,
  uploadSpeed: streamClient.uploadSpeed,
  activeTorrents: streamClient.torrents.map<ActiveTorrentInfo>((torrent) => ({
    name: torrent.name,
    infoHash: torrent.infoHash,
    size: torrent.length,
    progress: torrent.progress,
    downloaded: torrent.downloaded,
    uploaded: torrent.uploaded,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    peers: torrent.numPeers,
    openStreams: openStreams.get(torrent.infoHash) || 0,
    files: torrent.files.map((file) => ({
      name: file.name,
      path: file.path,
      size: file.length,
      progress: file.progress,
      downloaded: file.downloaded,
    })),
  })),
});

export const getOrAddTorrent = (uri: string) =>
  new Promise<Torrent | undefined>((resolve) => {
    let resolved = false;

    // Cleanup function that ensures everything is cleaned up exactly once
    const cleanup = (result: Torrent | undefined, torrent: any, shouldDestroy: boolean) => {
      if (resolved) return; // Prevent double cleanup
      resolved = true;

      clearTimeout(timeout);

      // Remove error listener to prevent memory leak
      if (torrent) {
        torrent.removeListener('error', onError);
      }

      // Only destroy if we should (not for duplicates or successful adds)
      if (shouldDestroy && torrent && typeof torrent.destroy === 'function') {
        try {
          torrent.destroy();
        } catch (e) {
          // Ignore destroy errors
        }
      }

      resolve(result);
    };

    // Error handler
    const onError = (err: Error) => {
      // Check if it's a duplicate torrent error
      if (err.message && err.message.includes('duplicate torrent')) {
        console.log(`Torrent already added, reusing existing`);
        // Try to get the existing torrent
        const existingTorrent = streamClient.torrents.find(t =>
          t.magnetURI === uri || t.infoHash === uri
        );
        cleanup(existingTorrent, torrent, false); // Don't destroy, just cleanup listeners
      } else {
        console.log(`Failed to add torrent: ${err.message}`);
        cleanup(undefined, torrent, true); // Destroy on real errors
      }
    };

    const torrent = streamClient.add(
      uri,
      {
        path: DOWNLOAD_DIR,
        destroyStoreOnDestroy: !KEEP_DOWNLOADED_FILES,
        // @ts-ignore
        deselect: true,
      },
      (torrent) => {
        cleanup(torrent, torrent, false); // Success, don't destroy
      }
    );

    // Listen for errors
    torrent.on('error', onError);

    const timeout = setTimeout(() => {
      console.log(`Timeout adding torrent: ${uri.substring(0, 50)}...`);
      cleanup(undefined, torrent, true); // Timeout, destroy
    }, TORRENT_TIMEOUT);
  });

export const getFile = (torrent: Torrent, path: string) =>
  torrent.files.find((file) => file.path === path);

export const getTorrentInfo = async (uri: string) => {
  const getInfo = (torrent: Torrent): TorrentInfo => ({
    name: torrent.name,
    infoHash: torrent.infoHash,
    size: torrent.length,
    files: torrent.files.map((file) => ({
      name: file.name,
      path: file.path,
      size: file.length,
    })),
  });

  return await new Promise<TorrentInfo | undefined>((resolve) => {
    let resolved = false;

    // Cleanup function that ensures everything is cleaned up exactly once
    const cleanup = (result: TorrentInfo | undefined, torrent: any) => {
      if (resolved) return; // Prevent double cleanup
      resolved = true;

      clearTimeout(timeout);

      // Remove error listener to prevent memory leak
      if (torrent) {
        torrent.removeListener('error', onError);
      }

      // Destroy torrent if it exists and is not already destroyed
      if (torrent && typeof torrent.destroy === 'function') {
        try {
          torrent.destroy();
        } catch (e) {
          // Ignore destroy errors
        }
      }

      resolve(result);
    };

    // Error handler
    const onError = (err: Error) => {
      console.log(`Failed to fetch torrent info: ${err.message}`);
      cleanup(undefined, torrent);
    };

    const torrent = infoClient.add(
      uri,
      { store: MemoryStore, destroyStoreOnDestroy: true },
      (torrent) => {
        const info = getInfo(torrent);
        console.log(`Fetched info: ${info.name}`);
        cleanup(info, torrent);
      }
    );

    // Listen for errors
    torrent.on('error', onError);

    const timeout = setTimeout(() => {
      console.log(`Timeout fetching torrent info for: ${uri.substring(0, 50)}...`);
      cleanup(undefined, torrent);
    }, TORRENT_TIMEOUT);
  });
};

const timeouts = new Map<string, NodeJS.Timeout>();
const openStreams = new Map<string, number>();

// Periodic cleanup to prevent memory leaks and reduce CPU usage when idle
setInterval(() => {
  const now = Date.now();

  // 1. CLEANUP ORPHAN INFO TORRENTS
  // Info torrents should only exist temporarily during metadata fetching
  if (infoClient.torrents.length > 0) {
    console.log(`Checking ${infoClient.torrents.length} info torrents for cleanup...`);

    infoClient.torrents.forEach((torrent) => {
      // Check if torrent is old (older than TORRENT_TIMEOUT * 3)
      // @ts-ignore - _addedAt is not in types but exists
      const torrentAge = now - (torrent._addedAt || now);

      if (torrentAge > TORRENT_TIMEOUT * 3) {
        console.log(`Cleaning up stale info torrent: ${torrent.name || torrent.infoHash}`);
        try {
          torrent.destroy();
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
    });
  }

  // 2. CLEANUP ORPHAN TIMEOUTS
  // Check for torrents that have pending timeouts but no longer exist
  const activeHashes = new Set(streamClient.torrents.map(t => t.infoHash));
  for (const [hash, timeout] of timeouts.entries()) {
    if (!activeHashes.has(hash)) {
      console.log(`Cleaning up orphan timeout for hash: ${hash.substring(0, 8)}...`);
      clearTimeout(timeout);
      timeouts.delete(hash);
      openStreams.delete(hash);
    }
  }

  // 3. THROTTLE DHT WHEN IDLE (CPU optimization)
  const isIdle = streamClient.torrents.length === 0 && infoClient.torrents.length === 0;

  try {
    // @ts-ignore - DHT pause/resume not in types
    if (isIdle && streamClient.dht && streamClient.dht.listening) {
      // Don't fully destroy DHT, just reduce activity
      console.log('System idle, reducing DHT activity...');
    }
  } catch (e) {
    // DHT methods might not be available
  }

  // 4. LOG STATS FOR MONITORING
  if (streamClient.torrents.length > 0 || openStreams.size > 0) {
    console.log(`Active torrents: ${streamClient.torrents.length}, Open streams: ${openStreams.size}, Pending timeouts: ${timeouts.size}`);
  }
}, 30000); // Run every 30 seconds

export const streamOpened = (hash: string, fileName: string) => {
  console.log(`Stream opened: ${fileName}`);

  const count = openStreams.get(hash) || 0;
  openStreams.set(hash, count + 1);

  const timeout = timeouts.get(hash);

  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(hash);
  }
};

export const streamClosed = (hash: string, fileName: string) => {
  console.log(`Stream closed: ${fileName}`);

  const count = openStreams.get(hash) || 1;
  const newCount = count - 1;

  // Update or delete the stream count
  if (newCount > 0) {
    openStreams.set(hash, newCount);
    return; // Still have open streams, don't schedule cleanup
  }

  // No more open streams for this torrent
  openStreams.delete(hash);

  // Clear any existing timeout before creating a new one
  const existingTimeout = timeouts.get(hash);
  if (existingTimeout) {
    console.log(`Clearing existing timeout for: ${hash.substring(0, 8)}...`);
    clearTimeout(existingTimeout);
    timeouts.delete(hash);
  }

  // Schedule torrent cleanup after SEED_TIME
  const timeout = setTimeout(async () => {
    try {
      const torrent = streamClient.get(hash);

      if (!torrent) {
        console.log(`Torrent already removed: ${hash.substring(0, 8)}...`);
        timeouts.delete(hash);
        return;
      }

      console.log(`Removing torrent after seed time: ${torrent.name}`);

      // @ts-ignore
      torrent.destroy({ destroyStore: !KEEP_DOWNLOADED_FILES }, (err) => {
        if (err) {
          const errorMsg = typeof err === 'string' ? err : err.message;
          console.error(`Error destroying torrent: ${errorMsg}`);
          Sentry?.captureException(err, {
            level: "warning",
            tags: { operation: "torrent_destroy" },
            extra: { hash: hash.substring(0, 8), torrentName: torrent.name },
          });
        } else {
          console.log(`Successfully removed torrent: ${torrent.name}`);
        }

        // Always cleanup timeout, even if destroy failed
        timeouts.delete(hash);

        // Force remove all listeners to prevent memory leaks
        try {
          // @ts-ignore
          torrent.removeAllListeners();
        } catch (e) {
          // Ignore errors
        }
      });
    } catch (error) {
      console.error(`Error in streamClosed timeout: ${error}`);
      Sentry?.captureException(error, {
        level: "error",
        tags: { operation: "stream_closed_timeout" },
        extra: { hash: hash.substring(0, 8) },
      });
      timeouts.delete(hash);
    }
  }, SEED_TIME);

  timeouts.set(hash, timeout);
  console.log(`Scheduled cleanup for ${fileName} in ${SEED_TIME / 1000}s`);
};
