import { describe, it, expect } from "vitest";
import {
  parseFlowYaml,
  getTaskDetailParts,
  createInitialRuntimeState,
  getStorageKey,
  getLegacyStorageKey,
  getReadyTasks,
  getMissingDependencies,
  isTaskBlocked,
  getTaskCounts,
  getSubtaskProgress,
  getRunningTaskId,
  getEffectiveElapsedMs,
  formatElapsedMs,
  buildGraphLayout,
  getTaskPath,
  type FlowDefinition,
  type TaskDefinition,
  type TaskRuntimeState,
  type TaskRuntimeEntry,
  type TaskStatus,
  type FlowSections,
  type PositionedTask,
} from "../task-flow";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMinimalYaml(overrides: string = ""): string {
  return `
id: flow-1
title: Test Flow
tasks:
  - id: task-1
    title: Task One
${overrides}
`.trim();
}

function makeFlow(taskOverrides: Partial<TaskDefinition>[] = []): FlowDefinition {
  const defaultTask: TaskDefinition = {
    id: "task-1",
    title: "Task One",
    dependsOn: [],
    subtasks: [],
    parts: [],
  };
  return {
    id: "flow-1",
    title: "Test Flow",
    tasks: taskOverrides.map((o, i) => ({ ...defaultTask, id: `task-${i + 1}`, ...o })),
  };
}

function makeEntry(overrides: Partial<TaskRuntimeEntry> = {}): TaskRuntimeEntry {
  return {
    status: "todo",
    subtasks: [],
    actualElapsedMs: 0,
    timerState: "idle",
    startedAt: null,
    ...overrides,
  };
}

// ─── parseFlowYaml ──────────────────────────────────────────────────────────

describe("parseFlowYaml", () => {
  it("有効なYAMLを正常にパースする", () => {
    const result = parseFlowYaml(makeMinimalYaml());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.id).toBe("flow-1");
      expect(result.flow.title).toBe("Test Flow");
      expect(result.flow.tasks).toHaveLength(1);
    }
  });

  it("複数のタスクと依存関係をパースする", () => {
    const yaml = `
id: flow-multi
title: Multi Task Flow
tasks:
  - id: t1
    title: Task 1
  - id: t2
    title: Task 2
    depends_on: [t1]
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.tasks).toHaveLength(2);
      expect(result.flow.tasks[1].dependsOn).toEqual(["t1"]);
    }
  });

  it("estimate_minutesとsubtasksをパースする", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    estimate_minutes: 30
    subtasks:
      - title: Sub 1
      - title: Sub 2
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.tasks[0].estimateMinutes).toBe(30);
      expect(result.flow.tasks[0].subtasks).toHaveLength(2);
      expect(result.flow.tasks[0].subtasks[0].title).toBe("Sub 1");
    }
  });

  it("textパーツをパースする", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    parts:
      - type: text
        text: "Hello"
        copyable: false
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const part = result.flow.tasks[0].parts[0];
      expect(part).toEqual({ type: "text", text: "Hello", copyable: false });
    }
  });

  it("linkパーツをパースする", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    parts:
      - type: link
        label: Open
        url: https://example.com
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const part = result.flow.tasks[0].parts[0];
      expect(part).toEqual({ type: "link", label: "Open", url: "https://example.com", copyable: true });
    }
  });

  it("sectionsの共有パーツを含むYAMLをパースする", () => {
    const yaml = `
id: flow-1
title: Test
sections:
  parts:
    shared-info:
      type: text
      text: "Shared text"
tasks:
  - id: t1
    title: Task
    parts:
      - ref: shared-info
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.sections?.parts["shared-info"]).toMatchObject({ type: "text", text: "Shared text" });
    }
  });

  it("flow.idが欠落している場合はエラーを返す", () => {
    const yaml = `
title: Test Flow
tasks:
  - id: t1
    title: Task
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("flow.id"))).toBe(true);
    }
  });

  it("flow.titleが欠落している場合はエラーを返す", () => {
    const yaml = `
id: flow-1
tasks:
  - id: t1
    title: Task
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("flow.title"))).toBe(true);
    }
  });

  it("tasksが空配列の場合はエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks: []
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("tasks"))).toBe(true);
    }
  });

  it("タスクIDが重複している場合はエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: dup
    title: Task A
  - id: dup
    title: Task B
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("重複"))).toBe(true);
    }
  });

  it("存在しないタスクへの依存はエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    depends_on: [nonexistent]
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("nonexistent"))).toBe(true);
    }
  });

  it("循環依存がある場合はエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task 1
    depends_on: [t2]
  - id: t2
    title: Task 2
    depends_on: [t1]
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("循環参照"))).toBe(true);
    }
  });

  it("不正なYAML構文はエラーを返す", () => {
    const result = parseFlowYaml("id: [invalid: yaml: {{{");
    expect(result.ok).toBe(false);
  });

  it("ルートがオブジェクトでない場合はエラーを返す", () => {
    const result = parseFlowYaml("- just a list");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("ルート"))).toBe(true);
    }
  });

  it("estimate_minutesが負の値の場合はエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    estimate_minutes: -5
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("estimate_minutes"))).toBe(true);
    }
  });

  it("linkパーツのURLがhttpでない場合はエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    parts:
      - type: link
        label: Bad
        url: ftp://example.com
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("url"))).toBe(true);
    }
  });

  it("partsにrefとtypeを同時に指定するとエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    parts:
      - ref: some-ref
        type: text
        text: conflict
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("同時に指定"))).toBe(true);
    }
  });

  it("sectionsで未定義のrefを使うとエラーを返す", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: t1
    title: Task
    parts:
      - ref: undefined-ref
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("undefined-ref"))).toBe(true);
    }
  });

  it("3段階の直線的な依存関係をパースする", () => {
    const yaml = `
id: flow-1
title: Test
tasks:
  - id: a
    title: A
  - id: b
    title: B
    depends_on: [a]
  - id: c
    title: C
    depends_on: [b]
`.trim();
    const result = parseFlowYaml(yaml);
    expect(result.ok).toBe(true);
  });
});

// ─── getTaskDetailParts ──────────────────────────────────────────────────────

describe("getTaskDetailParts", () => {
  const baseTask: TaskDefinition = {
    id: "t1",
    title: "Task",
    dependsOn: [],
    subtasks: [],
    parts: [],
  };

  it("descriptionがある場合は最初にテキストパーツとして追加する", () => {
    const task = { ...baseTask, description: "Some description" };
    const parts = getTaskDetailParts(task);
    expect(parts[0]).toEqual({ type: "text", text: "Some description", copyable: true });
  });

  it("descriptionがない場合はテキストパーツを追加しない", () => {
    const parts = getTaskDetailParts(baseTask);
    expect(parts).toHaveLength(0);
  });

  it("インラインのtextパーツをそのまま返す", () => {
    const task = {
      ...baseTask,
      parts: [{ type: "text" as const, text: "Inline", copyable: false }],
    };
    const parts = getTaskDetailParts(task);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: "text", text: "Inline", copyable: false });
  });

  it("refがsectionsに存在する場合は共有パーツに解決する", () => {
    const sections: FlowSections = {
      parts: {
        "shared-part": { type: "text", text: "Shared", copyable: true },
      },
    };
    const task = { ...baseTask, parts: [{ ref: "shared-part" }] };
    const parts = getTaskDetailParts(task, sections);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: "text", text: "Shared", copyable: true });
  });

  it("refが配列の共有パーツを展開する", () => {
    const sections: FlowSections = {
      parts: {
        "multi-part": [
          { type: "text", text: "Part A", copyable: true },
          { type: "text", text: "Part B", copyable: true },
        ],
      },
    };
    const task = { ...baseTask, parts: [{ ref: "multi-part" }] };
    const parts = getTaskDetailParts(task, sections);
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("text");
  });

  it("refが存在しない場合はそのパーツをスキップする", () => {
    const task = { ...baseTask, parts: [{ ref: "nonexistent" }] };
    const parts = getTaskDetailParts(task);
    expect(parts).toHaveLength(0);
  });

  it("sectionsがundefinedの場合はrefをスキップする", () => {
    const task = { ...baseTask, parts: [{ ref: "some-ref" }] };
    const parts = getTaskDetailParts(task, undefined);
    expect(parts).toHaveLength(0);
  });

  it("descriptionとinlineパーツを組み合わせる", () => {
    const task = {
      ...baseTask,
      description: "Desc",
      parts: [{ type: "link" as const, label: "Link", url: "https://example.com", copyable: true }],
    };
    const parts = getTaskDetailParts(task);
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("link");
  });
});

// ─── createInitialRuntimeState ───────────────────────────────────────────────

describe("createInitialRuntimeState", () => {
  it("全タスクをtodoステータスで初期化する", () => {
    const flow = makeFlow([{}, {}]);
    const state = createInitialRuntimeState(flow);
    expect(Object.keys(state)).toHaveLength(2);
    expect(state["task-1"].status).toBe("todo");
    expect(state["task-2"].status).toBe("todo");
  });

  it("subtasksをfalseで初期化する", () => {
    const flow = makeFlow([{ subtasks: [{ title: "Sub 1" }, { title: "Sub 2" }] }]);
    const state = createInitialRuntimeState(flow);
    expect(state["task-1"].subtasks).toEqual([false, false]);
  });

  it("タイマー状態をidleで初期化する", () => {
    const flow = makeFlow([{}]);
    const state = createInitialRuntimeState(flow);
    expect(state["task-1"].timerState).toBe("idle");
    expect(state["task-1"].startedAt).toBeNull();
    expect(state["task-1"].actualElapsedMs).toBe(0);
  });

  it("保存済み状態を正しく復元する", () => {
    const flow = makeFlow([{}]);
    const savedState: TaskRuntimeState = {
      "task-1": {
        status: "done",
        subtasks: [],
        actualElapsedMs: 5000,
        timerState: "idle",
        startedAt: null,
      },
    };
    const state = createInitialRuntimeState(flow, savedState);
    expect(state["task-1"].status).toBe("done");
    expect(state["task-1"].actualElapsedMs).toBe(5000);
  });

  it("保存済みのsubtask状態を復元する", () => {
    const flow = makeFlow([{ subtasks: [{ title: "Sub 1" }, { title: "Sub 2" }] }]);
    const savedState: TaskRuntimeState = {
      "task-1": {
        status: "doing",
        subtasks: [true, false],
        actualElapsedMs: 0,
        timerState: "idle",
        startedAt: null,
      },
    };
    const state = createInitialRuntimeState(flow, savedState);
    expect(state["task-1"].subtasks).toEqual([true, false]);
  });

  it("不正なステータス値はtodoにフォールバックする", () => {
    const flow = makeFlow([{}]);
    const savedState: TaskRuntimeState = {
      "task-1": {
        status: "invalid" as unknown as TaskStatus,
        subtasks: [],
        actualElapsedMs: 0,
        timerState: "idle",
        startedAt: null,
      },
    };
    const state = createInitialRuntimeState(flow, savedState);
    expect(state["task-1"].status).toBe("todo");
  });

  it("running状態のタイマーをstartedAtがない場合はidleにフォールバックする", () => {
    const flow = makeFlow([{}]);
    const savedState: TaskRuntimeState = {
      "task-1": {
        status: "doing",
        subtasks: [],
        actualElapsedMs: 0,
        timerState: "running",
        startedAt: null,
      },
    };
    const state = createInitialRuntimeState(flow, savedState);
    expect(state["task-1"].timerState).toBe("idle");
    expect(state["task-1"].startedAt).toBeNull();
  });

  it("running状態のタイマーをstartedAtがある場合は復元する", () => {
    const flow = makeFlow([{}]);
    const now = Date.now();
    const savedState: TaskRuntimeState = {
      "task-1": {
        status: "doing",
        subtasks: [],
        actualElapsedMs: 1000,
        timerState: "running",
        startedAt: now,
      },
    };
    const state = createInitialRuntimeState(flow, savedState);
    expect(state["task-1"].timerState).toBe("running");
    expect(state["task-1"].startedAt).toBe(now);
  });

  it("負のactualElapsedMsは0にフォールバックする", () => {
    const flow = makeFlow([{}]);
    const savedState: TaskRuntimeState = {
      "task-1": {
        status: "todo",
        subtasks: [],
        actualElapsedMs: -100,
        timerState: "idle",
        startedAt: null,
      },
    };
    const state = createInitialRuntimeState(flow, savedState);
    expect(state["task-1"].actualElapsedMs).toBe(0);
  });
});

// ─── getStorageKey ───────────────────────────────────────────────────────────

describe("getStorageKey", () => {
  it("正しいプレフィックスとエンコードされたセグメントを含む鍵を生成する", () => {
    const key = getStorageKey("flow-1", "flow.yaml");
    expect(key).toBe("aeterna:task-flow:v2:flow-1:flow.yaml");
  });

  it("特殊文字を含むflowIdをエンコードする", () => {
    const key = getStorageKey("flow/special", "file.yaml");
    expect(key).toContain("flow%2Fspecial");
  });

  it("特殊文字を含むfileNameをエンコードする", () => {
    const key = getStorageKey("flow-1", "path/to/file.yaml");
    expect(key).toContain("path%2Fto%2Ffile.yaml");
  });

  it("異なるflowIdで異なる鍵を生成する", () => {
    const key1 = getStorageKey("flow-a", "file.yaml");
    const key2 = getStorageKey("flow-b", "file.yaml");
    expect(key1).not.toBe(key2);
  });

  it("異なるfileNameで異なる鍵を生成する", () => {
    const key1 = getStorageKey("flow-1", "file-a.yaml");
    const key2 = getStorageKey("flow-1", "file-b.yaml");
    expect(key1).not.toBe(key2);
  });
});

// ─── getLegacyStorageKey ─────────────────────────────────────────────────────

describe("getLegacyStorageKey", () => {
  it("レガシープレフィックスとflowIdを含む鍵を生成する", () => {
    const key = getLegacyStorageKey("flow-1");
    expect(key).toBe("aeterna:task-flow:flow-1");
  });

  it("flowIdをそのままキーに含める（エンコードなし）", () => {
    const key = getLegacyStorageKey("my/flow");
    expect(key).toBe("aeterna:task-flow:my/flow");
  });

  it("異なるflowIdで異なる鍵を生成する", () => {
    const key1 = getLegacyStorageKey("flow-a");
    const key2 = getLegacyStorageKey("flow-b");
    expect(key1).not.toBe(key2);
  });
});

// ─── getReadyTasks ───────────────────────────────────────────────────────────

describe("getReadyTasks", () => {
  it("依存関係がないタスクはすべてreadyである", () => {
    const flow = makeFlow([{ id: "t1" }, { id: "t2" }]);
    const state: TaskRuntimeState = {
      "t1": makeEntry(),
      "t2": makeEntry(),
    };
    const ready = getReadyTasks(flow, state);
    expect(ready.map((t) => t.id)).toContain("t1");
    expect(ready.map((t) => t.id)).toContain("t2");
  });

  it("doneのタスクはreadyに含まれない", () => {
    const flow = makeFlow([{ id: "t1" }]);
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "done" }),
    };
    const ready = getReadyTasks(flow, state);
    expect(ready).toHaveLength(0);
  });

  it("依存タスクがdoneの場合、依存先タスクはreadyになる", () => {
    const flow = makeFlow([{ id: "t1" }, { id: "t2", dependsOn: ["t1"] }]);
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "done" }),
      "t2": makeEntry(),
    };
    const ready = getReadyTasks(flow, state);
    expect(ready.map((t) => t.id)).toContain("t2");
  });

  it("依存タスクがdoneでない場合、依存先タスクはreadyにならない", () => {
    const flow = makeFlow([{ id: "t1" }, { id: "t2", dependsOn: ["t1"] }]);
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "todo" }),
      "t2": makeEntry(),
    };
    const ready = getReadyTasks(flow, state);
    expect(ready.map((t) => t.id)).not.toContain("t2");
  });

  it("全依存タスクがdoneの場合のみreadyになる（複数依存）", () => {
    const flow = makeFlow([
      { id: "t1" },
      { id: "t2" },
      { id: "t3", dependsOn: ["t1", "t2"] },
    ]);
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "done" }),
      "t2": makeEntry({ status: "doing" }),
      "t3": makeEntry(),
    };
    const ready = getReadyTasks(flow, state);
    expect(ready.map((t) => t.id)).not.toContain("t3");
  });

  it("doingステータスのタスクはreadyに含まれる", () => {
    const flow = makeFlow([{ id: "t1" }]);
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "doing" }),
    };
    const ready = getReadyTasks(flow, state);
    expect(ready.map((t) => t.id)).toContain("t1");
  });
});

// ─── getMissingDependencies ──────────────────────────────────────────────────

describe("getMissingDependencies", () => {
  it("依存関係がない場合は空配列を返す", () => {
    const task: TaskDefinition = { id: "t1", title: "T1", dependsOn: [], subtasks: [], parts: [] };
    const state: TaskRuntimeState = { "t1": makeEntry() };
    expect(getMissingDependencies(task, state)).toEqual([]);
  });

  it("依存タスクがdoneの場合は空配列を返す", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "done" }),
      "t2": makeEntry(),
    };
    expect(getMissingDependencies(task, state)).toEqual([]);
  });

  it("依存タスクがdoneでない場合はそのIDを返す", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "todo" }),
      "t2": makeEntry(),
    };
    expect(getMissingDependencies(task, state)).toEqual(["t1"]);
  });

  it("複数の未完了依存を返す", () => {
    const task: TaskDefinition = { id: "t3", title: "T3", dependsOn: ["t1", "t2"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "doing" }),
      "t2": makeEntry({ status: "todo" }),
      "t3": makeEntry(),
    };
    const missing = getMissingDependencies(task, state);
    expect(missing).toContain("t1");
    expect(missing).toContain("t2");
    expect(missing).toHaveLength(2);
  });

  it("runtimeStateに存在しない依存IDもmissingとして返す", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["ghost"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = { "t2": makeEntry() };
    expect(getMissingDependencies(task, state)).toEqual(["ghost"]);
  });
});

// ─── isTaskBlocked ───────────────────────────────────────────────────────────

describe("isTaskBlocked", () => {
  it("依存関係がないtodoタスクはブロックされていない", () => {
    const task: TaskDefinition = { id: "t1", title: "T1", dependsOn: [], subtasks: [], parts: [] };
    const state: TaskRuntimeState = { "t1": makeEntry({ status: "todo" }) };
    expect(isTaskBlocked(task, state)).toBe(false);
  });

  it("未完了の依存がある場合はブロックされている", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "todo" }),
      "t2": makeEntry({ status: "todo" }),
    };
    expect(isTaskBlocked(task, state)).toBe(true);
  });

  it("全依存がdoneの場合はブロックされていない", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "done" }),
      "t2": makeEntry({ status: "todo" }),
    };
    expect(isTaskBlocked(task, state)).toBe(false);
  });

  it("doingステータスのタスクはブロック判定しない（falseを返す）", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "todo" }),
      "t2": makeEntry({ status: "doing" }),
    };
    expect(isTaskBlocked(task, state)).toBe(false);
  });

  it("doneステータスのタスクはブロック判定しない（falseを返す）", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "todo" }),
      "t2": makeEntry({ status: "done" }),
    };
    expect(isTaskBlocked(task, state)).toBe(false);
  });

  it("runtimeStateにエントリがない場合はfalseを返す", () => {
    const task: TaskDefinition = { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] };
    const state: TaskRuntimeState = {};
    expect(isTaskBlocked(task, state)).toBe(false);
  });
});

// ─── getTaskCounts ───────────────────────────────────────────────────────────

describe("getTaskCounts", () => {
  it("空のruntimeStateで全カウントが0", () => {
    expect(getTaskCounts({})).toEqual({ todo: 0, doing: 0, done: 0 });
  });

  it("各ステータスのタスクを正しくカウントする", () => {
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "todo" }),
      "t2": makeEntry({ status: "doing" }),
      "t3": makeEntry({ status: "done" }),
      "t4": makeEntry({ status: "done" }),
    };
    expect(getTaskCounts(state)).toEqual({ todo: 1, doing: 1, done: 2 });
  });

  it("全タスクがtodoの場合", () => {
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "todo" }),
      "t2": makeEntry({ status: "todo" }),
    };
    expect(getTaskCounts(state)).toEqual({ todo: 2, doing: 0, done: 0 });
  });

  it("全タスクがdoneの場合", () => {
    const state: TaskRuntimeState = {
      "t1": makeEntry({ status: "done" }),
      "t2": makeEntry({ status: "done" }),
      "t3": makeEntry({ status: "done" }),
    };
    expect(getTaskCounts(state)).toEqual({ todo: 0, doing: 0, done: 3 });
  });
});

// ─── getSubtaskProgress ──────────────────────────────────────────────────────

describe("getSubtaskProgress", () => {
  const baseTask: TaskDefinition = {
    id: "t1",
    title: "T1",
    dependsOn: [],
    subtasks: [{ title: "Sub 1" }, { title: "Sub 2" }, { title: "Sub 3" }],
    parts: [],
  };

  it("サブタスクがない場合はtotal=0, completed=0を返す", () => {
    const task = { ...baseTask, subtasks: [] };
    const entry = makeEntry({ subtasks: [] });
    expect(getSubtaskProgress(task, entry)).toEqual({ total: 0, completed: 0 });
  });

  it("全サブタスクが未完了の場合はcompleted=0", () => {
    const entry = makeEntry({ subtasks: [false, false, false] });
    expect(getSubtaskProgress(baseTask, entry)).toEqual({ total: 3, completed: 0 });
  });

  it("一部のサブタスクが完了している場合", () => {
    const entry = makeEntry({ subtasks: [true, false, true] });
    expect(getSubtaskProgress(baseTask, entry)).toEqual({ total: 3, completed: 2 });
  });

  it("全サブタスクが完了している場合", () => {
    const entry = makeEntry({ subtasks: [true, true, true] });
    expect(getSubtaskProgress(baseTask, entry)).toEqual({ total: 3, completed: 3 });
  });
});

// ─── getRunningTaskId ────────────────────────────────────────────────────────

describe("getRunningTaskId", () => {
  it("実行中のタスクがない場合はnullを返す", () => {
    const state: TaskRuntimeState = {
      "t1": makeEntry({ timerState: "idle" }),
      "t2": makeEntry({ timerState: "paused" }),
    };
    expect(getRunningTaskId(state)).toBeNull();
  });

  it("実行中のタスクIDを返す", () => {
    const state: TaskRuntimeState = {
      "t1": makeEntry({ timerState: "idle" }),
      "t2": makeEntry({ timerState: "running" }),
    };
    expect(getRunningTaskId(state)).toBe("t2");
  });

  it("空のruntimeStateでnullを返す", () => {
    expect(getRunningTaskId({})).toBeNull();
  });

  it("最初に見つかったrunningタスクのIDを返す", () => {
    const state: TaskRuntimeState = {
      "t1": makeEntry({ timerState: "running" }),
    };
    expect(getRunningTaskId(state)).toBe("t1");
  });
});

// ─── getEffectiveElapsedMs ───────────────────────────────────────────────────

describe("getEffectiveElapsedMs", () => {
  it("idleの場合はactualElapsedMsをそのまま返す", () => {
    const entry = makeEntry({ actualElapsedMs: 5000, timerState: "idle" });
    expect(getEffectiveElapsedMs(entry, Date.now())).toBe(5000);
  });

  it("pausedの場合はactualElapsedMsをそのまま返す", () => {
    const entry = makeEntry({ actualElapsedMs: 3000, timerState: "paused" });
    expect(getEffectiveElapsedMs(entry, Date.now())).toBe(3000);
  });

  it("startedAtがnullの場合はactualElapsedMsをそのまま返す", () => {
    const entry = makeEntry({ actualElapsedMs: 1000, timerState: "running", startedAt: null });
    expect(getEffectiveElapsedMs(entry, Date.now())).toBe(1000);
  });

  it("runningの場合はactualElapsedMsに経過時間を加算する", () => {
    const startedAt = 1000;
    const now = 4000;
    const entry = makeEntry({ actualElapsedMs: 500, timerState: "running", startedAt });
    expect(getEffectiveElapsedMs(entry, now)).toBe(3500); // 500 + (4000 - 1000)
  });

  it("nowがstartedAtより前の場合は0加算（マイナスにならない）", () => {
    const startedAt = 5000;
    const now = 3000;
    const entry = makeEntry({ actualElapsedMs: 100, timerState: "running", startedAt });
    expect(getEffectiveElapsedMs(entry, now)).toBe(100);
  });
});

// ─── formatElapsedMs ─────────────────────────────────────────────────────────

describe("formatElapsedMs", () => {
  it("0ミリ秒は '0秒' と表示する", () => {
    expect(formatElapsedMs(0)).toBe("0秒");
  });

  it("秒単位のみ表示する（59秒）", () => {
    expect(formatElapsedMs(59_000)).toBe("59秒");
  });

  it("分と秒を表示する（1分30秒）", () => {
    expect(formatElapsedMs(90_000)).toBe("1分 30秒");
  });

  it("分のみ（秒が0の場合）", () => {
    expect(formatElapsedMs(120_000)).toBe("2分 0秒");
  });

  it("時間・分・秒を表示する（1時間2分3秒）", () => {
    expect(formatElapsedMs(3_723_000)).toBe("1時間 2分 3秒");
  });

  it("複数時間を正しく表示する", () => {
    expect(formatElapsedMs(7_200_000)).toBe("2時間 0分 0秒");
  });

  it("負の値は0秒として扱う", () => {
    expect(formatElapsedMs(-1000)).toBe("0秒");
  });

  it("小数点以下を切り捨てる（999msは0秒）", () => {
    expect(formatElapsedMs(999)).toBe("0秒");
  });
});

// ─── buildGraphLayout ────────────────────────────────────────────────────────

describe("buildGraphLayout", () => {
  it("単一タスクの場合、depth=0, row=0でノードを配置する", () => {
    const flow = makeFlow([{ id: "t1" }]);
    const layout = buildGraphLayout(flow);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].depth).toBe(0);
    expect(layout.nodes[0].row).toBe(0);
    expect(layout.edges).toHaveLength(0);
  });

  it("直列依存の場合、depthが正しく計算される", () => {
    const flow: FlowDefinition = {
      id: "flow-1",
      title: "Test",
      tasks: [
        { id: "t1", title: "T1", dependsOn: [], subtasks: [], parts: [] },
        { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] },
        { id: "t3", title: "T3", dependsOn: ["t2"], subtasks: [], parts: [] },
      ],
    };
    const layout = buildGraphLayout(flow);
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    expect(byId["t1"].depth).toBe(0);
    expect(byId["t2"].depth).toBe(1);
    expect(byId["t3"].depth).toBe(2);
  });

  it("エッジがdependsOnに基づいて正しく生成される", () => {
    const flow: FlowDefinition = {
      id: "flow-1",
      title: "Test",
      tasks: [
        { id: "t1", title: "T1", dependsOn: [], subtasks: [], parts: [] },
        { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] },
      ],
    };
    const layout = buildGraphLayout(flow);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toEqual({ from: "t1", to: "t2" });
  });

  it("並列タスクは同じdepthで異なるrowに配置される", () => {
    const flow: FlowDefinition = {
      id: "flow-1",
      title: "Test",
      tasks: [
        { id: "t1", title: "T1", dependsOn: [], subtasks: [], parts: [] },
        { id: "t2", title: "T2", dependsOn: [], subtasks: [], parts: [] },
      ],
    };
    const layout = buildGraphLayout(flow);
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    expect(byId["t1"].depth).toBe(0);
    expect(byId["t2"].depth).toBe(0);
    expect(byId["t1"].row).not.toBe(byId["t2"].row);
  });

  it("widthとheightがパディングを含む正の値である", () => {
    const flow = makeFlow([{ id: "t1" }]);
    const layout = buildGraphLayout(flow);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("x座標がdepthに比例する", () => {
    const flow: FlowDefinition = {
      id: "flow-1",
      title: "Test",
      tasks: [
        { id: "t1", title: "T1", dependsOn: [], subtasks: [], parts: [] },
        { id: "t2", title: "T2", dependsOn: ["t1"], subtasks: [], parts: [] },
      ],
    };
    const layout = buildGraphLayout(flow);
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    expect(byId["t2"].x).toBeGreaterThan(byId["t1"].x);
  });
});

// ─── getTaskPath ─────────────────────────────────────────────────────────────

describe("getTaskPath", () => {
  function makePositionedTask(x: number, y: number): PositionedTask {
    return {
      id: "t",
      title: "T",
      dependsOn: [],
      subtasks: [],
      parts: [],
      depth: 0,
      row: 0,
      x,
      y,
    };
  }

  it("SVGパス文字列を返す（MとCコマンドを含む）", () => {
    const from = makePositionedTask(0, 0);
    const to = makePositionedTask(280, 0);
    const path = getTaskPath(from, to);
    expect(path).toContain("M ");
    expect(path).toContain("C ");
  });

  it("開始点がfrom.x + NODE_WIDTHから始まる", () => {
    const from = makePositionedTask(64, 48);
    const to = makePositionedTask(344, 48);
    const path = getTaskPath(from, to);
    // NODE_WIDTH = 210, NODE_HEIGHT = 172
    expect(path).toContain(`M ${64 + 210}`);
  });

  it("異なる位置でも有効なSVGパスを返す", () => {
    const from = makePositionedTask(0, 100);
    const to = makePositionedTask(500, 300);
    const path = getTaskPath(from, to);
    expect(typeof path).toBe("string");
    expect(path.length).toBeGreaterThan(0);
  });

  it("toがfromより左にあっても有効なパスを返す", () => {
    const from = makePositionedTask(300, 0);
    const to = makePositionedTask(100, 0);
    const path = getTaskPath(from, to);
    expect(path).toContain("M ");
    expect(path).toContain("C ");
  });
});
