import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { connection } from "next/server";
import TaskFlowWorkbench from "@/components/task-flow-workbench";
import { parseFlowYaml, type FlowFileEntry } from "@/lib/task-flow";

const DATA_DIRECTORY = path.join(process.cwd(), "src/data");

async function collectYamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectYamlFiles(entryPath);
      }

      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        return [entryPath];
      }

      return [];
    }),
  );

  return nestedFiles.flat();
}

async function loadFlowFiles(): Promise<FlowFileEntry[]> {
  let yamlFiles: string[] = [];

  try {
    yamlFiles = await collectYamlFiles(DATA_DIRECTORY);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  yamlFiles.sort((left, right) => left.localeCompare(right));

  return Promise.all(
    yamlFiles.map(async (filePath) => {
      const relativePath = path.relative(DATA_DIRECTORY, filePath).split(path.sep).join("/");
      const source = await readFile(filePath, "utf8");
      const flowRevision = createHash("sha1")
        .update(relativePath)
        .update(source)
        .digest("hex");
      const parsed = parseFlowYaml(source);

      if (!parsed.ok) {
        return {
          key: `src/data/${relativePath}`,
          fileName: relativePath,
          filePath: `src/data/${relativePath}`,
          flowRevision,
          issues: parsed.issues,
        };
      }

      return {
        key: `src/data/${relativePath}`,
        fileName: relativePath,
        filePath: `src/data/${relativePath}`,
        flowRevision,
        flow: parsed.flow,
      };
    }),
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    file?: string | string[];
  }>;
}) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const resolvedSearchParams = await searchParams;
  const initialFilePath = Array.isArray(resolvedSearchParams.file)
    ? resolvedSearchParams.file[0]
    : resolvedSearchParams.file;

  if (isDevelopment) {
    await connection();
  }

  const files = await loadFlowFiles();

  return (
    <TaskFlowWorkbench
      files={files}
      initialFilePath={initialFilePath}
      shouldHydrateRuntime={!isDevelopment}
    />
  );
}
