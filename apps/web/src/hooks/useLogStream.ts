import { api } from "@/api/client";
import { queryKeys } from "@/api/queries";
import { type DeploymentDetail, type DeploymentStatus } from "@/api/types";
import { useLogStore } from "@/store/logStore";
import type { ILogEntry } from "@/store/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

function useLogStream(deploymentId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!deploymentId) return;
    const { append, clear } = useLogStore.getState();
    const pending: ILogEntry[] = [];

    let frame = 0;
    const flush = () => {
      frame = 0;
      append(deploymentId, pending?.splice(0));
    };

    const events = new EventSource(api.logsUrl(deploymentId), {
      withCredentials: true,
    });

    // onMessage
    events.onmessage = (event) => {
      pending.push({
        id: Number(event.lastEventId),
        line: event.data,
      });
      frame ||= requestAnimationFrame(flush);
    };

    events.addEventListener("status", (event) => {
      const status = (event as MessageEvent)?.data as DeploymentStatus;
      queryClient.setQueryData<DeploymentDetail>(
        queryKeys.deployment(deploymentId),
        (prev) => prev && { ...prev, status },
      );
    });

    events.addEventListener("done", () => {
      events.close();
      cancelAnimationFrame(frame);
      flush();

      for (const queryKey of [
        queryKeys.deployment(deploymentId),
        ["deployments"],
        ["project"],
        ["projects"],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });

    events.onerror = () => {
      /* EventSource retries by itself */
    };

    return () => {
      events.close();
      cancelAnimationFrame(frame);
      clear(deploymentId);
    };
  }, [deploymentId, queryClient]);
}

export default useLogStream;
