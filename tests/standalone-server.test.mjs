import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Standalone server exited early.\n${logs()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The listener may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Standalone server did not become ready.\n${logs()}`);
}

test("standalone server serves the app, assets, bundled data, and save API", async () => {
  const port = await reservePort();
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "seed-eco-standalone-"));
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["dist/standalone/server.js"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDirectory,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const logs = () => `${stdout}\n${stderr}`.trim();

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const pageResponse = await waitForServer(`${baseUrl}/`, child, logs);
    const html = await pageResponse.text();
    const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1];
    assert.ok(assetPath, "Rendered page should reference a generated asset");

    const [assetResponse, dataResponse, apiResponse] = await Promise.all([
      fetch(`${baseUrl}${assetPath}`),
      fetch(`${baseUrl}/data/items.json`),
      fetch(`${baseUrl}/api/pricing-saves`),
    ]);

    assert.equal(assetResponse.status, 200, logs());
    assert.equal(dataResponse.status, 200, logs());
    assert.equal(apiResponse.status, 200, logs());
    assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);
    assert.ok((await dataResponse.text()).length > 100);
    assert.deepEqual(await apiResponse.json(), { saves: [] });
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
