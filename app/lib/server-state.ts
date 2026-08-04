import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  PersistedAppSettings,
  PersistedDataset,
  PersistedServerState,
} from "./persisted-state";

const MAX_DATASET_BYTES = 25 * 1024 * 1024;
let writeQueue: Promise<void> = Promise.resolve();

function dataDirectory(): string {
  return path.resolve(process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data"));
}

function settingsPath(): string {
  return path.join(dataDirectory(), "settings.json");
}

function datasetPath(): string {
  return path.join(dataDirectory(), "dataset.json");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function queueWrite(operation: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

export async function readServerState(): Promise<PersistedServerState> {
  const [settingsRecord, datasetRecord] = await Promise.all([
    readJson<{ value: PersistedAppSettings; updatedAt: string }>(settingsPath()),
    readJson<{ value: PersistedDataset; updatedAt: string }>(datasetPath()),
  ]);
  const timestamps = [settingsRecord?.updatedAt, datasetRecord?.updatedAt].filter((value): value is string => Boolean(value)).sort();
  return {
    settings: settingsRecord?.value ?? null,
    dataset: datasetRecord?.value ?? null,
    updatedAt: timestamps.at(-1) ?? null,
  };
}

export function saveSettings(settings: PersistedAppSettings): Promise<void> {
  return queueWrite(() => atomicWrite(settingsPath(), { value: settings, updatedAt: new Date().toISOString() }));
}

export function saveDataset(dataset: PersistedDataset | null): Promise<void> {
  return queueWrite(async () => {
    if (dataset === null) {
      try {
        await unlink(datasetPath());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    if (Buffer.byteLength(dataset.rawText, "utf8") > MAX_DATASET_BYTES) throw new Error("The imported dataset exceeds the 25 MB server limit.");
    JSON.parse(dataset.rawText);
    await atomicWrite(datasetPath(), { value: dataset, updatedAt: new Date().toISOString() });
  });
}
