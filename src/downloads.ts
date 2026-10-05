/**
 * Saves the attachments of a Discord message to local files. Downloads are opt-in: a file is
 * only written inside a directory the operator listed in DISCORD_DOWNLOAD_DIRS, and every
 * download is refused while that variable is unset, so a tool call cannot write anywhere it
 * likes on the machine that runs the server.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

/** The largest attachment saved. Discord's own limits are per author (Nitro uploads go higher). */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** The hosts Discord serves attachments from: nothing else is contacted. */
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** Numbered copies tried (`name.1`, `name.2`…) before giving up. */
const MAX_COPIES = 1000;

export interface AttachmentToSave {
  id: string;
  name: string;
  size: number;
  url: string;
}

export interface SavedFile {
  attachment_id: string;
  filename: string;
  path: string;
  size: number;
  status: "saved" | "skipped";
}

export interface DownloadRequest {
  attachments: AttachmentToSave[];
  /** Folder to save into, the file names kept. */
  outputDir?: string | undefined;
  /** Full path of the file, for a single attachment. */
  outputFile?: string | undefined;
  /** Skip a file that already exists instead of saving a numbered copy. */
  noClobber: boolean;
}

/** What the download needs from outside, so that tests can stand in for each part. */
export interface DownloadEnvironment {
  /** Where a relative path starts. */
  cwd: string;
  /** What a leading `~` stands for. */
  home: string;
  /** The allowed directories, instead of DISCORD_DOWNLOAD_DIRS. */
  dirs?: string[];
  fetchFile?: typeof fetch;
}

/** A name that stays in its folder: no directories, no control characters, never empty. */
export function safeFileName(name: string): string {
  const base = path.posix.basename(name.replaceAll("\\", "/"));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..")
    throw new Error(`The attachment's file name ${JSON.stringify(name)} cannot be used.`);
  return cleaned;
}

function attachmentUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !ATTACHMENT_HOSTS.has(url.hostname))
    throw new Error(`Refusing to download from ${url.hostname}: not a Discord attachment host.`);
  return url;
}

// ─── where files may go ──────────────────────────────────────────────────────

/** Reads DISCORD_DOWNLOAD_DIRS lazily so module import order cannot freeze an empty list. */
function downloadDirs(): string[] {
  return (process.env.DISCORD_DOWNLOAD_DIRS ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
}

/** An absolute, normalized path: `~` is the home directory, a relative path starts at the cwd. */
export function resolvePath(raw: string, env: Pick<DownloadEnvironment, "cwd" | "home">): string {
  const expanded =
    raw === "~" ? env.home : raw.startsWith("~/") ? path.join(env.home, raw.slice(2)) : raw;
  return path.resolve(env.cwd, expanded);
}

/** Where a path leads once symlinks are followed, though the file need not exist yet. */
export async function realPath(target: string): Promise<string> {
  const rest: string[] = [];
  for (let current = target; ; current = path.dirname(current)) {
    try {
      return path.join(await fs.realpath(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === path.dirname(current))
        throw error;
      rest.push(path.basename(current));
    }
  }
}

/** True when `file` lies strictly inside `dir`; both must already be real paths. */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Throws unless a path, symlinks followed, lies inside one of the allowed directories. */
type Permit = (target: string) => Promise<void>;

/**
 * Checks every target against DISCORD_DOWNLOAD_DIRS, and returns the check for a path decided
 * later, such as a numbered copy. Paths are resolved through symlinks first, so a link inside an
 * allowed directory cannot lead out of it.
 * @throws {Error} If downloads are disabled, a listed directory is not absolute, or a target is
 * outside every listed directory.
 */
async function authorize(targets: string[], env: DownloadEnvironment): Promise<Permit> {
  const dirs = env.dirs ?? downloadDirs();
  if (dirs.length === 0)
    throw new Error(
      `File downloads are disabled: set DISCORD_DOWNLOAD_DIRS to a ${path.delimiter}-separated list of absolute directories the server may save files in.`,
    );
  for (const dir of dirs)
    if (!path.isAbsolute(dir))
      throw new Error(`DISCORD_DOWNLOAD_DIRS must list absolute directories, not "${dir}".`);
  const allowed = await Promise.all(dirs.map((dir) => realPath(path.resolve(dir))));
  const permit: Permit = async (target) => {
    const real = await realPath(target);
    if (!allowed.some((dir) => isInside(dir, real)))
      throw new Error(
        `Not allowed to write ${target}: it is outside the directories allowed by DISCORD_DOWNLOAD_DIRS.`,
      );
  };
  for (const target of targets) await permit(target);
  return permit;
}

// ─── writing ─────────────────────────────────────────────────────────────────

/**
 * Creates the file under `target`, or `target.1`, `target.2`… when it exists, like wget. With
 * `noClobber` an existing file is left alone and nothing is created. The creation is exclusive,
 * so two downloads never end up in the same file.
 */
async function createFile(
  target: string,
  noClobber: boolean,
  permit: Permit,
): Promise<{ handle: fs.FileHandle; path: string } | { skipped: string }> {
  for (let copy = 0; copy <= MAX_COPIES; copy++) {
    const candidate = copy === 0 ? target : `${target}.${copy}`;
    if (copy > 0) await permit(candidate);
    try {
      return { handle: await fs.open(candidate, "wx", 0o644), path: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (noClobber) return { skipped: target };
    }
  }
  throw new Error(`Too many copies of ${target} already exist.`);
}

/** Passes the bytes through, and fails the pipeline once there are more than allowed. */
export function limitBytes(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit)
        callback(new Error(`The attachment is larger than ${limit / 1024 / 1024} MiB.`));
      else callback(null, chunk);
    },
  });
}

async function save(
  attachment: AttachmentToSave,
  target: string,
  noClobber: boolean,
  permit: Permit,
  fetchFile: typeof fetch,
): Promise<SavedFile> {
  const created = await createFile(target, noClobber, permit);
  if ("skipped" in created)
    return {
      attachment_id: attachment.id,
      filename: attachment.name,
      path: created.skipped,
      size: (await fs.stat(created.skipped)).size,
      status: "skipped",
    };
  try {
    const response = await fetchFile(attachmentUrl(attachment.url), {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body)
      throw new Error(`Discord's CDN answered ${response.status} for ${attachment.name}.`);
    attachmentUrl(response.url || attachment.url);
    const announced = Number(response.headers.get("content-length"));
    if (announced > MAX_DOWNLOAD_BYTES)
      throw new Error(`${attachment.name} is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB.`);
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      limitBytes(MAX_DOWNLOAD_BYTES),
      created.handle.createWriteStream(),
    );
    return {
      attachment_id: attachment.id,
      filename: attachment.name,
      path: created.path,
      size: (await fs.stat(created.path)).size,
      status: "saved",
    };
  } catch (error) {
    await created.handle.close().catch(() => undefined);
    await fs.rm(created.path, { force: true });
    throw error;
  }
}

/** Saves the attachments as the request says, and says where each went. */
export async function downloadAttachments(
  request: DownloadRequest,
  env: DownloadEnvironment = { cwd: process.cwd(), home: os.homedir() },
): Promise<SavedFile[]> {
  const { attachments, outputDir, outputFile, noClobber } = request;
  if ((outputDir === undefined) === (outputFile === undefined))
    throw new Error("Pass exactly one of output_dir and output_file.");
  if (outputFile !== undefined && attachments.length !== 1)
    throw new Error(
      `output_file names one file, but the message has ${attachments.length} attachments: pass attachment_id, or use output_dir.`,
    );
  for (const attachment of attachments) {
    attachmentUrl(attachment.url);
    if (attachment.size > MAX_DOWNLOAD_BYTES)
      throw new Error(
        `${attachment.name} is ${(attachment.size / 1024 / 1024).toFixed(1)} MiB: only files up to ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB are downloaded.`,
      );
  }

  const directory = outputDir === undefined ? undefined : resolvePath(outputDir, env);
  const targets = attachments.map((attachment) =>
    outputFile !== undefined
      ? resolvePath(outputFile, env)
      : path.join(directory!, safeFileName(attachment.name)),
  );
  const permit = await authorize(targets, env);

  const saved: SavedFile[] = [];
  for (const [index, attachment] of attachments.entries()) {
    await fs.mkdir(path.dirname(targets[index]), { recursive: true });
    saved.push(await save(attachment, targets[index], noClobber, permit, env.fetchFile ?? fetch));
  }
  return saved;
}
