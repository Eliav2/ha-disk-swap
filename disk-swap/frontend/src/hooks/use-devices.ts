import { useQuery } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { fetchDevices } from "@/lib/api";
import { appStore } from "@/store";

export function useDevices() {
  // Pause the 3s device poll while a job/sandbox is in flight. Hotplug refresh
  // only matters on the idle device picker; during a clone/sandbox run the
  // device set is fixed and polling just spams /api/devices forever (it never
  // stopped at sandbox_ready — the source of the "infinite requests" storm).
  const jobActive = useStore(appStore, (s) =>
    s.stages.some((st) => st.status === "in_progress"),
  );
  return useQuery({
    queryKey: ["devices"],
    queryFn: fetchDevices,
    refetchInterval: jobActive ? false : 3000,
    select: (data) => data.devices,
  });
}
