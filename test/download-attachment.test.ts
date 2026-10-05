import { test, mock, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { discord } from "../src/client.js";
import {
  MAX_DOWNLOAD_BYTES,
  downloadAttachments,
  limitBytes,
  realPath,
  resolvePath,
  safeFileName,
  type AttachmentToSave,
  type DownloadEnvironment,
} from "../src/downloads.js";
import { createServer } from "../src/server.js";

const CHANNEL = "333333333333333333";
const MESSAGE = "444444444444444444";
const CDN = "https://cdn.discordapp.com/attachments/1/2";

let root: string;
let cwd: string;
const savedEnv = process.env.DISCORD_DOWNLOAD_DIRS;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "download-")));
  cwd = path.join(root, "work");
  await fs.mkdir(cwd);
});

afterEach(async () => {
  mock.restoreAll();
  if (savedEnv === undefined) delete process.env.DISCORD_DOWNLOAD_DIRS;
  else process.env.DISCORD_DOWNLOAD_DIRS = savedEnv;
  await fs.rm(root, { recursive: true, force: true });
});

const attachment = (id: string, name: string, size = 5): AttachmentToSave => ({
  id,
  name,
  size,
  url: `${CDN}/${name}?ex=1`,
});

/** A CDN that answers each file with its own name as content. */
function stubFetch(contents: Record<string, string> = {}) {
  const requested: string[] = [];
  const fetchFile = (async (url: URL) => {
    requested.push(url.pathname);
    const name = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (contents[name] === "404") return new Response("nope", { status: 404 });
    return new Response(contents[name] ?? `content of ${name}`, { status: 200 });
  }) as unknown as typeof fetch;
  return { requested, fetchFile };
}

/** The whole temporary folder is allowed unless a test says otherwise. */
function environment(overrides: Partial<DownloadEnvironment> = {}): DownloadEnvironment {
  return {
    cwd,
    home: path.join(root, "home"),
    dirs: [root],
    fetchFile: stubFetch().fetchFile,
    ...overrides,
  };
}

const saveInto = (
  attachments: AttachmentToSave[],
  where: { outputDir?: string; outputFile?: string },
  options: { noClobber?: boolean; env?: DownloadEnvironment } = {},
) =>
  downloadAttachments(
    { attachments, ...where, noClobber: options.noClobber ?? false },
    options.env ?? environment(),
  );

// ─── where the files go ──────────────────────────────────────────────────────

test("output_dir saves each attachment under its own name, creating the folder", async () => {
  const dir = path.join(root, "out", "deeper");
  const files = await saveInto([attachment("1", "a.txt"), attachment("2", "b.png")], {
    outputDir: dir,
  });
  assert.deepEqual(
    files.map((f) => [f.attachment_id, f.filename, f.path, f.status]),
    [
      ["1", "a.txt", path.join(dir, "a.txt"), "saved"],
      ["2", "b.png", path.join(dir, "b.png"), "saved"],
    ],
  );
  assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "content of a.txt");
  assert.equal(files[0].size, "content of a.txt".length);
});

test("a relative output_dir starts at the working directory, and ~ is the home directory", async () => {
  const [file] = await saveInto([attachment("1", "a.txt")], { outputDir: "downloads" });
  assert.equal(file.path, path.join(cwd, "downloads", "a.txt"));
  const [home] = await saveInto([attachment("1", "b.txt")], { outputDir: "~/saved" });
  assert.equal(home.path, path.join(root, "home", "saved", "b.txt"));
});

test("output_file replaces the file name, and may be relative", async () => {
  const [file] = await saveInto([attachment("1", "a.txt")], { outputFile: "renamed.bin" });
  assert.equal(file.path, path.join(cwd, "renamed.bin"));
  assert.equal(file.filename, "a.txt", "the name on Discord is still reported");
});

test("a file that exists is kept and the new one gets .1, .2, like wget", async () => {
  const dir = path.join(root, "out");
  const paths = [];
  for (let i = 0; i < 3; i++)
    paths.push((await saveInto([attachment("1", "a.txt")], { outputDir: dir }))[0].path);
  assert.deepEqual(paths, [
    path.join(dir, "a.txt"),
    path.join(dir, "a.txt.1"),
    path.join(dir, "a.txt.2"),
  ]);
  const [copy] = await saveInto([attachment("1", "a.txt")], {
    outputFile: path.join(dir, "a.txt"),
  });
  assert.equal(copy.path, path.join(dir, "a.txt.3"), "output_file never overwrites either");
});

test("no_clobber skips an existing file without downloading it", async () => {
  const dir = path.join(root, "out");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "a.txt"), "mine");
  const { requested, fetchFile } = stubFetch();
  const files = await saveInto(
    [attachment("1", "a.txt"), attachment("2", "b.txt")],
    { outputDir: dir },
    { noClobber: true, env: environment({ fetchFile }) },
  );
  assert.deepEqual(
    files.map((f) => [f.filename, f.status]),
    [
      ["a.txt", "skipped"],
      ["b.txt", "saved"],
    ],
  );
  assert.equal(files[0].path, path.join(dir, "a.txt"));
  assert.equal(files[0].size, 4);
  assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "mine");
  assert.deepEqual(requested, ["/attachments/1/2/b.txt"], "the skipped file was not fetched");
  assert.deepEqual(await fs.readdir(dir), ["a.txt", "b.txt"], "and no numbered copy was made");
});

test("exactly one of output_dir and output_file, and output_file needs a single attachment", async () => {
  await assert.rejects(
    saveInto([attachment("1", "a.txt")], {}),
    /exactly one of output_dir and output_file/,
  );
  await assert.rejects(
    saveInto([attachment("1", "a.txt")], { outputDir: "x", outputFile: "y" }),
    /exactly one of output_dir and output_file/,
  );
  await assert.rejects(
    saveInto([attachment("1", "a.txt"), attachment("2", "b.txt")], { outputFile: "y" }),
    /2 attachments: pass attachment_id/,
  );
  assert.deepEqual(await fs.readdir(cwd), [], "nothing was written");
});

test("a file name cannot leave its folder", () => {
  assert.equal(safeFileName("a b.txt"), "a b.txt");
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("dir\\evil.exe"), "evil.exe");
  assert.equal(safeFileName("tab\there.txt"), "tabhere.txt");
  assert.throws(() => safeFileName(".."), /cannot be used/);
  assert.throws(() => safeFileName("  "), /cannot be used/);
});

test("paths: ~ is the home, a relative path starts at the cwd, symlinks are followed", async () => {
  const env = { cwd: "/work/project", home: "/home/me" };
  assert.equal(resolvePath("~/a/b.txt", env), "/home/me/a/b.txt");
  assert.equal(resolvePath("out/../a.txt", env), "/work/project/a.txt");
  assert.equal(resolvePath("/abs/a.txt", env), "/abs/a.txt");
  await fs.mkdir(path.join(root, "target"));
  await fs.symlink(path.join(root, "target"), path.join(root, "link"));
  assert.equal(
    await realPath(path.join(root, "link", "new", "file.txt")),
    path.join(root, "target", "new", "file.txt"),
    "the part that does not exist yet is kept",
  );
});

// ─── what is downloaded ──────────────────────────────────────────────────────

test("only Discord's attachment hosts are contacted", async () => {
  const { requested, fetchFile } = stubFetch();
  for (const url of [
    "http://cdn.discordapp.com/a/b.txt",
    "https://evil.example/a/b.txt",
    "https://cdn.discordapp.com.evil.example/a/b.txt",
  ])
    await assert.rejects(
      saveInto(
        [{ id: "1", name: "b.txt", size: 1, url }],
        { outputDir: root },
        { env: environment({ fetchFile }) },
      ),
      /not a Discord attachment host|Refusing/,
    );
  assert.deepEqual(requested, []);
});

test("a file over the size limit is refused before anything is written", async () => {
  await assert.rejects(
    saveInto([attachment("1", "ok.txt"), attachment("2", "big.iso", MAX_DOWNLOAD_BYTES + 1)], {
      outputDir: path.join(root, "out"),
    }),
    /big\.iso is \d+\.\d MiB: only files up to 100 MiB/,
  );
  assert.deepEqual(await fs.readdir(root), ["work"], "not even the folder was created");
});

test("the byte limit stops a stream that grows past it", async () => {
  await assert.rejects(
    pipeline(
      Readable.from([Buffer.alloc(6), Buffer.alloc(6)]),
      limitBytes(10),
      async function (source) {
        for await (const chunk of source) void chunk;
      },
    ),
    /larger than/,
  );
});

test("a failed download leaves no file behind", async () => {
  const dir = path.join(root, "out");
  const { fetchFile } = stubFetch({ "b.txt": "404" });
  await assert.rejects(
    saveInto(
      [attachment("1", "a.txt"), attachment("2", "b.txt")],
      { outputDir: dir },
      { env: environment({ fetchFile }) },
    ),
    /answered 404 for b\.txt/,
  );
  assert.deepEqual(await fs.readdir(dir), ["a.txt"], "the first was saved, the failed one removed");
});

// ─── DISCORD_DOWNLOAD_DIRS ───────────────────────────────────────────────────

test("downloads are disabled while DISCORD_DOWNLOAD_DIRS is unset", async () => {
  delete process.env.DISCORD_DOWNLOAD_DIRS;
  await assert.rejects(
    saveInto(
      [attachment("1", "a.txt")],
      { outputDir: root },
      { env: environment({ dirs: undefined }) },
    ),
    /downloads are disabled: set DISCORD_DOWNLOAD_DIRS to a .*-separated list of absolute directories/,
  );
  process.env.DISCORD_DOWNLOAD_DIRS = " ";
  await assert.rejects(
    saveInto(
      [attachment("1", "a.txt")],
      { outputDir: root },
      { env: environment({ dirs: undefined }) },
    ),
    /downloads are disabled/,
  );
  assert.deepEqual(await fs.readdir(root), ["work"], "nothing was written");
});

test("the variable lists directories separated like PATH, and each one allows writing", async () => {
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  process.env.DISCORD_DOWNLOAD_DIRS = ` ${first}${path.delimiter}${second}${path.delimiter}`;
  const env = environment({ dirs: undefined });
  for (const dir of [first, path.join(second, "deeper")]) {
    const [file] = await saveInto([attachment("1", "a.txt")], { outputDir: dir }, { env });
    assert.equal(file.path, path.join(dir, "a.txt"));
  }
  await assert.rejects(
    saveInto([attachment("1", "a.txt")], { outputDir: path.join(root, "third") }, { env }),
    /outside the directories allowed by DISCORD_DOWNLOAD_DIRS/,
  );
});

test("a comma is part of a path, not a separator", async () => {
  const dir = path.join(root, "a,b");
  process.env.DISCORD_DOWNLOAD_DIRS = dir;
  const [file] = await saveInto(
    [attachment("1", "a.txt")],
    { outputDir: dir },
    { env: environment({ dirs: undefined }) },
  );
  assert.equal(file.path, path.join(dir, "a.txt"));
});

test("a path outside the allowed directories is refused, folder and files alike", async () => {
  const allowed = path.join(root, "allowed");
  const env = environment({ dirs: [allowed] });
  for (const where of [
    { outputDir: path.join(root, "elsewhere") },
    { outputDir: allowed + "-sibling" },
    { outputFile: path.join(allowed, "..", "escaped.txt") },
    { outputDir: path.join(allowed, "..", "work") },
  ])
    await assert.rejects(
      saveInto([attachment("1", "a.txt")], where, { env }),
      /outside the directories allowed by DISCORD_DOWNLOAD_DIRS/,
      JSON.stringify(where),
    );
  assert.deepEqual(await fs.readdir(root), ["work"], "nothing was created");
});

test("the allowed directory itself is not a file name", async () => {
  await assert.rejects(
    saveInto(
      [attachment("1", "a.txt")],
      { outputFile: root },
      { env: environment({ dirs: [root] }) },
    ),
    /outside the directories/,
  );
});

test("a directory listed with a relative path is a mistake, and is reported", async () => {
  await assert.rejects(
    saveInto(
      [attachment("1", "a.txt")],
      { outputDir: root },
      { env: environment({ dirs: ["relative/dir"] }) },
    ),
    /must list absolute directories, not "relative\/dir"/,
  );
});

test("a symlink out of an allowed directory does not carry the permission with it", async () => {
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(allowed, "link"));
  await assert.rejects(
    saveInto(
      [attachment("1", "a.txt")],
      { outputDir: path.join(allowed, "link") },
      { env: environment({ dirs: [allowed] }) },
    ),
    /outside the directories allowed by DISCORD_DOWNLOAD_DIRS/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("an allowed directory that is itself a symlink is followed", async () => {
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  await fs.mkdir(real);
  await fs.symlink(real, link);
  const [file] = await saveInto(
    [attachment("1", "a.txt")],
    { outputDir: path.join(link, "sub") },
    { env: environment({ dirs: [link] }) },
  );
  assert.equal(await fs.readFile(file.path, "utf8"), "content of a.txt");
  assert.equal(await realPath(file.path), path.join(real, "sub", "a.txt"));
});

// ─── the tool, through MCP ───────────────────────────────────────────────────

function stubMessage(attachments: { id: string; name: string; size: number; url: string }[]) {
  mock.method(
    discord.channels,
    "fetch",
    async () =>
      ({
        name: "chan",
        guildId: "111111111111111111",
        isDMBased: () => false,
        isTextBased: () => true,
        messages: {
          fetch: async () => ({ attachments: new Map(attachments.map((a) => [a.id, a])) }),
        },
      }) as never,
  );
}

async function connect() {
  // The server connects to Discord on a tool call: make it believe it is.
  mock.method(discord, "isReady", () => true as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer("0.0.0-test");
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const call = (client: Client, args: Record<string, unknown>) =>
  client.callTool({
    name: "discord_download_attachment",
    arguments: { channel_id: CHANNEL, message_id: MESSAGE, ...args },
  });

const text = (result: Awaited<ReturnType<typeof call>>) =>
  (result.content as { text: string }[]).map((block) => block.text).join("\n");

test("the tool advertises its parameters, and the two outputs are exclusive", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "discord_download_attachment")!;
  const properties = Object.keys((tool.inputSchema as { properties: object }).properties);
  assert.deepEqual(properties, [
    "channel_id",
    "message_id",
    "attachment_id",
    "output_dir",
    "output_file",
    "no_clobber",
  ]);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.match(tool.description ?? "", /DISCORD_DOWNLOAD_DIRS/);
  for (const args of [{}, { output_dir: "a", output_file: "b" }]) {
    const result = await call(client, args);
    assert.equal(result.isError, true);
    assert.match(text(result), /exactly one of output_dir and output_file/);
  }
  await client.close();
});

test("the tool saves the chosen attachment inside an allowed directory, and says where", async () => {
  process.env.DISCORD_DOWNLOAD_DIRS = root;
  stubMessage([
    { id: "11111111111111111", name: "one.txt", size: 8, url: `${CDN}/one.txt` },
    { id: "22222222222222222", name: "two.txt", size: 8, url: `${CDN}/two.txt` },
  ]);
  mock.method(
    globalThis,
    "fetch",
    (async (url: URL) => new Response(`from ${url.pathname.split("/").at(-1)}`)) as never,
  );
  const client = await connect();
  const target = path.join(root, "chosen.txt");
  const result = await call(client, { attachment_id: "22222222222222222", output_file: target });
  assert.ok(!result.isError, text(result));
  assert.deepEqual(
    (
      result.structuredContent as { files: { filename: string; path: string; status: string }[] }
    ).files.map((f) => [f.filename, f.path, f.status]),
    [["two.txt", target, "saved"]],
  );
  assert.equal(await fs.readFile(target, "utf8"), "from two.txt");
  await client.close();
});

test("the tool refuses, naming the variable, while no directory is allowed", async () => {
  delete process.env.DISCORD_DOWNLOAD_DIRS;
  stubMessage([{ id: "11111111111111111", name: "one.txt", size: 8, url: `${CDN}/one.txt` }]);
  const client = await connect();
  const result = await call(client, { output_dir: path.join(root, "out") });
  assert.equal(result.isError, true);
  assert.match(text(result), /File downloads are disabled: set DISCORD_DOWNLOAD_DIRS/);
  await fs.access(path.join(root, "out")).then(
    () => assert.fail("the folder must not exist"),
    () => undefined,
  );
  await client.close();
});

test("the tool names the attachments when the one asked for is not there", async () => {
  process.env.DISCORD_DOWNLOAD_DIRS = root;
  stubMessage([{ id: "11111111111111111", name: "one.txt", size: 8, url: `${CDN}/one.txt` }]);
  const client = await connect();
  const result = await call(client, { attachment_id: "99999999999999999", output_dir: root });
  assert.equal(result.isError, true);
  assert.match(
    text(result),
    /no attachment 99999999999999999\. Its attachments: 11111111111111111/,
  );
  await client.close();
});
