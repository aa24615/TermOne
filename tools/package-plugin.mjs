import { readFile, readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import {
  validateManifest,
  safePath,
} from "../apps/desktop/src/plugin/permissions.ts";
const dir = resolve(process.argv[2] ?? "examples/hello-plugin");
const manifest = validateManifest(
  JSON.parse(await readFile(join(dir, "termone.plugin.json"), "utf8")),
);
const files = {};
let size = 0;
async function walk(path) {
  for (const entry of await readdir(path)) {
    const file = join(path, entry);
    const name = relative(dir, file).replaceAll("\\", "/");
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !safePath(name))
      throw new Error("Unsafe path: " + name);
    if (stat.isDirectory()) await walk(file);
    else {
      size += stat.size;
      if (size > 16 * 1024 * 1024 || Object.keys(files).length >= 256)
        throw new Error("Plugin exceeds limits");
      files[name] = new Uint8Array(await readFile(file));
    }
  }
}
await walk(dir);
for (const file of [...manifest.files, manifest.entry])
  if (!Object.hasOwn(files, file)) throw new Error("Missing file: " + file);
const bytes = zipSync(files, { level: 6 });
if (bytes.length > 4 * 1024 * 1024) throw new Error("Archive exceeds 4 MiB");
const output = resolve(
  process.argv[3] ??
    "target/plugins/" + manifest.id + "-" + manifest.version + ".tpk",
);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, bytes);
console.log(
  JSON.stringify(
    {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      path: output,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    null,
    2,
  ),
);
