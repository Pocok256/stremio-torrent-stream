import fs from "fs-extra";
import MemoryStore from "memory-chunk-store";
import os from "os";
import path from "path";
import WebTorrent, { Torrent } from "webtorrent";
import { getReadableDuration, getReadableSize } from "../utils/file.js";
import { captureException } from "../utils/sentry.js";

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

interface FileProgressTracker {
  torrent: Torrent;
  file: Torrent["files"][number];
  onDownload: () => void;
  onDone: () => void;
  nextThreshold: number;
  completed: boolean;
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

// Periodically report torrents that have completed downloading and are seeding.
const SEED_REPORT_INTERVAL = 30 * 60 * 1000;

const infoClient = new WebTorrent();
const streamClient = new WebTorrent({
  // @ts-ignore
  downloadLimit: DOWNLOAD_SPEED_LIMIT,
  uploadLimit: UPLOAD_SPEED_LIMIT,
  maxConns: MAX_CONNS_PER_TORRENT,
});

const seedStartedAt = new Map<
  string,
  { since: number; uploadedAtStart: number }
>();

const fileProgressTrackers = new Map<string, FileProgressTracker>();

streamClient.on("torrent", (torrent) => {
  console.log(`Added torrent: ${torrent.name || torrent.infoHash}`);
});

// WebTorrent emits this at runtime; the installed @types/webtorrent version omits it.
// @ts-expect-error - runtime WebTorrent remove event
streamClient.on("remove", (torrent) => {
  seedStartedAt.delete(torrent.infoHash);

  for (const [key, tracker] of fileProgressTrackers) {
    if (tracker.torrent !== torrent) continue;
    torrent.removeListener("download", tracker.onDownload);
    tracker.file.removeListener("done", tracker.onDone);
    fileProgressTrackers.delete(key);
  }
});

streamClient.on("error", (error) => {
  if (typeof error === "string") {
    console.error(`Error: ${error}`);
    captureException(new Error(error), {
      tags: {
        area: "webtorrent",
        client: "stream",
      },
    });
  } else {
    if (error.message.startsWith("Cannot add duplicate torrent")) return;
    console.error(`Error: ${error.message}`);
    captureException(error, {
      tags: {
        area: "webtorrent",
        client: "stream",
      },
    });
  }
});

infoClient.on("error", (error) => {
  if (typeof error === "string") {
    console.error(`Error: ${error}`);
    captureException(new Error(error), {
      tags: {
        area: "webtorrent",
        client: "info",
      },
    });
  } else {
    console.error(`Error: ${error.message}`);
    captureException(error, {
      tags: {
        area: "webtorrent",
        client: "info",
      },
    });
  }
});

const getErrorMessage = (error: unknown) => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Unknown error";
};

const destroyTorrent = (torrent: Torrent | undefined) => {
  if (!torrent) return;

  try {
    torrent.destroy();
  } catch (error) {
    console.error(`Error destroying torrent: ${getErrorMessage(error)}`);
    captureException(error, {
      tags: {
        area: "webtorrent",
        operation: "destroy",
      },
    });
  }
};

const launchTime = Date.now();

const reportSeedingTorrents = () => {
  const seedingTorrents = streamClient.torrents.filter(
    (torrent) => seedStartedAt.has(torrent.infoHash) && !openStreams.has(torrent.infoHash)
  );
  const memory = process.memoryUsage();
  console.info(
    `Seeding report: ${seedingTorrents.length} seeding / ` +
      `${streamClient.torrents.length} active torrent(s) | ` +
      `memory RSS ${getReadableSize(memory.rss)}, heap ${getReadableSize(memory.heapUsed)}`
  );

  for (const torrent of seedingTorrents) {
    const seedInfo = seedStartedAt.get(torrent.infoHash);
    const seededFor = seedInfo ? Date.now() - seedInfo.since : 0;
    const uploaded = Math.max(
      0,
      torrent.uploaded - (seedInfo?.uploadedAtStart ?? torrent.uploaded)
    );

    console.info(
      `Seeding: ${torrent.name || torrent.infoHash} | ` +
        `uploaded ${getReadableSize(uploaded)} | ` +
        `seeding for ${getReadableDuration(seededFor)} | ` +
        `${torrent.numPeers} peer(s)`
    );
  }
};

const seedReportTimer = setInterval(reportSeedingTorrents, SEED_REPORT_INTERVAL);
seedReportTimer.unref();

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

const pendingTorrents = new Map<string, Promise<Torrent | undefined>>();

const getExistingTorrent = async (uri: string) => {
  try {
    return (await streamClient.get(uri)) || undefined;
  } catch {
    return undefined;
  }
};

export const getOrAddTorrent = async (uri: string) => {
  const pendingTorrent = pendingTorrents.get(uri);
  if (pendingTorrent) return pendingTorrent;

  const torrentPromise = (async () => {
    const existingTorrent = await getExistingTorrent(uri);
    if (existingTorrent) return existingTorrent;

    return await new Promise<Torrent | undefined>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let addedTorrent: Torrent | undefined;

      const settle = (value: Torrent | undefined) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        addedTorrent?.removeListener("error", onError);
        resolve(value);
      };

      const onError = (error: unknown) => {
        if (settled) return;

        const message = getErrorMessage(error);
        if (message.startsWith("Cannot add duplicate torrent")) {
          void getExistingTorrent(uri).then((torrent) => {
            settle(torrent);
          });
          return;
        }

        console.error(`Failed to add torrent: ${message}`);
        captureException(error, {
          tags: {
            area: "webtorrent",
            operation: "add",
          },
          extra: {
            uri,
          },
        });
        settle(undefined);
        destroyTorrent(addedTorrent);
      };

      try {
        addedTorrent = streamClient.add(
          uri,
          {
            path: DOWNLOAD_DIR,
            destroyStoreOnDestroy: !KEEP_DOWNLOADED_FILES,
            // @ts-ignore
            deselect: true,
          },
          (torrent) => {
            settle(torrent);
          }
        );
      } catch (error) {
        console.error(`Failed to add torrent: ${getErrorMessage(error)}`);
        captureException(error, {
          tags: {
            area: "webtorrent",
            operation: "add",
          },
          extra: {
            uri,
          },
        });
        settle(undefined);
        return;
      }

      addedTorrent.once("error", onError);

      timeout = setTimeout(() => {
        settle(undefined);
        destroyTorrent(addedTorrent);
      }, TORRENT_TIMEOUT);

      if (settled) clearTimeout(timeout);
    });
  })();

  pendingTorrents.set(uri, torrentPromise);

  try {
    return await torrentPromise;
  } finally {
    if (pendingTorrents.get(uri) === torrentPromise) {
      pendingTorrents.delete(uri);
    }
  }
};

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
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let torrent: Torrent | undefined;

    const settle = (value: TorrentInfo | undefined) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      torrent?.removeListener("error", onError);
      resolve(value);
    };

    const onError = (error: unknown) => {
      console.error(`Failed to fetch torrent info: ${getErrorMessage(error)}`);
      captureException(error, {
        tags: {
          area: "webtorrent",
          operation: "info",
        },
        extra: {
          uri,
        },
      });
      settle(undefined);
      destroyTorrent(torrent);
    };

    try {
      torrent = infoClient.add(
        uri,
        { store: MemoryStore, destroyStoreOnDestroy: true },
        (nextTorrent) => {
          torrent = nextTorrent;

          try {
            const info = getInfo(nextTorrent);
            console.log(`Fetched info: ${info.name}`);
            settle(info);
          } catch (error) {
            console.error(
              `Failed to read torrent info: ${getErrorMessage(error)}`
            );
            captureException(error, {
              tags: {
                area: "webtorrent",
                operation: "read-info",
              },
              extra: {
                uri,
              },
            });
            settle(undefined);
          }

          destroyTorrent(nextTorrent);
        }
      );
    } catch (error) {
      console.error(`Failed to fetch torrent info: ${getErrorMessage(error)}`);
      captureException(error, {
        tags: {
          area: "webtorrent",
          operation: "info",
        },
        extra: {
          uri,
        },
      });
      settle(undefined);
      return;
    }

    torrent.once("error", onError);

    timeout = setTimeout(() => {
      settle(undefined);
      destroyTorrent(torrent);
    }, TORRENT_TIMEOUT);

    if (settled) clearTimeout(timeout);
  });
};

const timeouts = new Map<string, NodeJS.Timeout>();
const openStreams = new Map<string, number>();

const scheduleTorrentRemoval = (hash: string, fileName: string) => {
  if ((openStreams.get(hash) || 0) > 0 || timeouts.has(hash)) return;

  const timeout = setTimeout(() => {
    timeouts.delete(hash);

    void getExistingTorrent(hash).then((torrent) => {
      if (!torrent || (openStreams.get(hash) || 0) > 0) return;

      try {
        torrent.destroy(undefined, () => {
          console.log(`Removed torrent: ${torrent.name}`);
        });
      } catch (error) {
        console.error(`Error destroying torrent: ${getErrorMessage(error)}`);
        captureException(error, {
          tags: {
            area: "webtorrent",
            operation: "seed-destroy",
          },
          extra: {
            hash,
            fileName,
          },
        });
        destroyTorrent(torrent);
      }
    });
  }, SEED_TIME);

  timeouts.set(hash, timeout);
};

// Called when a request obtains a torrent but fails before opening a stream.
export const streamRequestAborted = (hash: string, fileName: string) => {
  if ((openStreams.get(hash) || 0) > 0) return;

  const timeout = timeouts.get(hash);
  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(hash);
  }

  void getExistingTorrent(hash).then((torrent) => {
    if (!torrent || (openStreams.get(hash) || 0) > 0) return;

    try {
      torrent.destroy(undefined, () => {
        console.log(`Removed unused torrent after failed stream request: ${fileName}`);
      });
    } catch (error) {
      console.error(`Error removing unused torrent: ${getErrorMessage(error)}`);
      captureException(error, {
        tags: {
          area: "webtorrent",
          operation: "aborted-stream-cleanup",
        },
        extra: { hash, fileName },
      });
      destroyTorrent(torrent);
    }
  });
};

const trackFileProgress = (torrent: Torrent, file: Torrent["files"][number]) => {
  const key = `${torrent.infoHash}:${file.path}`;
  if (fileProgressTrackers.has(key)) return;

  const tracker: FileProgressTracker = {
    torrent,
    file,
    nextThreshold: 10,
    completed: false,
    onDownload: () => {},
    onDone: () => {},
  };

  tracker.onDownload = () => {
    const progress = Math.floor(file.progress * 100);
    while (progress >= tracker.nextThreshold && tracker.nextThreshold < 100) {
      const remainingBytes = Math.max(0, file.length - file.downloaded);
      const eta =
        torrent.downloadSpeed > 0
          ? getReadableDuration((remainingBytes / torrent.downloadSpeed) * 1000)
          : "unavailable (download speed is currently zero)";

      console.log(
        `File download progress: ${file.name} reached ${tracker.nextThreshold}% ` +
          `(currently ${progress}%, ${getReadableSize(file.downloaded)} / ` +
          `${getReadableSize(file.length)}); ETA ${eta}`
      );
      tracker.nextThreshold += 10;
    }
  };

  tracker.onDone = () => {
    if (tracker.completed) return;
    tracker.completed = true;
    torrent.removeListener("download", tracker.onDownload);
    file.removeListener("done", tracker.onDone);
    console.log(
      `File download complete: ${file.name} reached 100% (${getReadableSize(file.length)})`
    );
  };

  fileProgressTrackers.set(key, tracker);
  torrent.on("download", tracker.onDownload);
  file.once("done", tracker.onDone);

  // The file may already be complete when a later stream opens it.
  if (file.progress >= 1) tracker.onDone();
};

export const streamOpened = (
  torrent: Torrent,
  file: Torrent["files"][number]
) => {
  const hash = torrent.infoHash;
  console.log(`Stream opened: ${file.name}`);

  const count = openStreams.get(hash) || 0;
  openStreams.set(hash, count + 1);
  seedStartedAt.delete(hash);
  trackFileProgress(torrent, file);

  const timeout = timeouts.get(hash);

  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(hash);
  }
};

export const streamClosed = (torrent: Torrent, fileName: string) => {
  const hash = torrent.infoHash;
  console.log(`Stream closed: ${fileName}`);

  const count = openStreams.get(hash) || 1;
  openStreams.set(hash, count - 1);

  if (count > 1) return;

  openStreams.delete(hash);
  seedStartedAt.set(hash, {
    since: Date.now(),
    uploadedAtStart: torrent.uploaded,
  });
  console.log(`Seeding retention started: ${torrent.name || hash}`);
  scheduleTorrentRemoval(hash, fileName);
};
