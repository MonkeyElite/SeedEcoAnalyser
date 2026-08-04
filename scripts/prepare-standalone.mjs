import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const clientDirectory = path.resolve("dist/client");
const standaloneClientDirectory = path.resolve("dist/standalone/dist/client");
const staticCachePath = path.resolve(
  "dist/standalone/node_modules/vinext/dist/server/static-file-cache.js",
);

if (!existsSync(clientDirectory) || !existsSync(standaloneClientDirectory) || !existsSync(staticCachePath)) {
  throw new Error(
    "Vinext standalone output is incomplete; expected client assets and the production server runtime.",
  );
}

// Vinext copies the client bundle into the standalone directory. Assert that
// deployment contract here so a framework upgrade cannot silently omit it.
if (
  !existsSync(path.join(standaloneClientDirectory, "assets")) ||
  !existsSync(path.join(standaloneClientDirectory, "data", "items.json"))
) {
  throw new Error("Standalone output is missing generated assets or the bundled dataset.");
}

// Vinext 0.0.50 stores path.relative() results directly as URL cache keys.
// Windows returns backslashes, so /assets and /data otherwise resolve to 404.
// Normalizing to POSIX separators is a no-op in the Linux Docker image.
const staticCacheSource = readFileSync(staticCachePath, "utf8");
const originalExpression = "relativePath: path.relative(base, batch[j]),";
const normalizedExpression =
  'relativePath: path.relative(base, batch[j]).split(path.sep).join("/"),';

if (staticCacheSource.includes(originalExpression)) {
  writeFileSync(
    staticCachePath,
    staticCacheSource.replace(originalExpression, normalizedExpression),
    "utf8",
  );
} else if (!staticCacheSource.includes(normalizedExpression)) {
  throw new Error("Vinext static cache implementation changed; URL path normalization was not applied.");
}
