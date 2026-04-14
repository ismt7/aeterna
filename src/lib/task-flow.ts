import { parseDocument } from "yaml";

export type TaskStatus = "todo" | "doing" | "done";
export type TaskTimerState = "idle" | "running" | "paused";

export type SubtaskDefinition = {
  title: string;
};

export type TextTaskCardPart = {
  type: "text";
  text: string;
  label?: string;
  copyable: boolean;
};

export type LinkTaskCardPart = {
  type: "link";
  label: string;
  url: string;
  copyable: boolean;
};

export type TaskCardPart = TextTaskCardPart | LinkTaskCardPart;
export type TaskCardPartReference = {
  ref: string;
};
export type TaskCardPartInput = TaskCardPart | TaskCardPartReference;
export type SharedTaskCardPartDefinition = TaskCardPart | TaskCardPart[];
export type FlowSections = {
  parts: Record<string, SharedTaskCardPartDefinition>;
};

export type TaskDefinition = {
  id: string;
  title: string;
  description?: string;
  estimateMinutes?: number;
  dependsOn: string[];
  subtasks: SubtaskDefinition[];
  parts: TaskCardPartInput[];
};

export type FlowDefinition = {
  id: string;
  title: string;
  sections?: FlowSections;
  tasks: TaskDefinition[];
};

export type FlowFileEntry = {
  key: string;
  fileName: string;
  filePath: string;
  flowRevision: string;
  flow?: FlowDefinition;
  issues?: string[];
};

export type TaskRuntimeEntry = {
  status: TaskStatus;
  subtasks: boolean[];
  actualElapsedMs: number;
  timerState: TaskTimerState;
  startedAt: number | null;
};

export type TaskRuntimeState = Record<string, TaskRuntimeEntry>;

export type PersistedRuntimeState = {
  schemaVersion: number;
  flowId: string;
  fileName: string;
  flowRevision: string;
  savedAt: number;
  runtimeState: TaskRuntimeState;
};

export type RuntimeHydrationResult =
  | {
      status: "empty" | "applied" | "migrated";
      runtimeState: TaskRuntimeState;
      message?: string;
      shouldClearLegacyKey?: boolean;
    }
  | {
      status: "resetRequired";
      runtimeState: TaskRuntimeState;
      message: string;
      shouldClearLegacyKey?: boolean;
    };

export type FlowParseResult =
  | {
      ok: true;
      flow: FlowDefinition;
    }
  | {
      ok: false;
      issues: string[];
    };

export type PositionedTask = TaskDefinition & {
  depth: number;
  row: number;
  x: number;
  y: number;
};

export type GraphLayout = {
  nodes: PositionedTask[];
  edges: Array<{
    from: string;
    to: string;
  }>;
  width: number;
  height: number;
};

const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "done"];
const TIMER_STATE_ORDER: TaskTimerState[] = ["idle", "running", "paused"];
const STORAGE_SCHEMA_VERSION = 2;
const STORAGE_PREFIX = "aeterna:task-flow:v2:";
const LEGACY_STORAGE_PREFIX = "aeterna:task-flow:";
const COLUMN_WIDTH = 280;
const NODE_WIDTH = 210;
const NODE_HEIGHT = 172;
const ROW_HEIGHT = 196;
const PADDING_X = 64;
const PADDING_Y = 48;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function asNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }

  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseCopyable(
  value: unknown,
  path: string,
  issues: string[],
): boolean | undefined {
  if (value === undefined) {
    return true;
  }

  if (typeof value !== "boolean") {
    issues.push(`${path}.copyable は真偽値である必要があります。`);
    return undefined;
  }

  return value;
}

function parseSubtasks(
  value: unknown,
  taskIndex: number,
  issues: string[],
): SubtaskDefinition[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    issues.push(`tasks[${taskIndex}].subtasks は配列である必要があります。`);
    return [];
  }

  const subtasks: SubtaskDefinition[] = [];

  for (const [subtaskIndex, rawSubtask] of value.entries()) {
    const subtask = asRecord(rawSubtask);

    if (!subtask) {
      issues.push(
        `tasks[${taskIndex}].subtasks[${subtaskIndex}] はオブジェクトである必要があります。`,
      );
      continue;
    }

    const subtaskTitle = subtask.title;

    if (typeof subtaskTitle !== "string" || subtaskTitle.trim() === "") {
      issues.push(
        `tasks[${taskIndex}].subtasks[${subtaskIndex}].title は必須の文字列です。`,
      );
      continue;
    }

    subtasks.push({
      title: subtaskTitle,
    });
  }

  return subtasks;
}

function parseTaskCardParts(
  value: unknown,
  taskIndex: number,
  issues: string[],
): TaskCardPartInput[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    issues.push(`tasks[${taskIndex}].parts は配列である必要があります。`);
    return [];
  }

  const parts: TaskCardPartInput[] = [];

  for (const [partIndex, rawPart] of value.entries()) {
    const partPath = `tasks[${taskIndex}].parts[${partIndex}]`;
    const parsedPart = parseTaskCardPartInput(rawPart, partPath, issues);

    if (parsedPart) {
      parts.push(parsedPart);
    }
  }

  return parts;
}

function parseTaskCardPartInput(
  value: unknown,
  path: string,
  issues: string[],
): TaskCardPartInput | undefined {
  const part = asRecord(value);

  if (!part) {
    issues.push(`${path} はオブジェクトである必要があります。`);
    return undefined;
  }

  const hasRef = Object.hasOwn(part, "ref");
  const hasType = Object.hasOwn(part, "type");

  if (hasRef && hasType) {
    issues.push(`${path}.ref と ${path}.type は同時に指定できません。`);
    return undefined;
  }

  if (hasRef) {
    const ref = part.ref;

    if (typeof ref !== "string" || ref.trim() === "") {
      issues.push(`${path}.ref は必須の文字列です。`);
      return undefined;
    }

    return { ref };
  }

  return parseInlineTaskCardPart(value, path, issues, false);
}

function parseInlineTaskCardPart(
  value: unknown,
  path: string,
  issues: string[],
  allowReference: boolean,
): TaskCardPart | undefined {
  const part = asRecord(value);

  if (!part) {
    issues.push(`${path} はオブジェクトである必要があります。`);
    return undefined;
  }

  if (!allowReference && Object.hasOwn(part, "ref")) {
    issues.push(`${path}.ref は共有パーツ定義内では利用できません。`);
    return undefined;
  }

  const partType = part.type;

  if (partType === "text") {
    const label = part.label;
    const text = part.text;
    const copyable = parseCopyable(part.copyable, path, issues);

    if (label !== undefined && (typeof label !== "string" || label.trim() === "")) {
      issues.push(`${path}.label は空でない文字列である必要があります。`);
      return undefined;
    }

    if (copyable === undefined) {
      return undefined;
    }

    if (typeof text !== "string" || text.trim() === "") {
      issues.push(`${path}.text は必須の文字列です。`);
      return undefined;
    }

    return {
      type: "text",
      label,
      text,
      copyable,
    };
  }

  if (partType === "link") {
    const label = part.label;
    const url = part.url;
    const copyable = parseCopyable(part.copyable, path, issues);

    if (typeof label !== "string" || label.trim() === "") {
      issues.push(`${path}.label は必須の文字列です。`);
      return undefined;
    }

    if (copyable === undefined) {
      return undefined;
    }

    if (typeof url !== "string" || url.trim() === "") {
      issues.push(`${path}.url は必須の文字列です。`);
      return undefined;
    }

    if (!isHttpUrl(url)) {
      issues.push(
        `${path}.url は http:// または https:// で始まる有効な URL である必要があります。`,
      );
      return undefined;
    }

    return {
      type: "link",
      label,
      url,
      copyable,
    };
  }

  issues.push(`${path}.type は "text" または "link" である必要があります。`);
  return undefined;
}

function parseSharedTaskCardPartDefinitions(
  value: unknown,
  issues: string[],
): FlowSections | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sections = asRecord(value);

  if (!sections) {
    issues.push("sections はオブジェクトである必要があります。");
    return undefined;
  }

  if (sections.parts === undefined) {
    return undefined;
  }

  const partsRecord = asRecord(sections.parts);

  if (!partsRecord) {
    issues.push("sections.parts はオブジェクトである必要があります。");
    return undefined;
  }

  const sharedParts: Record<string, SharedTaskCardPartDefinition> = {};

  for (const [definitionId, rawDefinition] of Object.entries(partsRecord)) {
    const definitionPath = `sections.parts.${definitionId}`;

    if (definitionId.trim() === "") {
      issues.push("sections.parts のキーは空文字列にできません。");
      continue;
    }

    if (Array.isArray(rawDefinition)) {
      const parsedParts: TaskCardPart[] = [];

      for (const [partIndex, rawPart] of rawDefinition.entries()) {
        const parsedPart = parseInlineTaskCardPart(
          rawPart,
          `${definitionPath}[${partIndex}]`,
          issues,
          false,
        );

        if (parsedPart) {
          parsedParts.push(parsedPart);
        }
      }

      sharedParts[definitionId] = parsedParts;
      continue;
    }

    const parsedPart = parseInlineTaskCardPart(rawDefinition, definitionPath, issues, false);

    if (parsedPart) {
      sharedParts[definitionId] = parsedPart;
    }
  }

  return {
    parts: sharedParts,
  };
}

export function getTaskDetailParts(
  task: TaskDefinition,
  sections?: FlowSections,
): TaskCardPart[] {
  const parts: TaskCardPart[] = [];

  if (task.description) {
    parts.push({
      type: "text",
      text: task.description,
      copyable: true,
    });
  }

  for (const part of task.parts) {
    if ("ref" in part) {
      const sharedPart = sections?.parts[part.ref];

      if (!sharedPart) {
        continue;
      }

      if (Array.isArray(sharedPart)) {
        parts.push(...sharedPart);
      } else {
        parts.push(sharedPart);
      }

      continue;
    }

    parts.push(part);
  }

  return parts;
}

export function parseFlowYaml(source: string): FlowParseResult {
  const issues: string[] = [];
  const document = parseDocument(source);

  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => error.message),
    };
  }

  const data = document.toJS();
  const root = asRecord(data);

  if (!root) {
    return {
      ok: false,
      issues: ["YAML のルートはオブジェクトである必要があります。"],
    };
  }

  const id = root.id;
  const title = root.title;
  const sections = parseSharedTaskCardPartDefinitions(root.sections, issues);
  const rawTasks = root.tasks;

  if (typeof id !== "string" || id.trim() === "") {
    issues.push("flow.id は必須の文字列です。");
  }

  if (typeof title !== "string" || title.trim() === "") {
    issues.push("flow.title は必須の文字列です。");
  }

  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    issues.push("tasks は1件以上の配列である必要があります。");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const flowId = id as string;
  const flowTitle = title as string;
  const taskList = rawTasks as unknown[];
  const seenIds = new Set<string>();
  const tasks: TaskDefinition[] = [];

  for (const [index, rawTask] of taskList.entries()) {
    const task = asRecord(rawTask);

    if (!task) {
      issues.push(`tasks[${index}] はオブジェクトである必要があります。`);
      continue;
    }

    const taskId = task.id;
    const taskTitle = task.title;
    const taskDescription = task.description;
    const estimateMinutes = task.estimate_minutes;
    const dependsOn = asStringList(task.depends_on);
    const subtasks = parseSubtasks(task.subtasks, index, issues);
    const parts = parseTaskCardParts(task.parts, index, issues);

    if (typeof taskId !== "string" || taskId.trim() === "") {
      issues.push(`tasks[${index}].id は必須の文字列です。`);
      continue;
    }

    if (seenIds.has(taskId)) {
      issues.push(`tasks[${index}].id "${taskId}" が重複しています。`);
      continue;
    }

    if (typeof taskTitle !== "string" || taskTitle.trim() === "") {
      issues.push(`tasks[${index}].title は必須の文字列です。`);
      continue;
    }

    if (
      taskDescription !== undefined &&
      typeof taskDescription !== "string"
    ) {
      issues.push(`tasks[${index}].description は文字列である必要があります。`);
      continue;
    }

    if (
      estimateMinutes !== undefined &&
      asNonNegativeInteger(estimateMinutes) === undefined
    ) {
      issues.push(`tasks[${index}].estimate_minutes は0以上の整数である必要があります。`);
      continue;
    }

    for (const [partIndex, part] of parts.entries()) {
      if ("ref" in part && !sections?.parts[part.ref]) {
        issues.push(
          `tasks[${index}].parts[${partIndex}].ref "${part.ref}" は sections.parts に定義されていません。`,
        );
      }
    }

    seenIds.add(taskId);
    tasks.push({
      id: taskId,
      title: taskTitle,
      description: taskDescription,
      estimateMinutes: asNonNegativeInteger(estimateMinutes),
      dependsOn,
      subtasks,
      parts,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const taskIds = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        issues.push(
          `task "${task.id}" が存在しない依存先 "${dependency}" を参照しています。`,
        );
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  if (detectCycle(tasks)) {
    return {
      ok: false,
      issues: ["循環参照を検出しました。依存関係は DAG である必要があります。"],
    };
  }

  return {
    ok: true,
    flow: {
      id: flowId,
      title: flowTitle,
      sections,
      tasks,
    },
  };
}

function detectCycle(tasks: TaskDefinition[]): boolean {
  const status = new Map<string, "visiting" | "done">();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const visit = (taskId: string): boolean => {
    const current = status.get(taskId);

    if (current === "visiting") {
      return true;
    }

    if (current === "done") {
      return false;
    }

    status.set(taskId, "visiting");
    const task = byId.get(taskId);

    if (!task) {
      return false;
    }

    for (const dependency of task.dependsOn) {
      if (visit(dependency)) {
        return true;
      }
    }

    status.set(taskId, "done");
    return false;
  };

  return tasks.some((task) => visit(task.id));
}

export function createInitialRuntimeState(
  flow: FlowDefinition,
  savedState?: TaskRuntimeState,
): TaskRuntimeState {
  const initialState: TaskRuntimeState = {};

  for (const task of flow.tasks) {
    const candidate = savedState?.[task.id];
    const savedStatus = candidate?.status;
    const savedSubtasks = candidate?.subtasks;
    const savedActualElapsedMs = candidate?.actualElapsedMs;
    const savedTimerState = candidate?.timerState;
    const savedStartedAt = candidate?.startedAt;

    initialState[task.id] = {
      status: STATUS_ORDER.includes(savedStatus as TaskStatus)
        ? (savedStatus as TaskStatus)
        : "todo",
      subtasks: task.subtasks.map((_, index) =>
        Array.isArray(savedSubtasks) && typeof savedSubtasks[index] === "boolean"
          ? savedSubtasks[index]
          : false,
      ),
      actualElapsedMs:
        typeof savedActualElapsedMs === "number" && savedActualElapsedMs >= 0
          ? savedActualElapsedMs
          : 0,
      timerState:
        savedTimerState === "running"
          ? typeof savedStartedAt === "number" && Number.isFinite(savedStartedAt)
            ? "running"
            : "idle"
          : TIMER_STATE_ORDER.includes(savedTimerState as TaskTimerState)
            ? (savedTimerState as TaskTimerState)
            : "idle",
      startedAt:
        savedTimerState === "running" &&
        typeof savedStartedAt === "number" &&
        Number.isFinite(savedStartedAt)
          ? savedStartedAt
          : null,
    };
  }

  return initialState;
}

function encodeStorageSegment(value: string): string {
  return encodeURIComponent(value);
}

function parseRuntimeEntry(value: unknown): TaskRuntimeEntry | undefined {
  if (STATUS_ORDER.includes(value as TaskStatus)) {
    return {
      status: value as TaskStatus,
      subtasks: [],
      actualElapsedMs: 0,
      timerState: "idle",
      startedAt: null,
    };
  }

  const entry = asRecord(value);

  if (!entry) {
    return undefined;
  }

  const status = entry.status;
  const subtasks = entry.subtasks;
  const actualElapsedMs = entry.actualElapsedMs;
  const timerState = entry.timerState;
  const startedAt = entry.startedAt;
  const normalizedTimerState = TIMER_STATE_ORDER.includes(timerState as TaskTimerState)
    ? (timerState as TaskTimerState)
    : "idle";

  return {
    status: STATUS_ORDER.includes(status as TaskStatus)
      ? (status as TaskStatus)
      : "todo",
    subtasks: Array.isArray(subtasks)
      ? subtasks.map((subtask) => subtask === true)
      : [],
    actualElapsedMs:
      typeof actualElapsedMs === "number" && actualElapsedMs >= 0
        ? actualElapsedMs
        : 0,
    timerState: normalizedTimerState,
    startedAt:
      normalizedTimerState === "running" &&
      typeof startedAt === "number" &&
      Number.isFinite(startedAt)
        ? startedAt
        : null,
  };
}

function parseRuntimeState(value: unknown): TaskRuntimeState | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const runtimeState: TaskRuntimeState = {};

  for (const [taskId, entryValue] of Object.entries(record)) {
    const parsedEntry = parseRuntimeEntry(entryValue);

    if (!parsedEntry) {
      continue;
    }

    runtimeState[taskId] = parsedEntry;
  }

  return runtimeState;
}

function parsePersistedRuntimeState(value: unknown): PersistedRuntimeState | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  if (record.schemaVersion !== STORAGE_SCHEMA_VERSION) {
    return undefined;
  }

  if (
    typeof record.flowId !== "string" ||
    typeof record.fileName !== "string" ||
    typeof record.flowRevision !== "string" ||
    typeof record.savedAt !== "number" ||
    !Number.isFinite(record.savedAt)
  ) {
    return undefined;
  }

  const runtimeState = parseRuntimeState(record.runtimeState);

  if (!runtimeState) {
    return undefined;
  }

  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    flowId: record.flowId,
    fileName: record.fileName,
    flowRevision: record.flowRevision,
    savedAt: record.savedAt,
    runtimeState,
  };
}

type StoredRuntimeReadResult =
  | {
      status: "empty";
    }
  | {
      status: "current";
      persistedState: PersistedRuntimeState;
    }
  | {
      status: "legacy";
      runtimeState: TaskRuntimeState;
    }
  | {
      status: "invalid";
      source: "current" | "legacy";
    };

function readStoredRuntimeState(
  flowId: string,
  fileName: string,
): StoredRuntimeReadResult {
  if (typeof window === "undefined") {
    return { status: "empty" };
  }

  const currentRaw = window.localStorage.getItem(getStorageKey(flowId, fileName));

  if (currentRaw) {
    try {
      const parsed = JSON.parse(currentRaw) as unknown;
      const persistedState = parsePersistedRuntimeState(parsed);

      if (!persistedState) {
        return {
          status: "invalid",
          source: "current",
        };
      }

      return {
        status: "current",
        persistedState,
      };
    } catch {
      return {
        status: "invalid",
        source: "current",
      };
    }
  }

  const legacyRaw = window.localStorage.getItem(getLegacyStorageKey(flowId));

  if (!legacyRaw) {
    return { status: "empty" };
  }

  try {
    const parsed = JSON.parse(legacyRaw) as unknown;
    const runtimeState = parseRuntimeState(parsed);

    if (!runtimeState) {
      return {
        status: "invalid",
        source: "legacy",
      };
    }

    return {
      status: "legacy",
      runtimeState,
    };
  } catch {
    return {
      status: "invalid",
      source: "legacy",
    };
  }
}

function getMatchedTaskCount(
  flow: FlowDefinition,
  runtimeState: TaskRuntimeState,
): number {
  const taskIds = new Set(flow.tasks.map((task) => task.id));
  return Object.keys(runtimeState).filter((taskId) => taskIds.has(taskId)).length;
}

function hasUnrecoverableRunningTimer(
  flow: FlowDefinition,
  runtimeState: TaskRuntimeState,
): boolean {
  const taskIds = new Set(flow.tasks.map((task) => task.id));

  return Object.entries(runtimeState).some(([taskId, entry]) => {
    if (entry.timerState !== "running") {
      return false;
    }

    return !taskIds.has(taskId) || entry.startedAt === null;
  });
}

function migrateRuntimeState(
  flow: FlowDefinition,
  savedState: TaskRuntimeState,
): RuntimeHydrationResult {
  const initialRuntimeState = createInitialRuntimeState(flow);
  const savedTaskCount = Object.keys(savedState).length;

  if (savedTaskCount === 0) {
    return {
      status: "migrated",
      runtimeState: initialRuntimeState,
      message: "保存済みデータを確認しましたが、復元対象の進捗はありませんでした。",
    };
  }

  if (hasUnrecoverableRunningTimer(flow, savedState)) {
    return {
      status: "resetRequired",
      runtimeState: initialRuntimeState,
      message:
        "保存済みの計測中タスクを安全に復元できません。このファイルの進捗をリセットして続行してください。",
    };
  }

  if (getMatchedTaskCount(flow, savedState) === 0) {
    return {
      status: "resetRequired",
      runtimeState: initialRuntimeState,
      message:
        "ファイル構造の変更が大きく、既存の進捗を安全に引き継げません。このファイルの進捗をリセットして続行してください。",
    };
  }

  return {
    status: "migrated",
    runtimeState: createInitialRuntimeState(flow, savedState),
    message: "ファイル構造の変更を検出したため、同じ task.id の進捗だけを引き継ぎました。",
  };
}

export function getStorageKey(flowId: string, fileName: string): string {
  return `${STORAGE_PREFIX}${encodeStorageSegment(flowId)}:${encodeStorageSegment(fileName)}`;
}

export function getLegacyStorageKey(flowId: string): string {
  return `${LEGACY_STORAGE_PREFIX}${flowId}`;
}

export function hydrateRuntimeState(params: {
  flow: FlowDefinition;
  fileName: string;
  flowRevision: string;
}): RuntimeHydrationResult {
  const { flow, fileName, flowRevision } = params;
  const initialRuntimeState = createInitialRuntimeState(flow);
  const storedState = readStoredRuntimeState(flow.id, fileName);

  if (storedState.status === "empty") {
    return {
      status: "empty",
      runtimeState: initialRuntimeState,
    };
  }

  if (storedState.status === "invalid") {
    return {
      status: "resetRequired",
      runtimeState: initialRuntimeState,
      message:
        storedState.source === "current"
          ? "保存済みデータを読み込めませんでした。このファイルの進捗をリセットして続行してください。"
          : "旧形式の保存済みデータを読み込めませんでした。このファイルの進捗をリセットして続行してください。",
      shouldClearLegacyKey: storedState.source === "legacy",
    };
  }

  if (storedState.status === "current") {
    const { persistedState } = storedState;

    if (persistedState.flowId !== flow.id || persistedState.fileName !== fileName) {
      return {
        status: "resetRequired",
        runtimeState: initialRuntimeState,
        message:
          "保存済みデータの識別情報が一致しません。このファイルの進捗をリセットして続行してください。",
      };
    }

    if (hasUnrecoverableRunningTimer(flow, persistedState.runtimeState)) {
      return {
        status: "resetRequired",
        runtimeState: initialRuntimeState,
        message:
          "保存済みの計測中タスクを安全に復元できません。このファイルの進捗をリセットして続行してください。",
      };
    }

    if (persistedState.flowRevision === flowRevision) {
      return {
        status: "applied",
        runtimeState: createInitialRuntimeState(flow, persistedState.runtimeState),
      };
    }

    return migrateRuntimeState(flow, persistedState.runtimeState);
  }

  const migratedState = migrateRuntimeState(flow, storedState.runtimeState);

  return {
    ...migratedState,
    shouldClearLegacyKey: true,
  };
}

export function writeRuntimeState(
  flowId: string,
  fileName: string,
  flowRevision: string,
  state: TaskRuntimeState,
): void {
  if (typeof window === "undefined") {
    return;
  }

  const persistedState: PersistedRuntimeState = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    flowId,
    fileName,
    flowRevision,
    savedAt: Date.now(),
    runtimeState: state,
  };

  window.localStorage.setItem(
    getStorageKey(flowId, fileName),
    JSON.stringify(persistedState),
  );
}

export function clearRuntimeState(flowId: string, fileName: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(getStorageKey(flowId, fileName));
}

export function clearLegacyRuntimeState(flowId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(getLegacyStorageKey(flowId));
}

export function getReadyTasks(
  flow: FlowDefinition,
  runtimeState: TaskRuntimeState,
): TaskDefinition[] {
  return flow.tasks.filter((task) => {
    if (runtimeState[task.id]?.status === "done") {
      return false;
    }

    return task.dependsOn.every(
      (dependency) => runtimeState[dependency]?.status === "done",
    );
  });
}

export function getMissingDependencies(
  task: TaskDefinition,
  runtimeState: TaskRuntimeState,
): string[] {
  return task.dependsOn.filter(
    (dependency) => runtimeState[dependency]?.status !== "done",
  );
}

export function isTaskBlocked(
  task: TaskDefinition,
  runtimeState: TaskRuntimeState,
): boolean {
  const runtimeEntry = runtimeState[task.id];

  if (!runtimeEntry || runtimeEntry.status !== "todo") {
    return false;
  }

  return getMissingDependencies(task, runtimeState).length > 0;
}

export function getTaskCounts(runtimeState: TaskRuntimeState): Record<TaskStatus, number> {
  return Object.values(runtimeState).reduce(
    (accumulator, entry) => {
      accumulator[entry.status] += 1;
      return accumulator;
    },
    { todo: 0, doing: 0, done: 0 } as Record<TaskStatus, number>,
  );
}

export function getSubtaskProgress(task: TaskDefinition, entry: TaskRuntimeEntry) {
  const total = task.subtasks.length;
  const completed = entry.subtasks.filter(Boolean).length;

  return {
    total,
    completed,
  };
}

export function getRunningTaskId(runtimeState: TaskRuntimeState): string | null {
  for (const [taskId, entry] of Object.entries(runtimeState)) {
    if (entry.timerState === "running") {
      return taskId;
    }
  }

  return null;
}

export function getEffectiveElapsedMs(
  entry: TaskRuntimeEntry,
  now = Date.now(),
): number {
  if (entry.timerState !== "running" || entry.startedAt === null) {
    return entry.actualElapsedMs;
  }

  return entry.actualElapsedMs + Math.max(0, now - entry.startedAt);
}

export function formatElapsedMs(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}時間 ${minutes}分 ${seconds}秒`;
  }

  if (minutes > 0) {
    return `${minutes}分 ${seconds}秒`;
  }

  return `${seconds}秒`;
}

function findNearestAvailableRow(
  usedRows: Set<number>,
  preferredRow: number,
): number {
  const baseRow = Math.max(0, preferredRow);

  if (!usedRows.has(baseRow)) {
    return baseRow;
  }

  for (let distance = 1; distance <= usedRows.size + 1; distance += 1) {
    const lowerRow = baseRow + distance;

    if (!usedRows.has(lowerRow)) {
      return lowerRow;
    }

    const upperRow = baseRow - distance;

    if (upperRow >= 0 && !usedRows.has(upperRow)) {
      return upperRow;
    }
  }

  return baseRow + usedRows.size + 1;
}

export function buildGraphLayout(flow: FlowDefinition): GraphLayout {
  const byId = new Map(flow.tasks.map((task) => [task.id, task]));
  const depthCache = new Map<string, number>();
  const yamlIndexById = new Map(flow.tasks.map((task, index) => [task.id, index]));
  const dependentsById = new Map<string, TaskDefinition[]>();
  const primaryDependentsById = new Map<string, string[]>();
  const rowsByDepth = new Map<number, Set<number>>();

  const getDepth = (taskId: string): number => {
    const cached = depthCache.get(taskId);

    if (cached !== undefined) {
      return cached;
    }

    const task = byId.get(taskId);

    if (!task || task.dependsOn.length === 0) {
      depthCache.set(taskId, 0);
      return 0;
    }

    const depth = Math.max(...task.dependsOn.map(getDepth)) + 1;
    depthCache.set(taskId, depth);
    return depth;
  };

  for (const task of flow.tasks) {
    dependentsById.set(task.id, []);
    primaryDependentsById.set(task.id, []);
  }

  for (const task of flow.tasks) {
    for (const dependency of task.dependsOn) {
      const dependents = dependentsById.get(dependency);

      if (dependents) {
        dependents.push(task);
      }
    }

    const primaryDependency = task.dependsOn[0];

    if (primaryDependency) {
      primaryDependentsById.get(primaryDependency)?.push(task.id);
    }
  }

  const tasksByDepth = new Map<number, TaskDefinition[]>();
  const rowById = new Map<string, number>();
  let nextRootRow = 0;

  for (const task of flow.tasks) {
    const depth = getDepth(task.id);
    const tasks = tasksByDepth.get(depth) ?? [];
    tasks.push(task);
    tasksByDepth.set(depth, tasks);
  }

  const maxDepth = Math.max(...flow.tasks.map((task) => depthCache.get(task.id) ?? 0), 0);

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const tasks = tasksByDepth.get(depth) ?? [];
    const usedRows = rowsByDepth.get(depth) ?? new Set<number>();

    const orderedTasks = tasks
      .map((task) => {
        const primaryDependency = task.dependsOn[0];
        const primaryRow =
          primaryDependency !== undefined ? rowById.get(primaryDependency) : undefined;
        const dependentCount = dependentsById.get(task.id)?.length ?? 0;
        const hasPrimaryDependents = (primaryDependentsById.get(task.id)?.length ?? 0) > 0;
        let preferredRow = primaryRow ?? nextRootRow;

        if (task.dependsOn.length === 0) {
          preferredRow = nextRootRow;
        } else if (task.dependsOn.length > 1) {
          preferredRow = primaryRow ?? preferredRow;
        } else if (dependentCount > 0 && !hasPrimaryDependents) {
          preferredRow = (primaryRow ?? preferredRow) + 1;
        }

        return {
          task,
          preferredRow,
          primaryRow: primaryRow ?? preferredRow,
          yamlIndex: yamlIndexById.get(task.id) ?? 0,
          dependentCount,
          hasPrimaryDependents,
        };
      })
      .sort((left, right) => {
        if (left.preferredRow !== right.preferredRow) {
          return left.preferredRow - right.preferredRow;
        }

        if (left.hasPrimaryDependents !== right.hasPrimaryDependents) {
          return left.hasPrimaryDependents ? -1 : 1;
        }

        if (left.dependentCount !== right.dependentCount) {
          return right.dependentCount - left.dependentCount;
        }

        if (left.primaryRow !== right.primaryRow) {
          return left.primaryRow - right.primaryRow;
        }

        return left.yamlIndex - right.yamlIndex;
      });

    for (const entry of orderedTasks) {
      const row = findNearestAvailableRow(usedRows, entry.preferredRow);
      usedRows.add(row);
      rowById.set(entry.task.id, row);

      if (entry.task.dependsOn.length === 0) {
        nextRootRow = row + 1;
      }
    }

    rowsByDepth.set(depth, usedRows);
  }

  const nodes = flow.tasks.map((task) => {
    const depth = depthCache.get(task.id) ?? 0;
    const row = rowById.get(task.id) ?? 0;

    return {
      ...task,
      depth,
      row,
      x: PADDING_X + depth * COLUMN_WIDTH,
      y: PADDING_Y + row * ROW_HEIGHT,
    };
  });

  const width =
    PADDING_X * 2 +
    ((Math.max(...nodes.map((node) => node.depth), 0) + 1) * COLUMN_WIDTH || 0);
  const height =
    PADDING_Y * 2 +
    ((Math.max(...nodes.map((node) => node.row), 0) + 1) * ROW_HEIGHT || 0);

  return {
    nodes,
    edges: nodes.flatMap((task) =>
      task.dependsOn.map((dependency) => ({
        from: dependency,
        to: task.id,
      })),
    ),
    width,
    height,
  };
}

export function getTaskPath(
  from: PositionedTask,
  to: PositionedTask,
): string {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const handleOffset = Math.max((endX - startX) / 2, 32);

  return [
    `M ${startX} ${startY}`,
    `C ${startX + handleOffset} ${startY}, ${endX - handleOffset} ${endY}, ${endX} ${endY}`,
  ].join(" ");
}
