import { create } from "zustand";
import { type ILogStore } from "./types";
import { EMPTY } from "@/lib/consts";

export const useLogStore = create<ILogStore>()((set) => ({
  logs: {},
  append: (deploymendId, entries) =>
    set((state) => {
      const log = state.logs[deploymendId] ?? EMPTY;
      const added: string[] = [];
      let lastId = log.lastId;
      for (const entry of entries) {
        if (entry?.id <= lastId) continue;
        lastId = entry.id;
        added.push(entry.line);
      }
      if (added?.length === 0) return state;
      return {
        logs: {
          ...state.logs,
          [deploymendId]: { lines: log.lines.concat(added), lastId },
        },
      };
    }),
  clear: (deploymentId) =>
    set((state) => {
      const logs = { ...state.logs };
      delete logs[deploymentId];
      return { logs };
    }),
}));
