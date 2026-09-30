/**
 * Data carried by a build job.
 *
 * Only the id is sent: the worker loads everything else (repo, branch, build
 * settings) from the deployment row when the job starts, so a job never runs
 * with data that changed while it was waiting in the queue.
 */
export interface BuildJob {
  /** Database id of the deployment to build. The API also uses it as the job id. */
  deploymentId: string;
}
