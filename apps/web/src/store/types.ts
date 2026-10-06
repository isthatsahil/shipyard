export interface ILogEntry {
  id: number;
  line: string;
}

export interface IDeploymentLog {
  lines: string[];
  /** Index of the last line stored; any line at or below it is a repeat. */
  lastId: number;
}

export interface ILogStore {
  logs: Record<string, IDeploymentLog>;
  /** Adds new lines to a deployment's log, dropping any already stored. */
  append: (deploymentId: string, entries: ILogEntry[]) => void;
  /** Forgets a deployment's log, e.g. when nobody is viewing it any more. */
  clear: (deploymentId: string) => void;
}
