/** Bounded UTF-8 text batches. State events remain independent of this queue. */
export class DeltaBatcher {
  private text = "";
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    private emit: (text: string) => void,
    private onError: (error: unknown) => void,
  ) {}
  append(text: string) {
    if (this.stopped || !text) return;
    const input = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < input.length) {
      let end = Math.min(input.length, offset + 8192 - this.bytes);
      // A batch must never split a multibyte character.
      if (end < input.length)
        while (end > offset && ((input[end] ?? 0) & 0xc0) === 0x80) end--;
      if (end === offset) {
        this.flush();
        continue;
      }
      this.text += input.subarray(offset, end).toString("utf8");
      this.bytes += end - offset;
      offset = end;
      if (this.bytes === 8192 || offset < input.length) this.flush();
    }
    if (this.bytes && !this.timer)
      this.timer = setTimeout(() => {
        try {
          this.flush();
        } catch (error) {
          this.dispose();
          this.onError(error);
        }
      }, 50);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.bytes) return;
    const text = this.text;
    this.text = "";
    this.bytes = 0;
    this.emit(text);
  }
  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stopped = true;
    this.text = "";
    this.bytes = 0;
  }
}
