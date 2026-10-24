import { NextFunction, Request, Response, Router } from "express";
import { searchTorrents } from "./torrent/search.js";
import {
  getFile,
  getOrAddTorrent,
  getStats,
  getTorrentInfo,
  streamClosed,
  streamOpened,
  streamRequestAborted,
} from "./torrent/webtorrent.js";
import { getStreamingMimeType } from "./utils/file.js";
import { captureException } from "./utils/sentry.js";

export const router = Router();

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

const asyncRoute = (handler: AsyncRouteHandler) =>
  (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };

router.get("/stats", (req, res) => {
  const stats = getStats();
  res.json(stats);
});

router.get("/torrents/:query", asyncRoute(async (req, res) => {
  const { query } = req.params;
  const torrents = await searchTorrents(query);
  res.json(torrents);
}));

router.post("/torrents/:query", asyncRoute(async (req, res) => {
  const { query } = req.params;
  const options = req.body;
  const torrents = await searchTorrents(query, options);
  res.json(torrents);
}));

router.get("/torrent/:torrentUri", asyncRoute(async (req, res) => {
  const { torrentUri } = req.params;

  const torrent = await getTorrentInfo(torrentUri);
  if (!torrent) return res.status(500).send("Failed to get torrent");

  torrent.files.forEach((file) => {
    file.url = [
      `${req.protocol}://${req.get("host")}`,
      "stream",
      encodeURIComponent(torrentUri),
      encodeURIComponent(file.path),
    ].join("/");
  });

  res.json(torrent);
}));

router.get("/stream/:torrentUri/:filePath", asyncRoute(async (req, res) => {
  const { torrentUri, filePath } = req.params;

  const torrent = await getOrAddTorrent(torrentUri);
  if (!torrent) return res.status(500).send("Failed to add torrent");

  const file = getFile(torrent, filePath);
  if (!file) {
    streamRequestAborted(torrent.infoHash, filePath);
    return res.status(404).send("File not found");
  }

  const { range } = req.headers;
  const positions = (range || "").replace(/bytes=/, "").split("-");
  const start = positions[0] ? Number(positions[0]) : 0;
  const end = positions[1] ? Number(positions[1]) : file.length - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    streamRequestAborted(torrent.infoHash, file.name);
    return res.status(416).end();
  }

  if (start >= file.length || end >= file.length) {
    streamRequestAborted(torrent.infoHash, file.name);
    res.writeHead(416, {
      "Content-Range": `bytes */${file.length}`,
    });
    return res.end();
  }

  const videoStream = file.createReadStream({ start, end }) as NodeJS.ReadableStream & {
    destroy?: () => void;
  };

  const headers = {
    "Content-Range": `bytes ${start}-${end}/${file.length}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": getStreamingMimeType(file.name),
  };

  let streamOpenedOnce = false;
  let streamClosedOnce = false;
  let streamFailed = false;
  let noDataTimeout: NodeJS.Timeout | undefined;
  let noReadTimeout: NodeJS.Timeout | undefined;

  const cleanupTimeouts = () => {
    if (noDataTimeout) clearTimeout(noDataTimeout);
    if (noReadTimeout) clearTimeout(noReadTimeout);
  };

  const closeStream = () => {
    if (streamClosedOnce) return;
    streamClosedOnce = true;
    cleanupTimeouts();
    videoStream.destroy?.();

    if (streamOpenedOnce) {
      streamClosed(torrent, file.name);
    }
  };

  const failStream = () => {
    if (streamFailed) return;
    streamFailed = true;
    cleanupTimeouts();
    videoStream.destroy?.();

    if (!res.headersSent) {
      return res.status(500).end();
    }

    res.destroy();
  };

  const refreshReadTimeout = () => {
    if (noDataTimeout) {
      clearTimeout(noDataTimeout);
      noDataTimeout = undefined;
    }

    noReadTimeout?.refresh();
  };

  noDataTimeout = setTimeout(() => {
    failStream();
  }, 10000);

  noReadTimeout = setTimeout(() => {
    failStream();
  }, 60000);

  videoStream.on("data", refreshReadTimeout);
  videoStream.on("readable", refreshReadTimeout);
  videoStream.once("error", (error) => {
    captureException(error, {
      tags: {
        area: "stream",
        operation: "read",
      },
      extra: {
        torrentUri,
        filePath,
        start,
        end,
      },
    });
    failStream();
  });

  res.once("close", closeStream);
  res.once("finish", closeStream);

  streamOpened(torrent, file);
  streamOpenedOnce = true;

  res.writeHead(206, headers);
  videoStream.pipe(res);
}));
