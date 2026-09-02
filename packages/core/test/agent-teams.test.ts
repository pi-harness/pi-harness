import { describe, expect, test } from "vitest";
import { dependencyCycle, readyTeamTasks } from "../src/plugins/agent-teams.js";

describe("agent teams dependency graph", () => {
  test("finds a cycle and returns its task ids", () => {
    const tasks = [
      { id: "plan", title: "Plan", assignee: "planner", status: "todo", dependsOn: ["review"] },
      { id: "build", title: "Build", assignee: "builder", status: "todo", dependsOn: ["plan"] },
      { id: "review", title: "Review", assignee: "reviewer", status: "todo", dependsOn: ["build"] },
    ];

    expect(dependencyCycle(tasks)).toEqual(["plan", "review", "build", "plan"]);
  });

  test("returns only tasks whose dependencies are complete", () => {
    const tasks = [
      { id: "plan", title: "Plan", assignee: "planner", status: "done", dependsOn: [] },
      { id: "build", title: "Build", assignee: "builder", status: "todo", dependsOn: ["plan"] },
      { id: "review", title: "Review", assignee: "reviewer", status: "blocked", dependsOn: ["build"] },
    ];

    expect(readyTeamTasks(tasks).map((task) => task.id)).toEqual(["build"]);
  });
});
