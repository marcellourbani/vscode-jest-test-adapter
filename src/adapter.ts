import _ from "lodash";
import * as vscode from "vscode";
import {
  RetireEvent,
  TestAdapter,
  TestEvent,
  TestLoadFinishedEvent,
  TestLoadStartedEvent,
  TestRunFinishedEvent,
  TestRunStartedEvent,
  TestSuiteEvent,
} from "vscode-test-adapter-api";
import { Log } from "vscode-test-adapter-util";
import { emitTestCompleteRootNode, emitTestRunningRootNode } from "./helpers/emitTestCompleteRootNode";
import { filterTree } from "./helpers/filterTree";
import { mapIdToString, mapStringToId } from "./helpers/idMaps";
import { initProjectWorkspace } from "./helpers/initProjectWorkspace";
import { mapJestTestResultsToTestEvents } from "./helpers/mapJestTestResultsToTestEvents";
import { mapTestIdsToTestFilter } from "./helpers/mapTestIdsToTestFilter";
import { mapWorkspaceRootToSuite } from "./helpers/mapTreeToSuite";
import { createWorkspaceRootNode, ProjectRootNode, WorkspaceRootNode } from "./helpers/tree";
import JestManager, { JestTestAdapterOptions } from "./JestManager";
import ProjectManager from "./ProjectManager";
import { IDisposable, ProjectsChangedEvent } from "./types";

type TestStateCompatibleEvent = TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent;

export default class JestTestAdapter implements TestAdapter {
  private isLoadingTests: boolean = false;
  private isRunningTests: boolean = false;
  private disposables: IDisposable[] = [];
  private tree: WorkspaceRootNode = createWorkspaceRootNode();
  private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
  private readonly testStatesEmitter = new vscode.EventEmitter<TestStateCompatibleEvent>();
  private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();
  private readonly jestManager: JestManager;
  private projectManager: ProjectManager | null = null;

  constructor(
    public readonly workspace: vscode.WorkspaceFolder,
    private readonly log: Log,
    private readonly options: JestTestAdapterOptions,
  ) {
    this.jestManager = new JestManager();

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.retireEmitter);
  }

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }

  get testStates(): vscode.Event<TestStateCompatibleEvent> {
    return this.testStatesEmitter.event;
  }

  get retire(): vscode.Event<RetireEvent> {
    return this.retireEmitter.event;
  }

  public async load(): Promise<void> {
    if (this.isLoadingTests) {
      this.log.info("Test load in progress, ignoring subsequent call to load tests.");
      return;
    }

    if (!this.projectManager) {
      try {
        this.projectManager = new ProjectManager(this.workspace, this.log, this.options);
        this.projectManager.projectsChanged(e => this.handleProjectsChanged(e), this);
        this.disposables.push(this.projectManager);
      } catch (error) {
        this.log.error("Attempted to load tests when Project Manager has not been initialized.");
        return;
      }
    }

    this.isLoadingTests = true;
    this.log.info("Loading Jest tests...");

    try {
      this.testsEmitter.fire({ type: "started" });

      const state = await this.projectManager.getTestState();
      if (state) {
        this.tree = state.suite;
        const suite = mapWorkspaceRootToSuite(this.tree);
        this.testsEmitter.fire({ suite, type: "finished" });
      } else {
        this.testsEmitter.fire({ type: "finished" });
      }
    } catch (error) {
      this.log.error("Error loading tests", JSON.stringify(error));
      this.testsEmitter.fire({ type: "finished", errorMessage: JSON.stringify(error) });
    }

    this.retireAllTests();

    this.log.info("Finished loading Jest tests.");
    this.isLoadingTests = false;
  }

  public async run(tests: string[]): Promise<void> {
    if (this.isRunningTests) {
      this.log.info("Test run in progress, ignoring subsequent call to run tests.");
      return;
    }

    this.log.info(`Running Jest tests... ${JSON.stringify(tests)}`);
    this.isRunningTests = true;
    this.testStatesEmitter.fire({ tests, type: "started" });

    try {
      await Promise.all(
        this.determineProjectsAndTestsToRun(tests).map(({ project, testsToRun }) =>
          this.runTestsForProject(project, testsToRun),
        ),
      );
    } catch (error) {
      this.log.error("Error running tests", JSON.stringify(error));
      this.cancel();
    }

    this.log.info("Finished loading Jest tests.");
    this.isRunningTests = false;
    this.testStatesEmitter.fire({ type: "finished" });
  }

  public async debug(tests: string[]): Promise<void> {
    const args = ["--runInBand"];
    const testFilter = mapTestIdsToTestFilter(tests);
    if (testFilter) {
      if (testFilter.testFileNamePattern) {
        args.push("--testPathPattern");
        args.push(testFilter.testFileNamePattern);
      }

      if (testFilter.testNamePattern) {
        args.push("--testNamePattern");
        args.push(testFilter.testNamePattern);
      }
    }

    const debugConfiguration: vscode.DebugConfiguration = {
      args,
      console: this.options.debugOutput,
      cwd: "${workspaceFolder}",
      internalConsoleOptions: "neverOpen",
      name: "vscode-jest-test-adapter",
      program: "${workspaceFolder}/node_modules/jest/bin/jest",
      request: "launch",
      type: "node",
    };

    await vscode.debug.startDebugging(this.workspace, debugConfiguration);
  }

  public cancel(): void {
    this.log.info("Closing all active Jest processes");
    this.jestManager.closeAllActiveProcesses();
  }

  public dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  private determineProjectsAndTestsToRun(
    tests: string[],
  ): Array<{ project: ProjectRootNode; testsToRun: string[]}> {
    if (_.some(tests, t => t === "root")) {
      // since at least one of the requested tests is "root" then we run all projects and all tests.  Note there should
      // only ever be one entry in the tests array.
      return this.tree.projects.map(project => ({ project, testsToRun: ["root"] }));
    } else {
      const testIds = tests.map(mapStringToId);

      return this.tree.projects
        .filter(p => _.some(testIds, t => t.projectId === p.id))
        .map(project => {
          const testsForProject = testIds.filter(t => t.projectId === project.id).map(mapIdToString);
          const testsToRun = testsForProject.length > 0 ? testsForProject : ["root"];
          return { project, testsToRun };
        });
    }
  }

  private async runTestsForProject(projects: ProjectRootNode, testsToRun: string[]): Promise<void> {
    const eventEmitter = (data: TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent) =>
      this.testStatesEmitter.fire(data);

    const pathToJest = this.options.pathToJest(this.workspace);

    const testFilter = mapTestIdsToTestFilter(testsToRun);

    // we emit events to notify which tests we are running.
    const filteredTree = filterTree(projects, testsToRun);
    emitTestRunningRootNode(filteredTree, eventEmitter);

    // begin running the tests in Jest.
    const projectWorkspace = initProjectWorkspace(projects.configPath, pathToJest, projects.rootPath);
    const jestResponse = await this.jestManager.runTests(testFilter, projectWorkspace);

    if (jestResponse) {
      // emit the completion events.
      const testEvents = mapJestTestResultsToTestEvents(jestResponse, filteredTree);
      emitTestCompleteRootNode(filteredTree, testEvents, eventEmitter);
    }
  }

  private handleProjectsChanged(event: ProjectsChangedEvent) {
    try {
      this.log.info("Loading Jest tests...");

      this.testsEmitter.fire({ type: "started" });

      this.tree = event.suite;
      const suite = mapWorkspaceRootToSuite(this.tree);

      switch (event.type) {
        case "projectAdded":
          this.retireTestFiles(event.addedProject.files.map(f => f.file));
          break;

        case "projectRemoved":
          // Assume that if we are removing a project, then we don't need to invalidate anything.
          break;
      }

      this.testsEmitter.fire({ suite, type: "finished" });
    } catch (error) {
      this.log.error("Error loading tests", JSON.stringify(error));
      this.testsEmitter.fire({ type: "finished", errorMessage: JSON.stringify(error) });
    }
  }

  /**
   * Invalidates all the tests for the given files.  This works because the file paths are used ids for the tests suites.
   * @param testFiles The files to invalidate the results for.
   */
  private retireTestFiles(testFiles: string[]) {
    this.retireEmitter.fire({
      tests: testFiles,
    });
  }

  /**
   * Marks all tests as retired.
   */
  private retireAllTests() {
    this.retireEmitter.fire({});
  }
}
