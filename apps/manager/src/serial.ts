// Keep Docker capacity changes and durable publication in their own ordered lanes.
export function serialLane() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}
