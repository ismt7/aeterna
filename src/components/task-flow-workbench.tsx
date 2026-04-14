"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildGraphLayout,
  clearLegacyRuntimeState,
  clearRuntimeState,
  createInitialRuntimeState,
  formatElapsedMs,
  getEffectiveElapsedMs,
  getMissingDependencies,
  getReadyTasks,
  getRunningTaskId,
  getSubtaskProgress,
  getTaskDetailParts,
  getTaskCounts,
  getTaskPath,
  hydrateRuntimeState,
  isTaskBlocked,
  type FlowDefinition,
  type FlowFileEntry,
  type PositionedTask,
  type TaskCardPart,
  type TaskRuntimeEntry,
  type TaskRuntimeState,
  type TaskStatus,
  writeRuntimeState,
} from "@/lib/task-flow";

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
};

const TIMER_LABELS = {
  idle: "未計測",
  running: "計測中",
  paused: "一時停止中",
} as const;

const STATUS_OPTIONS: TaskStatus[] = ["todo", "doing", "done"];
const PERSISTENCE_NOTICE_STYLES = {
  info: "border-sky-200/80 bg-sky-50 text-sky-950",
  warning: "border-amber-200 bg-amber-50 text-stone-950",
} as const;

type ValidFlowFileEntry = FlowFileEntry & {
  flow: FlowDefinition;
};

type FileTreeNode =
  | {
      type: "directory";
      name: string;
      path: string;
      children: FileTreeNode[];
    }
  | {
      type: "file";
      name: string;
      path: string;
      entry: FlowFileEntry;
      valid: boolean;
    };

type DirectoryBuilder = {
  name: string;
  path: string;
  directories: Map<string, DirectoryBuilder>;
  files: Array<{
    name: string;
    path: string;
    entry: FlowFileEntry;
    valid: boolean;
  }>;
};

function hasFlow(entry: FlowFileEntry): entry is ValidFlowFileEntry {
  return entry.flow !== undefined;
}

function createDirectoryBuilder(name: string, path: string): DirectoryBuilder {
  return {
    name,
    path,
    directories: new Map(),
    files: [],
  };
}

function getAncestorDirectoryPaths(filePath: string): string[] {
  const segments = filePath.split("/").filter(Boolean);
  const directories = segments.slice(0, -1);
  const paths: string[] = [];

  for (let index = 0; index < directories.length; index += 1) {
    paths.push(directories.slice(0, index + 1).join("/"));
  }

  return paths;
}

function buildFileTree(files: FlowFileEntry[]): FileTreeNode[] {
  const root = createDirectoryBuilder("", "");

  for (const file of files) {
    const segments = file.fileName.split("/").filter(Boolean);

    if (segments.length === 0) {
      continue;
    }

    let current = root;

    for (const [index, segment] of segments.entries()) {
      const isFile = index === segments.length - 1;

      if (isFile) {
        current.files.push({
          name: segment,
          path: file.fileName,
          entry: file,
          valid: hasFlow(file),
        });
        continue;
      }

      const nextPath = current.path ? `${current.path}/${segment}` : segment;
      let nextDirectory = current.directories.get(segment);

      if (!nextDirectory) {
        nextDirectory = createDirectoryBuilder(segment, nextPath);
        current.directories.set(segment, nextDirectory);
      }

      current = nextDirectory;
    }
  }

  const materialize = (directory: DirectoryBuilder): FileTreeNode[] => {
    const directoryNodes = Array.from(directory.directories.values())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child) => ({
        type: "directory" as const,
        name: child.name,
        path: child.path,
        children: materialize(child),
      }));

    const fileNodes = directory.files
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((file) => ({
        type: "file" as const,
        name: file.name,
        path: file.path,
        entry: file.entry,
        valid: file.valid,
      }));

    return [...directoryNodes, ...fileNodes];
  };

  return materialize(root);
}

export default function TaskFlowWorkbench({
  files,
  initialFilePath,
  shouldHydrateRuntime,
}: {
  files: FlowFileEntry[];
  initialFilePath?: string;
  shouldHydrateRuntime: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const validFiles = useMemo(() => files.filter(hasFlow), [files]);
  const initialSelectedFile = useMemo(
    () => validFiles.find((file) => file.fileName === initialFilePath) ?? validFiles[0],
    [initialFilePath, validFiles],
  );
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => new Set(getAncestorDirectoryPaths(initialSelectedFile?.fileName ?? "")),
  );
  const [runtimeState, setRuntimeState] = useState<TaskRuntimeState>({});
  const [runtimeScopeKey, setRuntimeScopeKey] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [canPersistRuntime, setCanPersistRuntime] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [runtimeNoticeTone, setRuntimeNoticeTone] = useState<"info" | "warning">("info");
  const hasHydratedRuntime = useRef(false);
  const [diagramScale, setDiagramScale] = useState(1);
  const ZOOM_STEP = 0.1;
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 2;
  const clampScale = useCallback(
    (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)),
    [],
  );

  const requestedFilePath = searchParams.get("file") ?? initialFilePath ?? "";
  const selectedFile =
    validFiles.find((file) => file.fileName === requestedFilePath) ?? validFiles[0];
  const activeFileKey = selectedFile?.key ?? "";
  const flow = selectedFile?.flow;
  const activeRuntimeScopeKey = selectedFile ? `${selectedFile.key}:${selectedFile.flow.id}` : null;
  const tree = useMemo(() => buildFileTree(files), [files]);
  const forcedExpandedDirectories = useMemo(
    () => new Set(getAncestorDirectoryPaths(selectedFile?.fileName ?? "")),
    [selectedFile?.fileName],
  );
  const visibleExpandedDirectories = useMemo(
    () => new Set([...expandedDirectories, ...forcedExpandedDirectories]),
    [expandedDirectories, forcedExpandedDirectories],
  );
  const resolvedRuntimeState = useMemo(() => {
    if (!flow) {
      return {};
    }

    if (runtimeScopeKey !== activeRuntimeScopeKey) {
      return createInitialRuntimeState(flow);
    }

    return runtimeState;
  }, [activeRuntimeScopeKey, flow, runtimeScopeKey, runtimeState]);

  const resetSelectedFileRuntime = () => {
    if (!flow || !selectedFile) {
      return;
    }

    clearRuntimeState(flow.id, selectedFile.fileName);
    clearLegacyRuntimeState(flow.id);

    startTransition(() => {
      setRuntimeScopeKey(activeRuntimeScopeKey);
      setRuntimeState(createInitialRuntimeState(flow));
      setSelectedTaskId(flow.tasks[0]?.id ?? "");
      setCurrentTime(Date.now());
      setCanPersistRuntime(true);
      setRuntimeNotice("このファイルの保存済み進捗をリセットしました。");
      setRuntimeNoticeTone("info");
    });
  };

  useEffect(() => {
    if (!flow || !selectedFile || !activeRuntimeScopeKey) {
      startTransition(() => {
        setRuntimeScopeKey(null);
        setRuntimeState({});
        setSelectedTaskId("");
        setCanPersistRuntime(false);
        setRuntimeNotice(null);
        setRuntimeNoticeTone("info");
      });
      hasHydratedRuntime.current = true;
      return;
    }

    const hydrationResult = shouldHydrateRuntime
      ? hydrateRuntimeState({
          flow,
          fileName: selectedFile.fileName,
          flowRevision: selectedFile.flowRevision,
        })
      : {
          status: "empty" as const,
          runtimeState: createInitialRuntimeState(flow),
        };

    if (hydrationResult.status === "resetRequired") {
      const confirmed = window.confirm(
        `${selectedFile.fileName} の保存済み進捗を読み込めませんでした。\n\n${hydrationResult.message}`,
      );

      if (confirmed) {
        clearRuntimeState(flow.id, selectedFile.fileName);

        if (hydrationResult.shouldClearLegacyKey) {
          clearLegacyRuntimeState(flow.id);
        }

        startTransition(() => {
          setRuntimeScopeKey(activeRuntimeScopeKey);
          setRuntimeState(createInitialRuntimeState(flow));
          setSelectedTaskId(flow.tasks[0]?.id ?? "");
          setCurrentTime(Date.now());
          setCanPersistRuntime(true);
          setRuntimeNotice("互換性のない保存済み進捗をリセットしました。");
          setRuntimeNoticeTone("warning");
        });

        hasHydratedRuntime.current = true;
        return;
      }

      startTransition(() => {
        setRuntimeScopeKey(activeRuntimeScopeKey);
        setRuntimeState(createInitialRuntimeState(flow));
        setSelectedTaskId(flow.tasks[0]?.id ?? "");
        setCurrentTime(Date.now());
        setCanPersistRuntime(false);
        setRuntimeNotice(
          `${hydrationResult.message} リセットするまでは、このファイルの進捗は localStorage に保存されません。`,
        );
        setRuntimeNoticeTone("warning");
      });

      hasHydratedRuntime.current = true;
      return;
    }

    if (hydrationResult.shouldClearLegacyKey) {
      clearLegacyRuntimeState(flow.id);
    }

    startTransition(() => {
      setRuntimeScopeKey(activeRuntimeScopeKey);
      setRuntimeState(hydrationResult.runtimeState);
      setSelectedTaskId(flow.tasks[0]?.id ?? "");
      setCurrentTime(Date.now());
      setCanPersistRuntime(true);
      setRuntimeNotice(hydrationResult.message ?? null);
      setRuntimeNoticeTone("info");
    });

    hasHydratedRuntime.current = true;
  }, [activeRuntimeScopeKey, flow, selectedFile, shouldHydrateRuntime]);

  useEffect(() => {
    if (
      !flow ||
      !selectedFile ||
      !hasHydratedRuntime.current ||
      runtimeScopeKey !== activeRuntimeScopeKey ||
      !canPersistRuntime
    ) {
      return;
    }

    writeRuntimeState(flow.id, selectedFile.fileName, selectedFile.flowRevision, runtimeState);
  }, [
    activeRuntimeScopeKey,
    canPersistRuntime,
    flow,
    runtimeScopeKey,
    runtimeState,
    selectedFile,
  ]);

  const runningTaskId = useMemo(
    () => getRunningTaskId(resolvedRuntimeState),
    [resolvedRuntimeState],
  );

  useEffect(() => {
    if (!runningTaskId) {
      return;
    }

    const timerId = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [runningTaskId]);

  useEffect(() => {
    const currentFilePath = searchParams.get("file");
    const normalizedFilePath = selectedFile?.fileName ?? null;

    if (normalizedFilePath === currentFilePath) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());

    if (normalizedFilePath) {
      nextSearchParams.set("file", normalizedFilePath);
    } else {
      nextSearchParams.delete("file");
    }

    const nextQuery = nextSearchParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    });
  }, [pathname, router, searchParams, selectedFile?.fileName]);

  const layout = useMemo(() => (flow ? buildGraphLayout(flow) : null), [flow]);
  const nodesById = useMemo(
    () => new Map((layout?.nodes ?? []).map((node) => [node.id, node])),
    [layout],
  );
  const readyTasks = useMemo(
    () => (flow ? getReadyTasks(flow, resolvedRuntimeState) : []),
    [flow, resolvedRuntimeState],
  );
  const nextTasks = readyTasks.filter(
    (task) => resolvedRuntimeState[task.id]?.status === "todo",
  );
  const activeTasks = flow
    ? flow.tasks.filter((task) => resolvedRuntimeState[task.id]?.status === "doing")
    : [];
  const counts = useMemo(() => getTaskCounts(resolvedRuntimeState), [resolvedRuntimeState]);
  const selectedTask = flow
    ? flow.tasks.find((task) => task.id === selectedTaskId) ?? flow.tasks[0]
    : undefined;
  const selectedTaskState = selectedTask ? resolvedRuntimeState[selectedTask.id] : undefined;
  const selectedTaskBlocked = selectedTask
    ? isTaskBlocked(selectedTask, resolvedRuntimeState)
    : false;
  const selectedTaskHasAnotherRunning =
    !!selectedTask && runningTaskId !== null && runningTaskId !== selectedTask.id;
  const selectedTaskMissingDependencies = selectedTask
    ? getMissingDependencies(selectedTask, resolvedRuntimeState)
    : [];
  const selectedTaskSubtaskProgress =
    selectedTask && selectedTaskState
      ? getSubtaskProgress(selectedTask, selectedTaskState)
      : { completed: 0, total: 0 };
  const selectedTaskDetailParts =
    selectedTask && flow ? getTaskDetailParts(selectedTask, flow.sections) : [];
  const selectedTaskEstimateLabel =
    selectedTask?.estimateMinutes !== undefined ? `${selectedTask.estimateMinutes}分` : "未設定";
  const selectedTaskActualElapsedMs = selectedTaskState
    ? getEffectiveElapsedMs(selectedTaskState, currentTime)
    : 0;
  const completionRate =
    flow && flow.tasks.length > 0 ? Math.round((counts.done / flow.tasks.length) * 100) : 0;

  const expandFilePath = (filePath: string) => {
    const nextPaths = getAncestorDirectoryPaths(filePath);

    if (nextPaths.length === 0) {
      return;
    }

    setExpandedDirectories((current) => {
      const next = new Set(current);

      for (const path of nextPaths) {
        next.add(path);
      }

      return next;
    });
  };

  const handleSelectFile = (file: ValidFlowFileEntry) => {
    expandFilePath(file.fileName);
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("file", file.fileName);
    const nextQuery = nextSearchParams.toString();

    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
      scroll: false,
    });
  };

  const toggleDirectory = (directoryPath: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);

      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }

      return next;
    });
  };

  const updateTaskStatus = useCallback((taskId: string, status: TaskStatus) => {
    startTransition(() => {
      setRuntimeState((current) => ({
        ...current,
        [taskId]: {
          ...current[taskId],
          status,
        },
      }));
    });
  }, []);

  const updateSubtaskStatus = (taskId: string, subtaskIndex: number, checked: boolean) => {
    startTransition(() => {
      setRuntimeState((current) => {
        const taskState = current[taskId];

        if (!taskState) {
          return current;
        }

        return {
          ...current,
          [taskId]: {
            ...taskState,
            subtasks: taskState.subtasks.map((subtask, index) =>
              index === subtaskIndex ? checked : subtask,
            ),
          },
        };
      });
    });
  };

  const startTimer = (taskId: string) => {
    startTransition(() => {
      setRuntimeState((current) => {
        const activeTaskId = getRunningTaskId(current);

        if (activeTaskId && activeTaskId !== taskId) {
          return current;
        }

        const taskState = current[taskId];

        if (!taskState || taskState.timerState === "running") {
          return current;
        }

        return {
          ...current,
          [taskId]: {
            ...taskState,
            timerState: "running",
            startedAt: Date.now(),
          },
        };
      });
    });
  };

  const pauseTimer = (taskId: string) => {
    startTransition(() => {
      setRuntimeState((current) => {
        const taskState = current[taskId];

        if (!taskState || taskState.timerState !== "running" || taskState.startedAt === null) {
          return current;
        }

        return {
          ...current,
          [taskId]: {
            ...taskState,
            actualElapsedMs:
              taskState.actualElapsedMs + Math.max(0, Date.now() - taskState.startedAt),
            timerState: "paused",
            startedAt: null,
          },
        };
      });
    });
  };

  const stopTimer = (taskId: string) => {
    startTransition(() => {
      setRuntimeState((current) => {
        const taskState = current[taskId];

        if (!taskState || taskState.timerState === "idle") {
          return current;
        }

        const runningElapsed =
          taskState.timerState === "running" && taskState.startedAt !== null
            ? Math.max(0, Date.now() - taskState.startedAt)
            : 0;

        return {
          ...current,
          [taskId]: {
            ...taskState,
            actualElapsedMs: taskState.actualElapsedMs + runningElapsed,
            timerState: "idle",
            startedAt: null,
          },
        };
      });
    });
  };

  const navigateNode = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const nodes = layout?.nodes;

      if (!nodes || nodes.length === 0) {
        return;
      }

      if (!selectedTaskId) {
        setSelectedTaskId(nodes[0].id);
        return;
      }

      const current = nodes.find((node) => node.id === selectedTaskId);

      if (!current) {
        setSelectedTaskId(nodes[0].id);
        return;
      }

      let target: (typeof nodes)[number] | undefined;

      if (direction === "up") {
        const candidates = nodes.filter(
          (node) => node.depth === current.depth && node.row < current.row,
        );
        target = candidates.sort((a, b) => b.row - a.row)[0];
      } else if (direction === "down") {
        const candidates = nodes.filter(
          (node) => node.depth === current.depth && node.row > current.row,
        );
        target = candidates.sort((a, b) => a.row - b.row)[0];
      } else if (direction === "left") {
        const candidates = nodes.filter((node) => node.depth === current.depth - 1);
        target = candidates.sort((a, b) => Math.abs(a.row - current.row) - Math.abs(b.row - current.row))[0];
      } else {
        const candidates = nodes.filter((node) => node.depth === current.depth + 1);
        target = candidates.sort((a, b) => Math.abs(a.row - current.row) - Math.abs(b.row - current.row))[0];
      }

      if (target) {
        setSelectedTaskId(target.id);
      }
    },
    [layout, selectedTaskId],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!layout) {
        return;
      }

      const tag = (event.target as HTMLElement).tagName;

      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) {
        return;
      }

      const directionMap: Record<string, "up" | "down" | "left" | "right"> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
      };

      const direction = directionMap[event.key];

      if (direction) {
        event.preventDefault();
        navigateNode(direction);
        return;
      }

      const statusMap: Record<string, TaskStatus> = {
        "1": "todo",
        "2": "doing",
        "3": "done",
      };

      const newStatus = statusMap[event.key];

      if (newStatus && selectedTask && !selectedTaskBlocked) {
        event.preventDefault();
        updateTaskStatus(selectedTask.id, newStatus);
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setDiagramScale((s) => clampScale(s + ZOOM_STEP));
        return;
      }

      if (event.key === "-") {
        event.preventDefault();
        setDiagramScale((s) => clampScale(s - ZOOM_STEP));
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        setDiagramScale(1);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [clampScale, layout, navigateNode, selectedTask, selectedTaskBlocked, updateTaskStatus]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.18),_transparent_34%),radial-gradient(circle_at_bottom_right,_rgba(96,165,250,0.14),_transparent_30%),linear-gradient(180deg,_#fbf8f2_0%,_#f6f1e8_48%,_#efe7da_100%)] text-stone-900">
      <main className="w-full px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6 xl:px-8 xl:py-8 2xl:px-10">
        <section>
          <div className="rounded-[20px] border border-white/70 bg-white/82 p-3 shadow-[0_24px_60px_rgba(41,37,36,0.1)] backdrop-blur sm:p-4 lg:p-5 xl:p-6">
            <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
              <aside className="rounded-[18px] border border-stone-900/8 bg-stone-100/90 p-5 text-stone-900 shadow-[0_16px_36px_rgba(41,37,36,0.06)] xl:sticky xl:top-8 xl:self-start xl:max-h-[calc(100vh-4rem)] xl:overflow-hidden">
                <div className="border-b border-stone-900/8 pb-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
                    YAML Navigator
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-stone-950">
                    src/data
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    ディレクトリを開いて YAML を切り替えます。
                  </p>
                  <p className="mt-3 text-xs text-stone-500">
                    有効 {validFiles.length} / 全体 {files.length}
                  </p>
                </div>

                <div className="mt-4 xl:max-h-[calc(100vh-14rem)] xl:overflow-y-auto xl:pr-1">
                  {files.length > 0 ? (
                    <TreeList
                      nodes={tree}
                      depth={0}
                      activeFileKey={activeFileKey}
                      expandedDirectories={visibleExpandedDirectories}
                      onToggleDirectory={toggleDirectory}
                      onSelectFile={handleSelectFile}
                    />
                  ) : (
                    <div className="rounded-[16px] border border-stone-900/8 bg-white/80 p-4">
                      <p className="text-sm font-semibold text-stone-900">
                        YAML ファイルがありません
                      </p>
                      <p className="mt-2 text-sm leading-6 text-stone-600">
                        `src/data` 配下に `.yaml` または `.yml` を追加すると、ここにツリー表示されます。
                      </p>
                    </div>
                  )}
                </div>
              </aside>

              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-4 rounded-[18px] border border-stone-900/8 bg-white/88 p-5 shadow-[0_18px_42px_rgba(28,25,23,0.07)] sm:p-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="space-y-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
                        フロータスク
                      </p>
                      <div>
                        <h1 className="font-display text-4xl font-semibold tracking-[-0.04em] text-stone-950 sm:text-5xl">
                          {flow?.title ?? "有効な YAML がありません"}
                        </h1>
                        <p className="mt-2 text-sm leading-7 text-stone-600 sm:text-base">
                          YAML で定義した構造をそのまま可視化し、依存が解消された次アクションだけを前に出します。
                        </p>
                      </div>
                    </div>
                    <div className="rounded-[16px] border border-stone-900/8 bg-stone-100 px-5 py-4 text-stone-900 shadow-[0_12px_28px_rgba(28,25,23,0.06)]">
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                        選択中ファイル
                      </p>
                      <p className="mt-2 text-lg font-semibold tracking-[-0.03em]">
                        {selectedFile?.fileName ?? "なし"}
                      </p>
                      <p className="mt-1 text-xs text-stone-500">
                        保存は `flow.id` とファイルパス単位で保持
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-4">
                    <MetricCard label="フローID" value={flow?.id ?? "未選択"} tone="ink" />
                    <MetricCard
                      label="完了数"
                      value={flow ? `${counts.done}/${flow.tasks.length}` : "0/0"}
                      tone="warm"
                    />
                    <MetricCard label="進行中" value={`${activeTasks.length}`} tone="blue" />
                    <MetricCard label="進捗" value={`${completionRate}%`} tone="ink" />
                  </div>

                  {runtimeNotice ? (
                    <div
                      className={`rounded-[16px] border px-5 py-4 ${PERSISTENCE_NOTICE_STYLES[runtimeNoticeTone]}`}
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <p className="text-sm leading-7">{runtimeNotice}</p>
                        {!canPersistRuntime && flow && selectedFile ? (
                          <button
                            type="button"
                            onClick={resetSelectedFileRuntime}
                            className="rounded-lg bg-stone-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-800"
                          >
                            このファイルをリセットして保存を再開
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>

                {flow && layout ? (
                  <div className="grid gap-4 rounded-[18px] border border-stone-900/8 bg-white/88 p-4 text-stone-900 shadow-[0_18px_42px_rgba(28,25,23,0.07)] lg:grid-cols-[minmax(0,1fr)_360px] xl:p-5 2xl:grid-cols-[minmax(0,1fr)_390px]">
                    <div>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                            フロー図
                          </p>
                          <p className="mt-1 text-sm text-stone-600">
                            ノードを選択すると右側に詳細を表示します。
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setDiagramScale((s) => clampScale(s - ZOOM_STEP))}
                            className="flex h-7 w-7 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-50 active:bg-stone-100"
                            aria-label="縮小"
                          >
                            −
                          </button>
                          <span className="min-w-[3rem] text-center text-xs tabular-nums text-stone-500">
                            {Math.round(diagramScale * 100)}%
                          </span>
                          <button
                            type="button"
                            onClick={() => setDiagramScale((s) => clampScale(s + ZOOM_STEP))}
                            className="flex h-7 w-7 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-50 active:bg-stone-100"
                            aria-label="拡大"
                          >
                            +
                          </button>
                          {diagramScale !== 1 ? (
                            <button
                              type="button"
                              onClick={() => setDiagramScale(1)}
                              className="ml-1 rounded-md border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-500 transition hover:bg-stone-50"
                            >
                              リセット
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div
                        className="mt-5 overflow-auto rounded-[16px] border border-stone-900/8 bg-[linear-gradient(180deg,_rgba(255,255,255,0.82),_rgba(245,241,232,0.9))]"
                        onWheel={(e) => {
                          if (!e.ctrlKey && !e.metaKey) return;
                          e.preventDefault();
                          const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
                          setDiagramScale((s) => clampScale(s + delta));
                        }}
                      >
                        <div
                          style={{
                            width: Math.max(layout.width, 720) * diagramScale,
                            height: Math.max(layout.height, 420) * diagramScale,
                          }}
                        >
                        <div
                          className="relative origin-top-left"
                          style={{
                            width: Math.max(layout.width, 720),
                            height: Math.max(layout.height, 420),
                            transform: `scale(${diagramScale})`,
                          }}
                        >
                          <svg
                            className="pointer-events-none absolute inset-0 h-full w-full"
                            viewBox={`0 0 ${Math.max(layout.width, 720)} ${Math.max(layout.height, 420)}`}
                            fill="none"
                          >
                            {layout.edges.map((edge) => {
                              const from = nodesById.get(edge.from);
                              const to = nodesById.get(edge.to);

                              if (!from || !to) {
                                return null;
                              }

                              const isHighlighted =
                                selectedTaskId === edge.to || selectedTaskId === edge.from;

                                return (
                                  <path
                                    key={`${edge.from}:${edge.to}`}
                                    d={getTaskPath(from, to)}
                                    stroke={isHighlighted ? "#f59e0b" : "rgba(87,83,78,0.22)"}
                                    strokeWidth={isHighlighted ? 3 : 2}
                                    strokeLinecap="round"
                                  />
                              );
                            })}
                          </svg>

                          {layout.nodes.map((node) => (
                            <FlowNode
                              key={node.id}
                              node={node}
                              runtimeEntry={resolvedRuntimeState[node.id]}
                              isSelected={node.id === selectedTaskId}
                              isReady={readyTasks.some((task) => task.id === node.id)}
                              onSelect={() => setSelectedTaskId(node.id)}
                            />
                          ))}
                        </div>
                        </div>
                      </div>
                    </div>

                    <aside className="space-y-4 rounded-[16px] border border-stone-900/8 bg-stone-50/90 p-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                          選択中
                        </p>
                        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-stone-950">
                          {selectedTask?.title ?? "タスク未選択"}
                        </h2>
                        {selectedTask ? (
                          <TaskDetailParts
                            parts={selectedTaskDetailParts}
                            emptyMessage="このタスクには説明がありません。必要な意図は YAML 側の description または parts に追加できます。"
                          />
                        ) : (
                          <p className="mt-3 text-sm leading-7 text-stone-600">
                            このタスクには説明がありません。必要な意図は YAML 側の description または parts に追加できます。
                          </p>
                        )}
                      </div>

                      {selectedTask ? (
                        <>
                          <div className="flex items-center gap-2">
                            {STATUS_OPTIONS.map((status) => (
                              <button
                                key={status}
                                type="button"
                                disabled={selectedTaskBlocked}
                                onClick={() => updateTaskStatus(selectedTask.id, status)}
                                 className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                                   selectedTaskState?.status === status
                                     ? "bg-amber-200 text-amber-950"
                                     : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                                 } ${selectedTaskBlocked ? "cursor-not-allowed opacity-35 hover:bg-white" : ""}`}
                               >
                                 {STATUS_LABELS[status]}
                               </button>
                            ))}
                          </div>

                          <div className="rounded-xl border border-stone-900/8 bg-white/72 p-4">
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div className="rounded-xl border border-stone-900/8 bg-stone-50 p-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                                  想定工数
                                </p>
                                <p className="mt-2 text-lg font-semibold text-stone-950">
                                  {selectedTaskEstimateLabel}
                                </p>
                              </div>
                              <div className="rounded-xl border border-stone-900/8 bg-stone-50 p-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                                  実績
                                </p>
                                <p className="mt-2 text-lg font-semibold text-stone-950">
                                  {formatElapsedMs(selectedTaskActualElapsedMs)}
                                </p>
                                <p className="mt-1 text-xs text-stone-500">
                                  {selectedTaskState
                                    ? TIMER_LABELS[selectedTaskState.timerState]
                                    : TIMER_LABELS.idle}
                                </p>
                              </div>
                            </div>

                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={
                                  selectedTaskBlocked ||
                                  selectedTaskHasAnotherRunning ||
                                  selectedTaskState?.timerState === "running"
                                }
                                onClick={() => startTimer(selectedTask.id)}
                                className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                                  selectedTaskState?.timerState === "paused"
                                    ? "bg-sky-200 text-sky-950"
                                    : "bg-stone-900 text-white"
                                } ${
                                  selectedTaskBlocked ||
                                  selectedTaskHasAnotherRunning ||
                                  selectedTaskState?.timerState === "running"
                                    ? "cursor-not-allowed opacity-35"
                                    : selectedTaskState?.timerState === "paused"
                                      ? "hover:bg-sky-300"
                                      : "hover:bg-stone-800"
                                }`}
                              >
                                {selectedTaskState?.timerState === "paused" ? "再開" : "開始"}
                              </button>
                              <button
                                type="button"
                                disabled={selectedTaskState?.timerState !== "running"}
                                onClick={() => pauseTimer(selectedTask.id)}
                                className={`rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 transition ${
                                  selectedTaskState?.timerState !== "running"
                                    ? "cursor-not-allowed opacity-35"
                                    : "hover:bg-stone-100"
                                }`}
                              >
                                一時停止
                              </button>
                              <button
                                type="button"
                                disabled={!selectedTaskState || selectedTaskState.timerState === "idle"}
                                onClick={() => stopTimer(selectedTask.id)}
                                className={`rounded-lg border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700 transition ${
                                  !selectedTaskState || selectedTaskState.timerState === "idle"
                                    ? "cursor-not-allowed opacity-35"
                                    : "hover:bg-rose-50"
                                }`}
                              >
                                終了
                              </button>
                            </div>

                            {selectedTaskHasAnotherRunning ? (
                               <p className="mt-3 text-sm leading-7 text-stone-600">
                                 別のタスクが計測中のため、このタスクはまだ開始できません。
                               </p>
                            ) : null}
                          </div>

                          {selectedTaskBlocked ? (
                            <div className="rounded-xl border border-stone-300/70 bg-stone-100/80 p-4">
                              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                                まだ進めない理由
                              </p>
                              <p className="mt-2 text-sm leading-7 text-stone-600">
                                次の依存タスクが完了するまで、このタスクの状態は変更できません。
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {selectedTaskMissingDependencies.map((dependency) => (
                                  <button
                                    key={dependency}
                                    type="button"
                                    onClick={() => setSelectedTaskId(dependency)}
                                    className="rounded-lg border border-stone-300 bg-white px-3 py-1 text-sm text-stone-700 transition hover:bg-stone-50"
                                  >
                                    {dependency}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {selectedTask.subtasks.length > 0 ? (
                            <div className="rounded-xl border border-stone-900/8 bg-white/72 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                                  サブタスク
                                </p>
                                <span className="text-xs font-medium text-stone-600">
                                  {selectedTaskSubtaskProgress.completed}/{selectedTaskSubtaskProgress.total} 完了
                                </span>
                              </div>
                              <div className="mt-3 space-y-2">
                                {selectedTask.subtasks.map((subtask, subtaskIndex) => {
                                  const checked = selectedTaskState?.subtasks[subtaskIndex] ?? false;

                                  return (
                                    <button
                                      key={`${selectedTask.id}:subtask:${subtaskIndex}`}
                                      type="button"
                                      onClick={() =>
                                        updateSubtaskStatus(selectedTask.id, subtaskIndex, !checked)
                                      }
                                      className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${
                                        checked
                                          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                                          : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                                       }`}
                                    >
                                      <span
                                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${
                                          checked
                                            ? "border-emerald-300 bg-emerald-300 text-stone-950"
                                            : "border-stone-300 text-stone-500"
                                        }`}
                                      >
                                        <svg
                                          aria-hidden="true"
                                          viewBox="0 0 16 16"
                                          className={`h-3.5 w-3.5 ${
                                            checked ? "opacity-100" : "opacity-0"
                                          }`}
                                          fill="none"
                                        >
                                          <path
                                            d="M3.5 8.5 6.5 11.5 12.5 5.5"
                                            stroke="currentColor"
                                            strokeWidth="2.25"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                        </svg>
                                      </span>
                                      <span
                                        className={`min-w-0 flex-1 text-sm leading-6 ${
                                          checked ? "line-through opacity-80" : ""
                                        }`}
                                      >
                                        {subtask.title}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ) : null}

                          <div className="rounded-xl border border-stone-900/8 bg-white/72 p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                              依存タスク
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {selectedTask.dependsOn.length === 0 ? (
                                <span className="rounded-lg bg-stone-100 px-3 py-1 text-sm text-stone-600">
                                  先行タスクなし
                                </span>
                              ) : (
                                selectedTask.dependsOn.map((dependency) => (
                                  <button
                                    key={dependency}
                                    type="button"
                                    onClick={() => setSelectedTaskId(dependency)}
                                    className="rounded-lg border border-stone-200 bg-white px-3 py-1 text-sm text-stone-700 transition hover:bg-stone-50"
                                  >
                                    {dependency}
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        </>
                      ) : null}

                      <div className="rounded-xl border border-stone-900/8 bg-white/72 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                          次の候補
                        </p>
                        <div className="mt-3 space-y-2">
                          {nextTasks.length > 0 ? (
                            nextTasks.map((task) => (
                              <button
                                key={task.id}
                                type="button"
                                onClick={() => setSelectedTaskId(task.id)}
                                className="flex w-full items-start rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-left transition hover:bg-sky-100"
                              >
                                <span>
                                  <span className="block text-sm font-semibold text-sky-950">
                                    {task.title}
                                  </span>
                                </span>
                              </button>
                            ))
                          ) : (
                            <p className="text-sm leading-7 text-stone-600">
                              依存解消済みの候補はまだありません。先行タスクを進めると次が開きます。
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="rounded-xl border border-stone-900/8 bg-white/72 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                          進捗状況
                        </p>
                        <div className="mt-3 space-y-2 text-sm text-stone-600">
                          <p>未着手: {counts.todo}</p>
                          <p>進行中: {counts.doing}</p>
                          <p>完了: {counts.done}</p>
                        </div>
                      </div>
                    </aside>
                  </div>
                ) : (
                  <EmptyStateCard
                    title={
                      files.length === 0
                        ? "表示できる YAML がありません"
                        : "有効な YAML を選択できません"
                    }
                    description={
                      files.length === 0
                        ? "`src/data` 配下にフロー定義を追加すると、ここにフロー図が表示されます。"
                        : "左側のツリーに表示されたエラーを修正すると、ここにフロー図とタスク詳細が表示されます。"
                    }
                  />
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function TreeList({
  nodes,
  depth,
  activeFileKey,
  expandedDirectories,
  onToggleDirectory,
  onSelectFile,
}: {
  nodes: FileTreeNode[];
  depth: number;
  activeFileKey: string;
  expandedDirectories: Set<string>;
  onToggleDirectory: (directoryPath: string) => void;
  onSelectFile: (file: ValidFlowFileEntry) => void;
}) {
  return (
    <div className={depth === 0 ? "space-y-1" : "mt-1 space-y-1"}>
      {nodes.map((node) => {
        if (node.type === "directory") {
          const isExpanded = expandedDirectories.has(node.path);

          return (
            <div key={node.path}>
              <button
                type="button"
                onClick={() => onToggleDirectory(node.path)}
                className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-stone-700 transition hover:bg-white/70"
                style={{ paddingLeft: `${depth * 16 + 12}px` }}
              >
                <span className="mr-3 inline-flex h-5 w-5 items-center justify-center rounded-md border border-stone-300 bg-white text-[11px] text-stone-500">
                  {isExpanded ? "-" : "+"}
                </span>
                <span className="font-medium">{node.name}</span>
              </button>

              {isExpanded ? (
                <TreeList
                  nodes={node.children}
                  depth={depth + 1}
                  activeFileKey={activeFileKey}
                  expandedDirectories={expandedDirectories}
                  onToggleDirectory={onToggleDirectory}
                  onSelectFile={onSelectFile}
                />
              ) : null}
            </div>
          );
        }

        const isSelected = node.entry.key === activeFileKey;
        const labelTone = node.valid ? "text-stone-800" : "text-rose-900";

        return (
          <button
            key={node.path}
            type="button"
            disabled={!node.valid}
            onClick={() => {
              if (hasFlow(node.entry)) {
                onSelectFile(node.entry);
              }
            }}
            className={`w-full rounded-xl border px-3 py-2 text-left transition ${
              node.valid
                ? "border-transparent bg-white/0 hover:bg-white/70"
                : "cursor-not-allowed border-rose-200 bg-rose-50 opacity-80"
            } ${isSelected ? "border-amber-200 bg-amber-50" : ""}`}
            style={{ paddingLeft: `${depth * 16 + 40}px` }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`truncate text-sm font-medium ${labelTone}`}>{node.name}</p>
                <p className="mt-1 text-xs text-stone-500">
                  {node.valid
                    ? hasFlow(node.entry)
                      ? `${node.entry.flow.tasks.length} タスク`
                      : ""
                    : node.entry.issues?.[0] ?? "YAML を解析できません。"}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                  node.valid
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-rose-100 text-rose-800"
                }`}
              >
                {node.valid ? "Ready" : "Error"}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function FlowNode({
  node,
  runtimeEntry,
  isSelected,
  isReady,
  onSelect,
}: {
  node: PositionedTask;
  runtimeEntry: TaskRuntimeEntry;
  isSelected: boolean;
  isReady: boolean;
  onSelect: () => void;
}) {
  const subtaskProgress = getSubtaskProgress(node, runtimeEntry);
  const isBlocked = runtimeEntry.status === "todo" && !isReady;
  const statusStyles: Record<TaskStatus, string> = {
    todo: "border-stone-200 bg-white text-stone-900",
    doing: "border-sky-200 bg-sky-50 text-sky-950",
    done: "border-emerald-200 bg-emerald-50 text-emerald-950",
  };
  const blockedStyles =
    "border-stone-200 bg-stone-100 text-stone-500 opacity-75 hover:opacity-100";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`absolute h-[172px] w-[210px] rounded-[16px] border p-4 text-left shadow-[0_14px_28px_rgba(41,37,36,0.12)] transition ${
        isBlocked ? blockedStyles : statusStyles[runtimeEntry.status]
      } ${isSelected ? "ring-2 ring-amber-300/80" : ""}`}
      style={{
        left: node.x,
        top: node.y,
      }}
    >
      <div className="flex h-full flex-col">
        <div className="flex h-5 items-start justify-end">
          {isBlocked ? (
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                待機中
              </span>
          ) : null}
        </div>

        <div className="flex flex-1 items-center">
          <p className="overflow-hidden text-sm font-semibold leading-6 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
            {node.title}
          </p>
        </div>

        <div className="space-y-2">
          <p className="h-4 text-xs text-current/70">
            {subtaskProgress.total > 0
              ? `サブタスク ${subtaskProgress.completed}/${subtaskProgress.total}`
              : ""}
          </p>
          <p className="text-xs uppercase tracking-[0.18em] text-current/60">
            {STATUS_LABELS[runtimeEntry.status]}
          </p>
        </div>
      </div>
    </button>
  );
}

function TaskDetailParts({
  parts,
  emptyMessage,
}: {
  parts: TaskCardPart[];
  emptyMessage: string;
}) {
  const [copiedPartKey, setCopiedPartKey] = useState<string | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async (part: TaskCardPart, partKey: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(getCopyValue(part));

      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }

      setCopiedPartKey(partKey);
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopiedPartKey((current) => (current === partKey ? null : current));
      }, 1600);
    } catch {
      // Ignore clipboard failures and keep the default UI state.
    }
  };

  if (parts.length === 0) {
    return <p className="mt-3 text-sm leading-7 text-stone-600">{emptyMessage}</p>;
  }

  return (
    <div className="mt-3 space-y-3">
      {parts.map((part, index) => {
        const partKey = `detail-part:${index}`;
        const isCopied = copiedPartKey === partKey;

        if (part.type === "text") {
          return (
            <div
              key={partKey}
               className="group relative rounded-xl border border-stone-900/8 bg-white/75 p-4"
             >
              <CopyPartButton
                isVisible={part.copyable}
                isCopied={isCopied}
                onClick={() => handleCopy(part, partKey)}
              />
              <div className="space-y-1.5">
                {part.label ? (
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">
                    {part.label}
                  </p>
                ) : null}
                <p className="text-sm leading-7 text-stone-700 whitespace-pre-wrap">
                  {part.text}
                </p>
              </div>
            </div>
          );
        }

        return (
          <div
            key={partKey}
            className="group relative rounded-xl border border-sky-200 bg-sky-50 p-4 transition hover:bg-sky-100"
          >
            <CopyPartButton
              isVisible={part.copyable}
              isCopied={isCopied}
              onClick={() => handleCopy(part, partKey)}
              tone="link"
            />
            <a
              href={part.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center justify-between gap-3 text-sm text-sky-950"
            >
              <span className="min-w-0 font-medium">{part.label}</span>
              <span className="truncate text-xs text-sky-700">{part.url}</span>
            </a>
          </div>
        );
      })}
    </div>
  );
}

function getCopyValue(part: TaskCardPart): string {
  return part.type === "text" ? part.text : part.url;
}

function CopyPartButton({
  isVisible,
  isCopied,
  onClick,
  tone = "default",
}: {
  isVisible: boolean;
  isCopied: boolean;
  onClick: () => void;
  tone?: "default" | "link";
}) {
  if (!isVisible) {
    return null;
  }

  const toneStyles =
    tone === "link"
      ? "border-sky-200 bg-white/90 text-sky-900 hover:bg-sky-50"
      : "border-stone-200 bg-white/92 text-stone-700 hover:bg-stone-50";
  const visibilityStyles = isCopied
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`absolute top-2.5 right-2.5 z-10 flex h-8 w-8 items-center justify-center rounded-md border shadow-[0_8px_18px_rgba(41,37,36,0.12)] backdrop-blur-sm transition ${toneStyles} ${visibilityStyles}`}
      aria-label={isCopied ? "コピー済み" : "コピー"}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <rect x="5" y="3" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V4A1.5 1.5 0 0 1 3 2.5h5A1.5 1.5 0 0 1 9.5 4v.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ink" | "warm" | "blue";
}) {
  const toneStyles = {
    ink: "border border-stone-200 bg-stone-100 text-stone-950",
    warm: "border border-amber-200 bg-amber-50 text-amber-950",
    blue: "border border-sky-200 bg-sky-50 text-sky-950",
  };

  return (
    <div className={`rounded-[16px] p-4 ${toneStyles[tone]}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.24em] opacity-70">{label}</p>
      <p className="mt-4 text-2xl font-semibold tracking-[-0.04em]">{value}</p>
    </div>
  );
}

function EmptyStateCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-[18px] border border-stone-900/8 bg-white/88 p-8 text-stone-900 shadow-[0_18px_42px_rgba(28,25,23,0.08)]">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
        Empty State
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">{title}</h2>
      <p className="mt-3 text-sm leading-7 text-stone-600">{description}</p>
    </div>
  );
}
