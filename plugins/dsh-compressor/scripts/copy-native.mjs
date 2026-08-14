import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const destDir = join(dirname(fileURLToPath(import.meta.url)), "..", "native");
mkdirSync(destDir, { recursive: true });

const triples = [
  {
    file: "dsh-compressor.darwin-arm64.node",
    candidates: [
      join(root, "target", "release", "libdsh_compressor_native.dylib"),
    ],
  },
  {
    file: "dsh-compressor.darwin-x64.node",
    candidates: [
      join(root, "target", "release", "libdsh_compressor_native.dylib"),
    ],
  },
  {
    file: "dsh-compressor.linux-x64-gnu.node",
    candidates: [
      join(
        root,
        "target",
        "x86_64-unknown-linux-gnu",
        "release",
        "libdsh_compressor_native.so",
      ),
      join(root, "target", "release", "libdsh_compressor_native.so"),
    ],
  },
  {
    file: "dsh-compressor.linux-arm64-gnu.node",
    candidates: [
      join(root, "target", "release", "libdsh_compressor_native.so"),
    ],
  },
  {
    file: "dsh-compressor.win32-x64.node",
    candidates: [
      join(root, "target", "release", "dsh_compressor_native.dll"),
    ],
  },
];

const platform = process.platform;
const arch = process.arch;
const wanted =
  platform === "darwin" && arch === "arm64"
    ? "dsh-compressor.darwin-arm64.node"
    : platform === "darwin" && arch === "x64"
      ? "dsh-compressor.darwin-x64.node"
      : platform === "linux" && arch === "x64"
        ? "dsh-compressor.linux-x64-gnu.node"
        : platform === "linux" && arch === "arm64"
          ? "dsh-compressor.linux-arm64-gnu.node"
          : platform === "win32" && arch === "x64"
            ? "dsh-compressor.win32-x64.node"
            : undefined;

if (wanted === undefined) {
  throw new Error(`unsupported host ${platform}-${arch}`);
}

const spec = triples.find((item) => item.file === wanted);
const source = spec?.candidates.find((candidate) => existsSync(candidate));
if (source === undefined) {
  throw new Error(`native library not found for ${wanted}`);
}

const dest = join(destDir, wanted);
copyFileSync(source, dest);
console.log(`copied ${source} -> ${dest}`);
