import path from "node:path";

/** True when `child` is `parent` itself or somewhere below it. Both must be absolute. */
export function isInside(parent: string, child: string) {
  return child === parent || child.startsWith(parent + path.sep);
}
