export interface ICreateRedisOptions {
  /**
   * Create a connection for `SUBSCRIBE`. Once subscribed, a connection can't run
   * any other command, so subscribers always get their own connection.
   *
   * Subscribers never give up on a pending command (`maxRetriesPerRequest: null`):
   * a subscription must survive a Redis restart, and ioredis re-subscribes after
   * reconnecting. Regular connections fail a command after 3 reconnect attempts
   * so a request handler errors out instead of hanging while Redis is down.
   */
  subscriber?: boolean;
}
