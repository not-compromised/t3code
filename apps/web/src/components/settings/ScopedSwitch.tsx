import type { ServerSettings } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";

import { Switch } from "../ui/switch";
import { useScopedSettingsMixed } from "./useScopedSettings";

/**
 * A switch for a server setting that renders the mixed state when the
 * selected targets disagree on `settingKeys`. Remember the requested value
 * so a partial save can be reversed even while the targets remain mixed.
 */
export function ScopedSwitch({
  settingKeys,
  checked,
  onCheckedChange,
  ...props
}: ComponentProps<typeof Switch> & { settingKeys: readonly (keyof ServerSettings)[] }) {
  const mixed = useScopedSettingsMixed(settingKeys);
  const [requestedChecked, setRequestedChecked] = useState(checked ?? false);
  return (
    <Switch
      {...props}
      mixed={mixed}
      checked={mixed ? requestedChecked : checked}
      onCheckedChange={(nextChecked, details) => {
        setRequestedChecked(nextChecked);
        onCheckedChange?.(nextChecked, details);
      }}
    />
  );
}
