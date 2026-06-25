import type { Envelope } from "../envelope";
import type { MessageTransport, Unsubscribe } from "../transport";

export interface InProcTransportOptions {
  /**
   * Invoked when a subscriber handler throws. A throwing subscriber MUST NOT
   * block fan-out to its siblings (the broker fans out to many WS clients), so
   * each handler is isolated; this sink surfaces the error for logging.
   */
  onHandlerError?: (err: unknown, topic: string) => void;
}

/**
 * In-process pub/sub transport (spec §6.1 battery impl). Topic → handler set;
 * publish snapshots the set before fanning out so a handler that (un)subscribes
 * during delivery cannot corrupt the iteration, and isolates each handler so one
 * throwing subscriber cannot starve the others.
 */
export class InProcTransport implements MessageTransport {
  private readonly topics = new Map<string, Set<(m: Envelope) => void>>();

  constructor(private readonly options: InProcTransportOptions = {}) {}

  subscribe(topic: string, handler: (msg: Envelope) => void): Unsubscribe {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  publish(topic: string, msg: Envelope): Promise<void> {
    const set = this.topics.get(topic);
    if (set) {
      for (const handler of [...set]) {
        try {
          handler(msg);
        } catch (err) {
          // Isolate: a throwing subscriber must not block delivery to siblings.
          this.options.onHandlerError?.(err, topic);
        }
      }
    }
    return Promise.resolve();
  }
}
