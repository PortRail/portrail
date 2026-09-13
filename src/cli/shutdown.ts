/**
 * One orderly shutdown, however many times it is asked for. A second SIGINT while
 * the first is still closing must not start closing again; a close that hangs
 * must not keep the process alive forever.
 */
export function shutdownOnce(
  close: () => Promise<void>,
  exit: (code: number) => void,
  options: { hardExitMs?: number } = {},
): (code?: number) => void {
  let stopping = false;
  return (code = 0) => {
    if (stopping) return;
    stopping = true;
    const hard = setTimeout(() => exit(code), options.hardExitMs ?? 10_000);
    hard.unref();
    close()
      .then(
        () => exit(code),
        (error) => {
          console.error((error as Error).message ?? String(error));
          exit(code || 1);
        },
      )
      .finally(() => clearTimeout(hard));
  };
}
