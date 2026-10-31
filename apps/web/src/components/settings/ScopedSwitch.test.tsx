// @vitest-environment jsdom

import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  persistScopedSettingsPatch,
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  scopedSettingsAreMixed,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";
import { ScopedSwitch } from "./ScopedSwitch";

vi.mock("./useScopedSettings", () => ({
  useScopedSettingsMixed: () =>
    scopedSettingsAreMixed(resolveScopedSettingsTargets(scope, environments), [
      "autoResumeLimitedThreads",
    ]),
}));

function environment(id: string, initialChecked: boolean) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: "connected" as const },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, autoResumeLimitedThreads: initialChecked },
    },
  };
}

let environments: ReturnType<typeof environment>[];
let scope: ReturnType<typeof resolveSettingsScope>;
let root: Root;
let container: HTMLDivElement;
let save: Promise<Awaited<ReturnType<typeof persistScopedSettingsPatch>>>;

function renderSwitch() {
  root.render(
    <ScopedSwitch
      aria-label="Auto-resume limited threads"
      settingKeys={["autoResumeLimitedThreads"]}
      checked={environments[0]!.serverConfig.settings.autoResumeLimitedThreads}
      onCheckedChange={(checked) => {
        save = persistScopedSettingsPatch(
          planScopedSettingsPatch(scope, environments, { autoResumeLimitedThreads: checked }),
          async ({ environmentId, input }) => {
            const target = environments.find((entry) => entry.environmentId === environmentId)!;
            // An older server acknowledges the patch but drops the unknown setting.
            if (target.label !== "Old server") {
              target.serverConfig.settings = applyServerSettingsPatch(
                target.serverConfig.settings,
                input.patch,
              );
            }
            return { _tag: "Success", value: target.serverConfig.settings };
          },
          () => {},
        ).then((result) => {
          renderSwitch();
          return result;
        });
      }}
    />,
  );
}

function switchElement() {
  return container.querySelector<HTMLButtonElement>('[role="switch"]')!;
}

async function clickSwitch() {
  await act(async () => {
    switchElement().click();
    await save;
  });
  return save;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ScopedSwitch recovery", () => {
  it.each([
    { initialChecked: false, oldServerFirst: false },
    { initialChecked: false, oldServerFirst: true },
    { initialChecked: true, oldServerFirst: false },
    { initialChecked: true, oldServerFirst: true },
  ])(
    "reverses a partial save from $initialChecked with old server first: $oldServerFirst",
    async ({ initialChecked, oldServerFirst }) => {
      environments = ["Laptop", "Desktop", "Old server"].map((id) =>
        environment(id, initialChecked),
      );
      if (oldServerFirst) environments.reverse();
      scope = resolveSettingsScope({}, [], environments);
      await act(async () => renderSwitch());

      const partialSave = await clickSwitch();
      expect(partialSave.failedEnvironments.map(({ label }) => label)).toEqual(["Old server"]);
      expect(partialSave.savedEnvironmentCount).toBe(2);
      expect(switchElement().getAttribute("aria-checked")).toBe("mixed");

      const recovery = await clickSwitch();
      expect(
        environments.map((entry) => entry.serverConfig.settings.autoResumeLimitedThreads),
      ).toEqual([initialChecked, initialChecked, initialChecked]);
      expect(recovery.failedEnvironments).toEqual([]);
      expect(switchElement().getAttribute("aria-checked")).toBe(String(initialChecked));

      // Selecting only supported environments restores ordinary toggling.
      environments = environments.filter((entry) => entry.label !== "Old server");
      scope = resolveSettingsScope({}, [], environments);
      await act(async () => renderSwitch());
      await clickSwitch();
      expect(
        environments.map((entry) => entry.serverConfig.settings.autoResumeLimitedThreads),
      ).toEqual([!initialChecked, !initialChecked]);
      expect(switchElement().getAttribute("aria-checked")).toBe(String(!initialChecked));
      await clickSwitch();
      expect(
        environments.map((entry) => entry.serverConfig.settings.autoResumeLimitedThreads),
      ).toEqual([initialChecked, initialChecked]);
      expect(switchElement().getAttribute("aria-checked")).toBe(String(initialChecked));
    },
  );
});
