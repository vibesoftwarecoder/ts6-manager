import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export interface YouTubeInfo {
  id: string;
  title: string;
  artist: string;
  duration: number; // seconds
  thumbnail: string;
  url: string;
}

export interface YouTubeSearchResult {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
}

// Shared cookie file path (set from settings)
let ytCookieFile: string | null = null;

export function setYtCookieFile(filePath: string | null): void {
  ytCookieFile = filePath;
}

export function getYtCookieFile(): string | null {
  return ytCookieFile;
}

export function getCookieArgs(): string[] {
  const args: string[] = ["--remote-components", "ejs:github"];
  if (ytCookieFile) {
    args.push("--cookies", ytCookieFile);
  }
  return args;
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "youtu.be"
      || hostname === "youtube.com"
      || hostname.endsWith(".youtube.com")
      || hostname === "youtube-nocookie.com"
      || hostname.endsWith(".youtube-nocookie.com");
  } catch {
    return false;
  }
}

function parseYouTubeInfo(raw: string, url: string): YouTubeInfo {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse yt-dlp output");
  }

  return {
    id: parsed.id,
    title: parsed.title || "Unknown",
    artist: parsed.uploader || parsed.channel || "Unknown",
    duration: parsed.duration || 0,
    thumbnail: parsed.thumbnail || "",
    url,
  };
}

/**
 * Read metadata for a single YouTube video without downloading its media.
 */
export function getYouTubeInfo(url: string): Promise<YouTubeInfo> {
  if (!isYouTubeUrl(url)) {
    return Promise.reject(new Error("Please provide a valid YouTube URL"));
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      ...getCookieArgs(),
      "--dump-json",
      "--no-playlist",
      "--no-download",
      url,
    ], { shell: false });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp info failed (code ${code}): ${stderr.slice(0, 200)}`));
      }

      try {
        resolve(parseYouTubeInfo(stdout, url));
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

/**
 * Resolve a fresh, temporary audio URL for immediate playback. No media is
 * written to disk. The result should not be persisted because YouTube stream
 * URLs expire.
 */
export function getYouTubeAudioStreamUrl(url: string): Promise<string> {
  if (!isYouTubeUrl(url)) {
    return Promise.reject(new Error("Please provide a valid YouTube URL"));
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      ...getCookieArgs(),
      "--no-playlist",
      "--no-warnings",
      "-f", "bestaudio/best",
      "-g",
      url,
    ], { shell: false });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp stream resolution failed (code ${code}): ${stderr.slice(0, 200)}`));
      }

      const streamUrl = stdout.trim().split(/\r?\n/).find(Boolean);
      if (!streamUrl) {
        return reject(new Error("yt-dlp returned no playable audio stream"));
      }
      resolve(streamUrl);
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

/**
 * Download audio from a YouTube URL using yt-dlp
 */
export async function downloadYouTube(url: string, outputDir: string): Promise<{ filePath: string; info: YouTubeInfo }> {
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");
  const info = await getYouTubeInfo(url);
  const expectedPath = path.join(outputDir, `${info.id}.opus`);

  // Check if already downloaded
  if (fs.existsSync(expectedPath)) {
    return { filePath: expectedPath, info };
  }

  return new Promise((resolve, reject) => {
    // Download audio only (used only by the explicit Library download action)
    const dlProc = spawn("yt-dlp", [
      ...getCookieArgs(),
      "-x",                       // extract audio
      "--audio-format", "opus",   // opus format (native for TS3)
      "--audio-quality", "0",     // best quality
      "--no-playlist",
      "-o", outputTemplate,
      url,
    ], { shell: false });

    let dlErr = "";
    dlProc.stderr.on("data", (chunk: Buffer) => {
      dlErr += chunk.toString();
    });

    dlProc.on("close", (dlCode) => {
      if (dlCode !== 0) {
        return reject(new Error(`yt-dlp download failed (code ${dlCode}): ${dlErr.slice(0, 200)}`));
      }

      // yt-dlp may use different extensions, find the actual file
      const files = fs.readdirSync(outputDir).filter((f) => f.startsWith(info.id));
      if (files.length === 0) {
        return reject(new Error("Downloaded file not found"));
      }

      const filePath = path.join(outputDir, files[files.length - 1]);
      resolve({ filePath, info });
    });

    dlProc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

/**
 * Get info about a YouTube URL (single video or playlist).
 * Returns type ('video' or 'playlist') and array of items.
 */
export function getYouTubeUrlInfo(url: string): Promise<{ type: 'video' | 'playlist'; items: YouTubeSearchResult[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
        ...getCookieArgs(),
        "--dump-json",
      "--flat-playlist",
      "--no-download",
      url,
    ], { shell: false });

    let output = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp info failed (code ${code}): ${stderr.slice(0, 200)}`));
      }

      try {
        const lines = output.trim().split("\n").filter(Boolean);
        const items: YouTubeSearchResult[] = lines.map((line) => {
          const parsed = JSON.parse(line);
          return {
            id: parsed.id,
            title: parsed.title || "Unknown",
            artist: parsed.uploader || parsed.channel || "Unknown",
            duration: parsed.duration || 0,
            thumbnail: parsed.thumbnails?.[0]?.url || parsed.thumbnail || "",
          };
        });

        const type = items.length > 1 ? 'playlist' : 'video';
        resolve({ type, items });
      } catch {
        reject(new Error("Failed to parse yt-dlp output"));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}

/**
 * Search YouTube using yt-dlp
 */
export function searchYouTube(query: string, maxResults: number = 10): Promise<YouTubeSearchResult[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [
        ...getCookieArgs(),
        `ytsearch${maxResults}:${query}`,
      "--dump-json",
      "--flat-playlist",
      "--no-download",
    ], { shell: false });

    let output = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp search failed (code ${code}): ${stderr.slice(0, 200)}`));
      }

      try {
        // yt-dlp outputs one JSON object per line
        const results = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const parsed = JSON.parse(line);
            return {
              id: parsed.id,
              title: parsed.title || "Unknown",
              artist: parsed.uploader || parsed.channel || "Unknown",
              duration: parsed.duration || 0,
              thumbnail: parsed.thumbnails?.[0]?.url || "",
            };
          });

        resolve(results);
      } catch {
        resolve([]);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp not found: ${err.message}`));
    });
  });
}
