export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= concurrency) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    next();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active -= 1;
            runNext();
          });
      };
      queue.push(run);
      runNext();
    });
  };
}
