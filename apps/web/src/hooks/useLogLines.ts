import { useLogStore } from "@/store/logStore";
import { NO_LINES } from "@/lib/consts";

export const useLogLines = (deploymentId: string) =>
  useLogStore((state) => state.logs[deploymentId]?.lines ?? NO_LINES);
