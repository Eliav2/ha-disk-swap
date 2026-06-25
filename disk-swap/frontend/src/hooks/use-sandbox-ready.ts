import { useEffect, useState } from "react";

import { fetchSandboxReady } from "@/lib/api";

/**
 * Polls `/api/sandbox/ready` while `active` is true and latches to `true` once
 * the sandbox proxy is serving — i.e. the inner HA Core HTTP is up and the
 * iframe can actually load. Used to gate UI that should only appear once the
 * Live Boot instance is reachable (the drawer iframe, the "Open" affordance on
 * the progress row), not during the earlier image-pull/boot phases.
 *
 * Same-origin probe, so it sidesteps the macOS↔UTM cross-origin bridge flakiness.
 */
export function useSandboxReady(active: boolean): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active || ready) return;
    let cancelled = false;
    const tick = async () => {
      const ok = await fetchSandboxReady();
      if (!cancelled && ok) setReady(true);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, ready]);

  return ready;
}
